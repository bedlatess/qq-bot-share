import { nowIso } from "@puff/shared";
import type { Store } from "./db.js";
import type { ProviderPool } from "./provider-pool.js";

export type ModerationSettings = {
  mode: "balanced";
  action: "log" | "recall" | "recall_ban";
  muteSeconds: number;
  hardKeywords: string[];
  hardPatterns: string[];
  aiReview: boolean;
  imageReview: boolean;
  contextReview: boolean;
  nicknameReview: boolean;
};

export type OutboundFilterSettings = {
  enabled: boolean;
  replacement: string;
  keywords: string[];
  patterns: string[];
};

type WindowMessage = { text: string; messageId: string; at: number };

export class Moderator {
  private readonly windows = new Map<string, WindowMessage[]>();

  constructor(
    private readonly store: Store,
    private readonly pool: ProviderPool,
  ) {}

  settings(): ModerationSettings {
    return this.store.getSetting<ModerationSettings>("moderation", {
      mode: "balanced",
      action: "recall",
      muteSeconds: 600,
      hardKeywords: [],
      hardPatterns: [],
      aiReview: true,
      imageReview: true,
      contextReview: true,
      nicknameReview: true,
    });
  }

  hardCheck(text: string): string | null {
    const settings = this.settings();
    const lower = text.toLowerCase();
    for (const keyword of settings.hardKeywords) {
      if (lower.includes(keyword.toLowerCase()))
        return `命中高风险词「${keyword}」`;
    }
    for (const source of settings.hardPatterns) {
      try {
        const match = text.match(new RegExp(source, "i"));
        if (match) return `命中高风险特征「${match[0].slice(0, 24)}」`;
      } catch {
        // Invalid administrator patterns are ignored and remain editable in the panel.
      }
    }
    return null;
  }

  async reviewText(
    text: string,
    botId: string,
    groupId: string,
  ): Promise<string | null> {
    const hard = this.hardCheck(text);
    if (hard) return hard;
    if (!this.settings().aiReview || text.trim().length < 8) return null;
    const result = await this.pool.chat(
      [
        {
          role: "system",
          content:
            '你是群聊审核器。只判断广告引流、赌博、诈骗或色情推广。普通网址、技术讨论、吐槽和正常聊天放行。只输出JSON：{"violation":false,"reason":""}',
        },
        { role: "user", content: text },
      ],
      "text",
      { botId, groupId, kind: "moderation" },
    );
    try {
      const json = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || "{}");
      return json.violation === true
        ? String(json.reason || "AI判定违规")
        : null;
    } catch {
      return null;
    }
  }

  async reviewImage(
    url: string,
    botId: string,
    groupId: string,
  ): Promise<string | null> {
    if (!this.settings().imageReview) return null;
    const result = await this.pool.chat(
      [
        {
          role: "system",
          content:
            '判断图片是否为广告引流、二维码推广、赌博、诈骗或色情推广。普通截图、表情包、生活照和技术截图放行。只输出JSON：{"violation":false,"reason":""}',
        },
        {
          role: "user",
          content: [
            { type: "text", text: "审核这张图片" },
            { type: "image_url", image_url: { url } },
          ],
        },
      ],
      "vision",
      { botId, groupId, kind: "image_moderation" },
    );
    try {
      const json = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || "{}");
      return json.violation === true
        ? String(json.reason || "AI判定图片违规")
        : null;
    } catch {
      return null;
    }
  }

  async reviewNickname(
    name: string,
    botId: string,
    groupId: string,
  ): Promise<string | null> {
    const hard = this.hardCheck(name);
    if (hard) return `昵称${hard}`;
    if (
      !this.settings().nicknameReview ||
      !this.settings().aiReview ||
      name.trim().length < 3
    )
      return null;
    const result = await this.pool.chat(
      [
        {
          role: "system",
          content:
            '你是QQ群昵称审核器。只判断昵称是否包含广告引流、联系方式、赌博、诈骗或色情推广。普通网名、玩笑和技术词汇放行。只输出JSON：{"violation":false,"reason":""}',
        },
        { role: "user", content: name },
      ],
      "text",
      { botId, groupId, kind: "nickname_moderation" },
    );
    try {
      const json = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || "{}");
      return json.violation === true
        ? String(json.reason || "AI判定昵称违规")
        : null;
    } catch {
      return null;
    }
  }

  filterOutbound(text: string): { text: string; filtered: boolean } {
    const settings = this.store.getSetting<OutboundFilterSettings>(
      "outbound_filter",
      {
        enabled: true,
        replacement: "[内容已过滤]",
        keywords: [],
        patterns: [],
      },
    );
    if (!settings.enabled) return { text, filtered: false };
    let output = text;
    let filtered = false;
    const replacement = settings.replacement || "[内容已过滤]";
    for (const keyword of settings.keywords || []) {
      if (!keyword) continue;
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const next = output.replace(new RegExp(escaped, "gi"), replacement);
      filtered ||= next !== output;
      output = next;
    }
    for (const source of settings.patterns || []) {
      try {
        const next = output.replace(new RegExp(source, "gi"), replacement);
        filtered ||= next !== output;
        output = next;
      } catch {
        // Invalid administrator patterns stay editable and do not break replies.
      }
    }
    return { text: output.trim() || replacement, filtered };
  }

  pushContext(
    botId: string,
    groupId: string,
    userId: string,
    text: string,
    messageId: string,
  ) {
    const key = `${botId}:${groupId}:${userId}`;
    const cutoff = Date.now() - 60000;
    const current = (this.windows.get(key) || []).filter(
      (item) => item.at >= cutoff,
    );
    current.push({ text, messageId, at: Date.now() });
    this.windows.set(key, current.slice(-12));
    return current;
  }

  clearContext(botId: string, groupId: string, userId: string) {
    this.windows.delete(`${botId}:${groupId}:${userId}`);
  }

  record(input: {
    botId: string;
    groupId: string;
    userId: string;
    messageId?: string;
    action: string;
    reason: string;
    excerpt: string;
  }) {
    this.store.db
      .prepare(
        `INSERT INTO moderation_events
      (bot_id,group_id,user_id,message_id,action,reason,excerpt,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.botId,
        input.groupId,
        input.userId,
        input.messageId || null,
        input.action,
        input.reason,
        input.excerpt.slice(0, 500),
        nowIso(),
      );
  }
}
