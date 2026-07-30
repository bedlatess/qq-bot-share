import {
  toId,
  type FeatureName,
  type OneBotAction,
  type OneBotEvent,
} from "@puff/shared";
import type { Store } from "./db.js";
import type { AgentHub } from "./agent-hub.js";
import type { ProviderPool } from "./provider-pool.js";
import type { Moderator } from "./moderation.js";
import {
  botDefaultsFallback,
  type BotDefaults,
} from "./bot-defaults.js";

type Commands = {
  prefix: string;
  status: string;
  quota: string;
  activate: string;
  help: string;
  reset: string;
};
type HistoryMessage = { role: "user" | "assistant"; content: string };
type GroupActivity = {
  botId: string;
  groupId: string;
  createdAt: number;
  lastAt: number;
  lastSpoke: number;
  messages: Array<{ name: string; text: string; at: number }>;
  contextMessages: Array<{ name: string; text: string; at: number }>;
};

const commandFallback: Commands = {
  prefix: "/",
  status: "授权状态",
  quota: "剩余额度",
  activate: "激活",
  help: "帮助",
  reset: "清除记忆",
};

function extract(message: OneBotEvent["message"]) {
  if (!Array.isArray(message))
    return {
      text: String(message || "").trim(),
      images: [] as string[],
      ats: [] as string[],
    };
  const text = message
    .filter((item) => item.type === "text")
    .map((item) => String(item.data.text || ""))
    .join("")
    .trim();
  const images = message
    .filter((item) => item.type === "image")
    .map((item) => String(item.data.url || item.data.file || ""))
    .filter(Boolean);
  const ats = message
    .filter((item) => item.type === "at")
    .map((item) => String(item.data.qq || ""))
    .filter(Boolean);
  return { text, images, ats };
}

function replyAction(
  groupId: string,
  userId: string,
  text: string,
): OneBotAction {
  return {
    action: "send_group_msg",
    params: {
      group_id: Number(groupId),
      message: [
        { type: "at", data: { qq: userId } },
        { type: "text", data: { text: ` ${text}` } },
      ],
    },
  };
}

function groupAction(groupId: string, text: string): OneBotAction {
  return {
    action: "send_group_msg",
    params: { group_id: Number(groupId), message: text },
  };
}

export class EventPipeline {
  private readonly histories = new Map<string, HistoryMessage[]>();
  private readonly cooldowns = new Map<string, number>();
  private readonly seen = new Map<string, number>();
  private readonly groupQueues = new Map<string, Promise<void>>();
  private readonly activities = new Map<string, GroupActivity>();
  private readonly nicknameChecks = new Map<
    string,
    { name: string; at: number }
  >();
  private scheduler?: NodeJS.Timeout;
  private ticking = false;
  private lastIdleTick = 0;

  constructor(
    private readonly store: Store,
    private readonly hub: AgentHub,
    private readonly pool: ProviderPool,
    private readonly moderator: Moderator,
    private readonly onError: (error: unknown, context: string) => void = () =>
      undefined,
  ) {}

  start() {
    if (this.scheduler) return;
    this.scheduler = setInterval(() => void this.tick(), 2000);
    this.scheduler.unref();
  }

  stop() {
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = undefined;
  }

