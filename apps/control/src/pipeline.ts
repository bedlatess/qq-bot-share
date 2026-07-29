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

type Commands = {
  prefix: string;
  status: string;
  quota: string;
  activate: string;
  help: string;
  reset: string;
};
type BotDefaults = {
  persona: string;
  systemPrompt: string;
  techPrompt: string;
  lurkPrompt: string;
  idlePrompt: string;
  cooldownMs: number;
  maxHistory: number;
  lurkMinMessages: number;
  lurkIntervalSeconds: number;
  idleEnabled: boolean;
  idleAfterMinutes: number;
  idleMaxAttempts: number;
  activeStartHour: number;
  activeEndHour: number;
  activeTimezone: string;
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

const defaultsFallback: BotDefaults = {
  persona: "泡芙",
  systemPrompt:
    "你是一个知识面广、知无不言的QQ群聊搭子。优先直接解决问题，语气自然、机灵、略带俏皮。",
  techPrompt:
    "遇到技术问题时，先判断最可能的原因，再给按顺序可执行的解决步骤。",
  lurkPrompt:
    "根据近期群聊自然接一句，通常20到60字，不要打断正在解决的问题。",
  idlePrompt:
    "群聊冷场时自然发起一个轻量、容易回答的话题，通常20到80字，不催促群友，不@全体成员。",
  cooldownMs: 10000,
  maxHistory: 20,
  lurkMinMessages: 3,
  lurkIntervalSeconds: 90,
  idleEnabled: true,
  idleAfterMinutes: 30,
  idleMaxAttempts: 2,
  activeStartHour: 8,
  activeEndHour: 24,
  activeTimezone: "Asia/Shanghai",
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
    this.scheduler = setInterval(() => void this.tick(), 10000);
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
      await this.tickIdleGroups(now, defaults);
    } finally {
      this.ticking = false;
    }
  }

  private async tickRecentActivity(now: number, defaults: BotDefaults) {
    for (const activity of this.activities.values()) {
      if (activity.messages.length < Math.max(2, defaults.lurkMinMessages || 3))
        continue;
      const quietFor = now - activity.lastAt;
      if (quietFor < 12000 || quietFor > 5 * 60 * 1000) continue;
      const interval = Math.max(30, defaults.lurkIntervalSeconds || 90) * 1000;
      if (now - Math.max(activity.lastSpoke, activity.createdAt) < interval)
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
        this.store.consumeQuota(activity.botId, activity.groupId);
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
        const clean = this.cleanOutbound(
          result.text,
          activity.botId,
          activity.groupId,
        ).slice(0, 600);
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
        this.store.consumeQuota(engagement.bot_id, engagement.group_id);
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

    if (command === commands.status || command === commands.quota) {
      this.hub.sendAction(
        botId,
        replyAction(groupId, userId, this.licenseStatus(botId, groupId)),
      );
      return;
    }
    if (command === commands.help) {
      this.hub.sendAction(
        botId,
        replyAction(
          groupId,
          userId,
          `${commands.prefix}${commands.status} | ${commands.prefix}${commands.quota} | ${commands.prefix}${commands.activate} 卡密 | @机器人 ${commands.reset}`,
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
        this.store.consumeQuota(botId, groupId);
        const image = await this.pool.image(
          text.replace(/^(画|生成|绘制|draw)\s*/i, ""),
          { botId, groupId },
        );
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
      this.store.consumeQuota(botId, groupId);
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
      bot.system_prompt || defaults.systemPrompt || defaultsFallback.systemPrompt,
    ).trim();
    return [
      `你的人格名称是“${persona}”。在所有话题和工作模式中保持这个身份与表达风格。`,
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
    if (!license) return "本群尚未授权，可使用激活指令绑定卡密。";
    const remaining =
      license.monthly_quota <= 0
        ? "不限"
        : Math.max(0, license.monthly_quota - license.usage_count);
    return `${String(license.plan_name)} | ${license.active ? "有效" : "已到期"} | ${this.expiryText(license)} | 本月剩余 ${remaining} 次`;
  }

  private expiryText(license: Record<string, unknown>) {
    return license.permanent
      ? "永久授权"
      : `到期 ${String(license.expires_at).slice(0, 10)}`;
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
      ...defaultsFallback,
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