  enqueue(botId: string, eventId: string, event: OneBotEvent) {
    this.pruneCaches();
    if (this.seen.has(eventId)) return Promise.resolve();
    this.seen.set(eventId, Date.now());
    const key = `${botId}:${toId(event.group_id) || `private:${toId(event.user_id)}`}`;
    const previous = this.groupQueues.get(key) || Promise.resolve();
    const next = previous
      .then(() => this.process(botId, event))
      .catch((error) => {
        this.onError(error, key);
        this.store.audit("system:pipeline", "event.error", key, {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.groupQueues.get(key) === next) this.groupQueues.delete(key);
      });
    this.groupQueues.set(key, next);
    return next;
  }

  async tick(now = Date.now()) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.pruneCaches(now);
      const defaults = this.defaults();
      await this.tickRecentActivity(now, defaults);
      if (now - this.lastIdleTick >= 10000) {
        this.lastIdleTick = now;
        await this.tickIdleGroups(now, defaults);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickRecentActivity(now: number, defaults: BotDefaults) {
    if (!defaults.lurkEnabled) return;
    for (const activity of this.activities.values()) {
      if (activity.messages.length < Math.max(1, defaults.lurkMinMessages || 1))
        continue;
      const quietFor = now - activity.lastAt;
      const quietThreshold = Math.max(1, defaults.lurkQuietSeconds || 3) * 1000;
      if (quietFor < quietThreshold || quietFor > 5 * 60 * 1000) continue;
      const interval = Math.max(5, defaults.lurkIntervalSeconds || 10) * 1000;
      if (activity.lastSpoke > 0 && now - activity.lastSpoke < interval)
        continue;
      const license = this.store.getLicense(activity.botId, activity.groupId);
      if (!license?.active || !license.features.lurk) continue;
      const bot = this.store.db
        .prepare("SELECT * FROM bots WHERE id=? AND enabled=1")
        .get(activity.botId) as any;
      if (!bot) continue;

      const recent = activity.messages.slice(-12);
      activity.messages = [];
      activity.createdAt = now;
      activity.lastSpoke = now;
      try {
        this.store.assertQuotaAvailable(activity.botId, activity.groupId);
        const transcript = recent
          .map((item) => `${item.name}: ${item.text}`)
          .join("\n");
        const result = await this.pool.chat(
          [
            {
              role: "system",
              content: this.personaPrompt(
                bot,
                defaults,
                defaults.lurkPrompt,
              ),
            },
            { role: "user", content: `近期群聊：\n${transcript}` },
          ],
          "text",
          { botId: activity.botId, groupId: activity.groupId, kind: "lurk" },
        );
        this.store.consumeQuota(activity.botId, activity.groupId);
        const clean = this.cleanOutbound(
          result.text,
          activity.botId,
          activity.groupId,
        ).slice(0, 600);
        if (!clean || /^\[\[?SILENT\]?\]$/i.test(clean)) continue;
        this.hub.sendAction(
          activity.botId,
          groupAction(activity.groupId, clean),
        );
        this.cooldowns.set(`${activity.botId}:${activity.groupId}`, now);
      } catch (error) {
        this.onError(error, `lurk:${activity.botId}:${activity.groupId}`);
        this.store.audit(
          "system:pipeline",
          "lurk.error",
          `${activity.botId}:${activity.groupId}`,
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }

  private async tickIdleGroups(now: number, defaults: BotDefaults) {
    if (!defaults.idleEnabled || !this.isActiveHour(now, defaults)) return;
    const interval = defaults.idleAfterMinutes * 60 * 1000;
    for (const engagement of this.store.listGroupEngagements()) {
      if (engagement.dormant || engagement.idle_attempts >= defaults.idleMaxAttempts)
        continue;
      const license = this.store.getLicense(
        engagement.bot_id,
        engagement.group_id,
      );
      if (!license?.active || !license.features.lurk) continue;
      const baseline = engagement.idle_attempts
        ? Date.parse(engagement.last_idle_at || "")
        : Date.parse(engagement.last_human_at);
      if (!Number.isFinite(baseline) || now - baseline < interval) continue;

      const activity = this.activities.get(
        `${engagement.bot_id}:${engagement.group_id}`,
      );
      const transcript = activity?.contextMessages
        .slice(-12)
        .map((item) => `${item.name}: ${item.text}`)
        .join("\n");
      const attempt = engagement.idle_attempts + 1;
      const userPrompt = [
        `群聊已连续${defaults.idleAfterMinutes}分钟没有真人消息。这是第${attempt}次主动活跃，请直接生成一条可发送到群里的自然消息。`,
        transcript ? `近期群聊：\n${transcript}` : "当前没有可用的近期聊天内容。",
        engagement.last_idle_text
          ? `上一次主动消息：${engagement.last_idle_text}\n本次必须换一个话题。`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      try {
        this.store.assertQuotaAvailable(
          engagement.bot_id,
          engagement.group_id,
        );
        const result = await this.pool.chat(
          [
            {
              role: "system",
              content: this.personaPrompt(
                engagement,
                defaults,
                defaults.idlePrompt,
              ),
            },
            { role: "user", content: userPrompt },
          ],
          "text",
          {
            botId: engagement.bot_id,
            groupId: engagement.group_id,
            kind: "idle",
          },
        );
        this.store.consumeQuota(engagement.bot_id, engagement.group_id);
        const clean = this.cleanOutbound(
          result.text,
          engagement.bot_id,
          engagement.group_id,
        ).slice(0, 600);
        const latest = this.store.getGroupEngagement(
          engagement.bot_id,
          engagement.group_id,
        );
        if (
          !latest ||
          latest.dormant ||
          latest.last_human_at !== engagement.last_human_at
        )
          continue;
        this.hub.sendAction(
          engagement.bot_id,
          groupAction(engagement.group_id, clean),
        );
        this.store.markIdleSent(
          engagement.bot_id,
          engagement.group_id,
          engagement.last_human_at,
          clean,
          defaults.idleMaxAttempts,
          new Date(now),
        );
        this.markSpoke(engagement.bot_id, engagement.group_id, now);
      } catch (error) {
        this.onError(error, `idle:${engagement.bot_id}:${engagement.group_id}`);
        this.store.audit(
          "system:pipeline",
          "idle.error",
          `${engagement.bot_id}:${engagement.group_id}`,
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }

  private pruneCaches(now = Date.now()) {
    const seenCutoff = now - 10 * 60 * 1000;
    for (const [key, at] of this.seen)
      if (at < seenCutoff) this.seen.delete(key);
    const nicknameCutoff = now - 24 * 60 * 60 * 1000;
    for (const [key, value] of this.nicknameChecks)
      if (value.at < nicknameCutoff) this.nicknameChecks.delete(key);
    const activityCutoff = now - 24 * 60 * 60 * 1000;
    for (const [key, value] of this.activities)
      if (value.lastAt < activityCutoff) this.activities.delete(key);
  }

  private async process(botId: string, event: OneBotEvent) {
    if (event.post_type !== "message") return;
    const bot = this.store.db
      .prepare("SELECT * FROM bots WHERE id=? AND enabled=1")
      .get(botId) as any;
    if (!bot) return;
    const userId = toId(event.user_id);
    const groupId = toId(event.group_id);
    const { text, images, ats } = extract(event.message);
    const globalAdmins = this.store.getSetting<string[]>(
      "global_admin_qqs",
      [],
    );
    const isGlobalAdmin = globalAdmins.includes(userId);
    if (event.message_type === "private") {
      this.processPrivate(bot, userId, text, isGlobalAdmin);
      return;
    }
    if (event.message_type !== "group" || !groupId) return;

    const role = event.sender?.role || "member";
    const canManage = isGlobalAdmin || role === "owner" || role === "admin";
    const commands = this.commands();
    const command = text.startsWith(commands.prefix)
      ? text.slice(commands.prefix.length).trim()
      : text.trim();
    const currentLicense = this.store.getLicense(botId, groupId);
    if (currentLicense?.active && userId !== String(bot.qq))
      this.store.recordHumanActivity(botId, groupId);

    if (command === commands.status) {
      this.hub.sendAction(
        botId,
        replyAction(groupId, userId, this.licenseStatus(botId, groupId)),
      );
      return;
    }
    if (command === commands.quota) {
      this.hub.sendAction(
        botId,
        replyAction(groupId, userId, this.quotaStatus(botId, groupId)),
      );
      return;
    }
    if (command === commands.help) {
      const customCommands = this.store
        .listCustomCommands(botId, groupId)
        .map((item) => String(item.trigger_text).trim())
        .filter(Boolean);
      const customHelp = customCommands.length
        ? `\n\n自定义命令\n${customCommands
            .slice(0, 8)
            .map((trigger) => `- ${trigger}`)
            .join("\n")}${
            customCommands.length > 8
              ? `\n- 另有 ${customCommands.length - 8} 条`
              : ""
          }`
        : "";
      this.hub.sendAction(
        botId,
        replyAction(
          groupId,
          userId,
          `可用指令\n` +
            `${commands.prefix}${commands.status}  查看套餐与有效期\n` +
            `${commands.prefix}${commands.quota}  查看本月剩余额度\n` +
            `${commands.prefix}${commands.activate} 卡密  激活或续期本群\n` +
            `@机器人 ${commands.reset}  清除当前会话记忆` +
            customHelp,
        ),
      );
      return;
    }
    if (command.startsWith(`${commands.activate} `)) {
      if (!canManage) {
        this.hub.sendAction(
          botId,
          replyAction(groupId, userId, "仅群主、管理员或全局管理员可以激活。"),
        );
        return;
      }
      const code = command.slice(commands.activate.length).trim();
      try {
        const license = this.store.activateCode(code, botId, groupId) as any;
        this.store.recordHumanActivity(botId, groupId);
        this.store.audit(
          `qq:${userId}`,
          "license.activate",
          `${botId}:${groupId}`,
          { plan: license.plan_name },
        );
        this.hub.sendAction(
          botId,
          replyAction(
            groupId,
            userId,
            `激活成功：${license.plan_name}，${this.expiryText(license)}。`,
          ),
        );
      } catch (error) {
        this.hub.sendAction(
          botId,
          replyAction(
            groupId,
            userId,
            error instanceof Error ? error.message : "激活失败",
          ),
        );
      }
      return;
    }

    const license = currentLicense;
    if (!license?.active) return;

    if (license.features.moderation && role === "member" && !isGlobalAdmin) {
      const nickname = (
        event.sender?.card ||
        event.sender?.nickname ||
        ""
      ).trim();
      const nicknameReason = await this.checkNickname(
        botId,
        groupId,
        userId,
        nickname,
      );
      if (nicknameReason) {
        this.handleViolation(
          botId,
          groupId,
          userId,
          toId(event.message_id),
          nicknameReason,
          `[昵称] ${nickname}`,
        );
        return;
      }

      let reason = this.moderator.hardCheck(text);
      if (!reason && text) {
        try {
          reason = await this.moderator.reviewText(text, botId, groupId);
        } catch (error) {
          this.onError(error, "moderation:text");
        }
      }
      if (!reason && images[0]) {
        try {
          reason = await this.moderator.reviewImage(images[0], botId, groupId);
        } catch (error) {
          this.onError(error, "moderation:image");
        }
      }
      if (!reason && text && this.moderator.settings().contextReview) {
        const window = this.moderator.pushContext(
          botId,
          groupId,
          userId,
          text,
          toId(event.message_id),
        );
        const burst = window.filter((item) => Date.now() - item.at < 20000);
        if (burst.length >= 3) {
          try {
            reason = await this.moderator.reviewText(
              window.map((item) => item.text).join(" "),
              botId,
              groupId,
            );
          } catch (error) {
            this.onError(error, "moderation:context");
          }
          if (reason) {
            for (const item of window)
              this.hub.sendAction(botId, {
                action: "delete_msg",
                params: { message_id: Number(item.messageId) },
              });
            this.moderator.clearContext(botId, groupId, userId);
          }
        }
      }
      if (reason) {
        this.handleViolation(
          botId,
          groupId,
          userId,
          toId(event.message_id),
          reason,
          text || "[图片]",
        );
        return;
      }
    }

    const customCommand = this.store.matchCustomCommand(botId, groupId, text);
    if (customCommand) {
      if (this.inCooldown(`${botId}:${groupId}`)) return;
      const sender = event.sender?.card || event.sender?.nickname || userId;
      const response = String(customCommand.response_text)
        .replaceAll("{user}", () => sender)
        .replaceAll("{qq}", () => userId)
        .replaceAll("{group}", () => groupId)
        .replaceAll("{bot}", () =>
          String(bot.persona || this.defaults().persona),
        );
      const clean = this.cleanOutbound(response, botId, groupId).slice(0, 4000);
      this.hub.sendAction(botId, replyAction(groupId, userId, clean));
      this.markSpoke(botId, groupId);
      return;
    }

    if (text && !text.startsWith(commands.prefix)) {
      this.recordActivity(
        botId,
        groupId,
        event.sender?.card || event.sender?.nickname || userId,
        text,
      );
    }

    const mentioned = ats.includes(String(bot.qq));
    const technical = this.isTechnical(text);
    if (!mentioned && !(technical && license.features.tech)) return;
    if (this.inCooldown(`${botId}:${groupId}`)) return;
    const feature: FeatureName = images.length
      ? "vision"
      : technical
        ? "tech"
        : "chat";
    if (!license.features[feature]) return;

    if (
      command === commands.reset ||
      new RegExp(`^${commands.reset}$`, "i").test(text.trim())
    ) {
      this.histories.delete(`${botId}:${groupId}:${userId}`);
      this.hub.sendAction(
        botId,
        replyAction(groupId, userId, "本次会话记忆已清除。"),
      );
      return;
    }
    if (/^(画|生成|绘制|draw)\s*/i.test(text) && license.features.draw) {
      try {
        this.store.assertQuotaAvailable(botId, groupId);
        const image = await this.pool.image(
          text.replace(/^(画|生成|绘制|draw)\s*/i, ""),
          { botId, groupId },
        );
        this.store.consumeQuota(botId, groupId);
        const file = image.base64 ? `base64://${image.base64}` : image.url!;
        this.hub.sendAction(botId, {
          action: "send_group_msg",
          params: {
            group_id: Number(groupId),
            message: [
              { type: "at", data: { qq: userId } },
              { type: "image", data: { file } },
            ],
          },
        });
        this.markSpoke(botId, groupId);
      } catch (error) {
        this.hub.sendAction(
          botId,
          replyAction(
            groupId,
            userId,
            `生图失败：${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
      return;
    }

    try {
      this.store.assertQuotaAvailable(botId, groupId);
      const defaults = this.defaults();
      const systemPrompt = this.personaPrompt(
        bot,
        defaults,
        technical ? defaults.techPrompt : undefined,
      );
      const historyKey = `${botId}:${groupId}:${userId}`;
      const history = this.histories.get(historyKey) || [];
      const sender = event.sender?.card || event.sender?.nickname || userId;
      const content: unknown = images.length
        ? [
            { type: "text", text: `${sender}: ${text}` },
            ...images.map((url) => ({ type: "image_url", image_url: { url } })),
          ]
        : `${sender}: ${text}`;
      const result = await this.pool.chat(
        [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content },
        ],
        images.length ? "vision" : "text",
        { botId, groupId, kind: technical ? "tech" : "chat" },
      );
      this.store.consumeQuota(botId, groupId);
      const clean = this.cleanOutbound(result.text, botId, groupId).slice(
        0,
        4000,
      );
      history.push(
        { role: "user", content: text || "[图片]" },
        { role: "assistant", content: clean },
      );
      this.histories.set(
        historyKey,
        history.slice(-Math.max(2, defaults.maxHistory || 20)),
      );
      this.markSpoke(botId, groupId);
      this.hub.sendAction(botId, replyAction(groupId, userId, clean));
    } catch (error) {
      this.hub.sendAction(
        botId,
        replyAction(
          groupId,
          userId,
          `服务暂时不可用：${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  private processPrivate(
    bot: any,
    userId: string,
    text: string,
    isGlobalAdmin: boolean,
  ) {
    const commands = this.commands();
    const command = text.startsWith(commands.prefix)
      ? text.slice(commands.prefix.length).trim()
      : text.trim();
    let reply = `私聊目前提供授权与管理帮助。请在目标群发送 ${commands.prefix}${commands.activate} 卡密。`;
    if (command === commands.help)
      reply = `群内可用：${commands.prefix}${commands.status}、${commands.prefix}${commands.quota}、${commands.prefix}${commands.activate} 卡密。`;
    if (isGlobalAdmin) reply += " 你已识别为全局管理员，可跨群执行授权操作。";
    this.hub.sendAction(bot.id, {
      action: "send_private_msg",
      params: { user_id: Number(userId), message: reply },
    });
  }

  private async checkNickname(
    botId: string,
    groupId: string,
    userId: string,
    name: string,
  ) {
    if (!name || !this.moderator.settings().nicknameReview) return null;
    const key = `${botId}:${groupId}:${userId}`;
    const cached = this.nicknameChecks.get(key);
    if (cached?.name === name && Date.now() - cached.at < 24 * 60 * 60 * 1000)
      return null;
    this.nicknameChecks.set(key, { name, at: Date.now() });
    try {
      return await this.moderator.reviewNickname(name, botId, groupId);
    } catch (error) {
      this.onError(error, "moderation:nickname");
      return null;
    }
  }

  private handleViolation(
    botId: string,
    groupId: string,
    userId: string,
    messageId: string,
    reason: string,
    excerpt: string,
  ) {
    const settings = this.moderator.settings();
    if (settings.action !== "log" && messageId)
      this.hub.sendAction(botId, {
        action: "delete_msg",
        params: { message_id: Number(messageId) },
      });
    if (settings.action === "recall_ban")
      this.hub.sendAction(botId, {
        action: "set_group_ban",
        params: {
          group_id: Number(groupId),
          user_id: Number(userId),
          duration: settings.muteSeconds,
        },
      });
    this.moderator.record({
      botId,
      groupId,
      userId,
      messageId,
      action: settings.action,
      reason,
      excerpt,
    });
  }

  private recordActivity(
    botId: string,
    groupId: string,
    name: string,
    text: string,
  ) {
    const key = `${botId}:${groupId}`;
    const now = Date.now();
    const activity = this.activities.get(key) || {
      botId,
      groupId,
      createdAt: now,
      lastAt: now,
      lastSpoke: this.cooldowns.get(key) || 0,
      messages: [],
      contextMessages: [],
    };
    activity.lastAt = now;
    activity.messages.push({ name, text: text.slice(0, 500), at: now });
    activity.messages = activity.messages.slice(-20);
    activity.contextMessages.push({ name, text: text.slice(0, 500), at: now });
    activity.contextMessages = activity.contextMessages.slice(-20);
    this.activities.set(key, activity);
  }

  private cleanOutbound(text: string, botId: string, groupId: string) {
    const normalized = text.replace(/^['\"“”]+|['\"“”]+$/g, "").trim();
    const result = this.moderator.filterOutbound(normalized);
    if (result.filtered)
      this.store.audit(
        "system:outbound-filter",
        "reply.filtered",
        `${botId}:${groupId}`,
      );
    return result.text;
  }

  private markSpoke(botId: string, groupId: string, at = Date.now()) {
    const key = `${botId}:${groupId}`;
    this.cooldowns.set(key, at);
    const activity = this.activities.get(key);
    if (activity) activity.lastSpoke = at;
  }

  private personaPrompt(
    bot: { persona?: unknown; system_prompt?: unknown },
    defaults: BotDefaults,
    modePrompt?: string,
  ) {
    const persona = String(bot.persona || defaults.persona || "泡芙").trim();
    const base = String(
      bot.system_prompt ||
        defaults.systemPrompt ||
        botDefaultsFallback.systemPrompt,
    ).trim();
    return [
      `你叫“${persona}”。这是内部身份约束，不要向群友复述这句话或介绍人格设定；除非被问到名字，否则不必反复自称。`,
      base,
      modePrompt?.trim(),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private isActiveHour(now: number, defaults: BotDefaults) {
    let hour: number;
    try {
      const part = new Intl.DateTimeFormat("en-US", {
        timeZone: defaults.activeTimezone,
        hour: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(now))
        .find((item) => item.type === "hour");
      hour = Number(part?.value);
      if (!Number.isFinite(hour)) return false;
    } catch {
      return false;
    }
    const start = defaults.activeStartHour;
    const end = defaults.activeEndHour;
    if (start === 0 && end === 24) return true;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  private licenseStatus(botId: string, groupId: string) {
    const license = this.store.getLicense(botId, groupId);
    if (!license)
      return `本群尚未授权\n管理员可发送：${this.commands().prefix}${this.commands().activate} 卡密`;
    const remaining =
      license.monthly_quota <= 0
        ? "不限"
        : Math.max(0, license.monthly_quota - license.usage_count);
    return (
      `授权信息\n` +
      `状态：${license.active ? "正常" : "已到期"}\n` +
      `套餐：${String(license.plan_name)}\n` +
      `有效期：${this.expiryText(license)}\n` +
      `本月额度：${remaining === "不限" ? "不限次数" : `剩余 ${remaining} 次`}`
    );
  }

  private quotaStatus(botId: string, groupId: string) {
    const license = this.store.getLicense(botId, groupId);
    if (!license)
      return `本群尚未授权\n管理员可发送：${this.commands().prefix}${this.commands().activate} 卡密`;
    if (!license.active) return `授权已到期\n有效期：${this.expiryText(license)}`;
    if (license.monthly_quota <= 0) return "本月额度：不限次数";
    const used = Math.max(0, Number(license.usage_count));
    const total = Math.max(0, Number(license.monthly_quota));
    return `本月额度\n剩余：${Math.max(0, total - used)} 次\n已用：${used} 次\n总计：${total} 次`;
  }

  private expiryText(license: Record<string, unknown>) {
    return license.permanent
      ? "永久"
      : String(license.expires_at).slice(0, 10);
  }

  private inCooldown(key: string) {
    const defaults = this.defaults();
    return (
      Date.now() - (this.cooldowns.get(key) || 0) <
      (defaults.cooldownMs || 10000)
    );
  }

  private defaults() {
    const value = {
      ...botDefaultsFallback,
      ...this.store.getSetting<Partial<BotDefaults>>("bot_defaults", {}),
    };
    const integer = (input: unknown, fallback: number, min: number, max: number) => {
      const number = Number(input);
      return Number.isFinite(number)
        ? Math.min(max, Math.max(min, Math.trunc(number)))
        : fallback;
    };
    let activeTimezone =
      typeof value.activeTimezone === "string" && value.activeTimezone.trim()
        ? value.activeTimezone.trim()
        : "Asia/Shanghai";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: activeTimezone }).format();
    } catch {
      activeTimezone = "Asia/Shanghai";
    }
    return {
      ...value,
      lurkEnabled: value.lurkEnabled !== false,
      lurkMinMessages: integer(value.lurkMinMessages, 1, 1, 20),
      lurkQuietSeconds: integer(value.lurkQuietSeconds, 3, 1, 60),
      lurkIntervalSeconds: integer(value.lurkIntervalSeconds, 10, 5, 3600),
      idleEnabled: value.idleEnabled !== false,
      idleAfterMinutes: integer(value.idleAfterMinutes, 30, 1, 1440),
      idleMaxAttempts: integer(value.idleMaxAttempts, 2, 1, 5),
      activeStartHour: integer(value.activeStartHour, 8, 0, 23),
      activeEndHour: integer(value.activeEndHour, 24, 1, 24),
      activeTimezone,
    };
  }

  private commands() {
    return {
      ...commandFallback,
      ...this.store.getSetting<Partial<Commands>>("commands", {}),
    };
  }

  private isTechnical(text: string) {
    return (
      text.length >= 8 &&
      /(报错|错误|error|异常|失败|不生效|超时|401|403|404|429|500|怎么|如何|为什么|接口|api|key|模型|参数|部署|配置|代码|bug|sdk|python|node|java|docker|nginx)/i.test(
        text,
      )
    );
  }
}
