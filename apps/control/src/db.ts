import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultFeatures, nowIso, type FeatureFlags } from "@puff/shared";
import {
  createActivationCode,
  hashPassword,
  randomId,
  sha256,
} from "./security.js";
import {
  botDefaultsFallback,
  legacyBotDefaultValues,
} from "./bot-defaults.js";

export type Db = Database.Database;

export type GroupEngagement = {
  bot_id: string;
  group_id: string;
  last_human_at: string;
  last_idle_at: string | null;
  last_idle_text: string;
  idle_attempts: number;
  dormant: number;
  updated_at: string;
  persona: string;
  system_prompt: string;
};

export class Store {
  readonly db: Db;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        hostname TEXT,
        status TEXT NOT NULL DEFAULT 'offline',
        version TEXT,
        last_seen_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
        qq TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        persona TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        settings_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bots_node ON bots(node_id);
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        duration_days INTEGER,
        monthly_quota INTEGER NOT NULL DEFAULT 1000,
        features_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_licenses (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
        starts_at TEXT NOT NULL,
        expires_at TEXT,
        permanent INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        usage_period TEXT NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(bot_id, group_id)
      );
      CREATE INDEX IF NOT EXISTS idx_licenses_group ON group_licenses(group_id);
      CREATE TABLE IF NOT EXISTS group_engagement (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        last_human_at TEXT NOT NULL,
        last_idle_at TEXT,
        last_idle_text TEXT NOT NULL DEFAULT '',
        idle_attempts INTEGER NOT NULL DEFAULT 0,
        dormant INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, group_id)
      );
      CREATE INDEX IF NOT EXISTS idx_engagement_human ON group_engagement(last_human_at);
      CREATE TABLE IF NOT EXISTS activation_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        code_prefix TEXT NOT NULL,
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
        duration_days INTEGER,
        status TEXT NOT NULL DEFAULT 'unused',
        bound_bot_id TEXT REFERENCES bots(id),
        bound_group_id TEXT,
        created_at TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cards_status ON activation_codes(status);
      CREATE TABLE IF NOT EXISTS ai_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key_enc TEXT NOT NULL,
        model TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        timeout_ms INTEGER NOT NULL DEFAULT 30000,
        enabled INTEGER NOT NULL DEFAULT 1,
        capabilities_json TEXT NOT NULL DEFAULT '{"text":true,"vision":false,"image":false}',
        health_status TEXT NOT NULL DEFAULT 'unknown',
        failure_count INTEGER NOT NULL DEFAULT 0,
        cooldown_until TEXT,
        latency_ms INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provider_order ON ai_providers(enabled, priority);
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        group_id TEXT,
        provider_id TEXT,
        kind TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);
      CREATE TABLE IF NOT EXISTS usage_totals (
        id INTEGER PRIMARY KEY CHECK(id=1),
        call_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS moderation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message_id TEXT,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_moderation_created ON moderation_events(created_at);
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS custom_commands (
        id TEXT PRIMARY KEY,
        bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,
        group_id TEXT,
        trigger_text TEXT NOT NULL,
        response_text TEXT NOT NULL,
        match_mode TEXT NOT NULL DEFAULT 'exact' CHECK(match_mode IN ('exact','prefix','contains')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_custom_commands_scope
        ON custom_commands(enabled,bot_id,group_id,updated_at);
    `);
    const usageColumns = this.db
      .prepare("PRAGMA table_info(usage_events)")
      .all() as Array<{ name: string }>;
    if (!usageColumns.some((column) => column.name === "latency_ms"))
      this.db.exec(
        "ALTER TABLE usage_events ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0",
      );
    this.db
      .prepare(
        `INSERT OR IGNORE INTO usage_totals
         (id,call_count,input_tokens,output_tokens,updated_at)
         SELECT 1,COUNT(*),COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),?
         FROM usage_events`,
      )
      .run(nowIso());
  }

  async bootstrap(email: string, password: string) {
    if (!this.db.prepare("SELECT id FROM admins LIMIT 1").get()) {
      const { salt, hash } = await hashPassword(password);
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO admins (id,email,password_hash,password_salt,created_at,updated_at)
        VALUES (?,?,?,?,?,?)`,
        )
        .run(randomId("adm_"), email, hash, salt, now, now);
    }
    if (!this.db.prepare("SELECT id FROM plans LIMIT 1").get()) {
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO plans
        (id,name,duration_days,monthly_quota,features_json,enabled,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomId("plan_"),
          "默认专业版",
          30,
          3000,
          JSON.stringify(defaultFeatures),
          1,
          now,
          now,
        );
    }
    this.setDefault("global_admin_qqs", []);
    this.setDefault("commands", {
      prefix: "/",
      status: "授权状态",
      quota: "剩余额度",
      activate: "激活",
      help: "帮助",
      reset: "清除记忆",
    });
    this.setDefault("moderation", {
      mode: "balanced",
      action: "recall",
      muteSeconds: 600,
      hardKeywords: [
        "博彩",
        "约炮",
        "刷单返利",
        "代开发票",
        "出售四件套",
        "跑分",
      ],
      hardPatterns: [
        "(微信|weixin|vx|加v)[^，。,.!?]{0,6}[a-zA-Z0-9_-]{5,}",
        "(加|扫|联系).{0,4}(微信|QQ|企鹅|电报|telegram)",
        "sk-[a-zA-Z0-9]{12,}",
      ],
      aiReview: true,
      imageReview: true,
      contextReview: true,
      nicknameReview: true,
    });
    this.setDefault("outbound_filter", {
      enabled: true,
      replacement: "[内容已过滤]",
      keywords: ["系统提示词", "system prompt"],
      patterns: [
        "sk-[a-zA-Z0-9_-]{12,}",
        "(api[_ -]?key|authorization)\\s*[:=]\\s*[^\\s,;]{8,}",
      ],
    });
    const botDefaults = { ...botDefaultsFallback };
    const existingDefaults = this.getSetting<Record<string, unknown> | null>(
      "bot_defaults",
      null,
    );
    if (!existingDefaults) {
      this.setDefault("bot_defaults", botDefaults);
    } else {
      const upgraded: Record<string, unknown> = {
        ...botDefaults,
        ...existingDefaults,
      };
      const botDefaultValues: Record<string, unknown> = botDefaults;
      for (const [key, legacyValues] of Object.entries(
        legacyBotDefaultValues,
      )) {
        if (legacyValues?.includes(String(existingDefaults[key] || "")))
          upgraded[key] = botDefaultValues[key];
      }
      if (JSON.stringify(existingDefaults) !== JSON.stringify(upgraded))
        this.setSetting("bot_defaults", upgraded);
    }
    for (const legacy of legacyBotDefaultValues.systemPrompt || []) {
      this.db
        .prepare("UPDATE bots SET system_prompt='' WHERE system_prompt=?")
        .run(legacy);
    }
  }

  private setDefault(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO settings (key,value_json,updated_at) VALUES (?,?,?)",
      )
      .run(key, JSON.stringify(value), nowIso());
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value_json FROM settings WHERE key=?")
      .get(key) as { value_json: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        `INSERT INTO settings (key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), nowIso());
  }

  listSettings() {
    const rows = this.db
      .prepare("SELECT key,value_json FROM settings ORDER BY key")
      .all() as Array<{ key: string; value_json: string }>;
    return Object.fromEntries(
      rows.map((row) => [row.key, JSON.parse(row.value_json)]),
    );
  }

  createActivationCodes(
    planId: string,
    count: number,
    durationDays?: number | null,
  ) {
    const created: string[] = [];
    const statement = this.db.prepare(`INSERT INTO activation_codes
      (id,code_hash,code_prefix,plan_id,duration_days,status,created_at) VALUES (?,?,?,?,?,'unused',?)`);
    this.db.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const code = createActivationCode();
        statement.run(
          randomId("card_"),
          sha256(code),
          code.slice(0, 10),
          planId,
          durationDays ?? null,
          nowIso(),
        );
        created.push(code);
      }
    })();
    return created;
  }

  activateCode(code: string, botId: string, groupId: string) {
    return this.db.transaction(() => {
      const card = this.db
        .prepare(
          `SELECT c.*,p.duration_days AS plan_duration FROM activation_codes c
        JOIN plans p ON p.id=c.plan_id WHERE c.code_hash=?`,
        )
        .get(sha256(code)) as Record<string, unknown> | undefined;
      if (!card || card.status !== "unused")
        throw new Error("卡密无效、已使用或已撤销");
      const duration = Number(card.duration_days ?? card.plan_duration ?? 0);
      const now = new Date();
      const expires =
        duration > 0
          ? new Date(now.getTime() + duration * 86400000).toISOString()
          : null;
      const permanent = duration <= 0 ? 1 : 0;
      const existing = this.db
        .prepare(
          "SELECT id,expires_at FROM group_licenses WHERE bot_id=? AND group_id=?",
        )
        .get(botId, groupId) as
        { id: string; expires_at: string | null } | undefined;
      if (existing) {
        let nextExpiry = expires;
        if (
          !permanent &&
          existing.expires_at &&
          new Date(existing.expires_at) > now
        ) {
          nextExpiry = new Date(
            new Date(existing.expires_at).getTime() + duration * 86400000,
          ).toISOString();
        }
        this.db
          .prepare(
            `UPDATE group_licenses SET plan_id=?,starts_at=?,expires_at=?,permanent=?,status='active',updated_at=? WHERE id=?`,
          )
          .run(
            card.plan_id,
            now.toISOString(),
            nextExpiry,
            permanent,
            now.toISOString(),
            existing.id,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO group_licenses
          (id,bot_id,group_id,plan_id,starts_at,expires_at,permanent,status,usage_period,usage_count,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'active',?,0,?,?)`,
          )
          .run(
            randomId("lic_"),
            botId,
            groupId,
            card.plan_id,
            now.toISOString(),
            expires,
            permanent,
            now.toISOString().slice(0, 7),
            now.toISOString(),
            now.toISOString(),
          );
      }
      this.db
        .prepare(
          `UPDATE activation_codes SET status='used',bound_bot_id=?,bound_group_id=?,used_at=? WHERE id=?`,
        )
        .run(botId, groupId, now.toISOString(), card.id);
      return this.getLicense(botId, groupId);
    })();
  }

  getLicense(
    botId: string,
    groupId: string,
  ):
    | (Record<string, unknown> & {
        id: string;
        monthly_quota: number;
        usage_count: number;
        active: boolean;
        expired: boolean;
        features: FeatureFlags;
      })
    | null {
    const row = this.db
      .prepare(
        `SELECT l.*,p.name AS plan_name,p.monthly_quota,p.features_json
      FROM group_licenses l JOIN plans p ON p.id=l.plan_id WHERE l.bot_id=? AND l.group_id=?`,
      )
      .get(botId, groupId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const month = nowIso().slice(0, 7);
    if (row.usage_period !== month) {
      this.db
        .prepare(
          "UPDATE group_licenses SET usage_period=?,usage_count=0,updated_at=? WHERE id=?",
        )
        .run(month, nowIso(), row.id);
      row.usage_period = month;
      row.usage_count = 0;
    }
    const expired =
      !row.permanent &&
      row.expires_at != null &&
      new Date(String(row.expires_at)) <= new Date();
    return {
      ...row,
      id: String(row.id),
      monthly_quota: Number(row.monthly_quota),
      usage_count: Number(row.usage_count),
      active: row.status === "active" && !expired,
      expired,
      features: JSON.parse(String(row.features_json)) as FeatureFlags,
    };
  }

  assertQuotaAvailable(botId: string, groupId: string) {
    const license = this.getLicense(botId, groupId);
    if (!license?.active) throw new Error("群授权未生效");
    if (
      Number(license.monthly_quota) > 0 &&
      Number(license.usage_count) >= Number(license.monthly_quota)
    ) {
      throw new Error("本月调用额度已用完");
    }
    return license;
  }

  consumeQuota(botId: string, groupId: string) {
    const license = this.assertQuotaAvailable(botId, groupId);
    this.db
      .prepare(
        "UPDATE group_licenses SET usage_count=usage_count+1,updated_at=? WHERE id=?",
      )
      .run(nowIso(), license.id);
    return Number(license.usage_count) + 1;
  }

  recordUsage(event: {
    botId: string;
    groupId?: string;
    providerId: string;
    kind: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
  }) {
    const inputTokens = Math.max(0, Number(event.inputTokens || 0));
    const outputTokens = Math.max(0, Number(event.outputTokens || 0));
    const latencyMs = Math.max(0, Number(event.latencyMs || 0));
    const createdAt = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO usage_events
           (bot_id,group_id,provider_id,kind,input_tokens,output_tokens,latency_ms,created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          event.botId,
          event.groupId || null,
          event.providerId,
          event.kind,
          inputTokens,
          outputTokens,
          latencyMs,
          createdAt,
        );
      this.db
        .prepare(
          `UPDATE usage_totals SET call_count=call_count+1,
           input_tokens=input_tokens+?,output_tokens=output_tokens+?,updated_at=? WHERE id=1`,
        )
        .run(inputTokens, outputTokens, createdAt);
    })();
  }

  recordHumanActivity(botId: string, groupId: string, at = new Date()) {
    const stamp = at.toISOString();
    this.db
      .prepare(
        `INSERT INTO group_engagement
        (bot_id,group_id,last_human_at,last_idle_at,last_idle_text,idle_attempts,dormant,updated_at)
        VALUES (?,?,?,NULL,'',0,0,?)
        ON CONFLICT(bot_id,group_id) DO UPDATE SET
          last_human_at=excluded.last_human_at,
          last_idle_at=NULL,
          last_idle_text='',
          idle_attempts=0,
          dormant=0,
          updated_at=excluded.updated_at`,
      )
      .run(botId, groupId, stamp, stamp);
  }

  listGroupEngagements() {
    return this.db
      .prepare(
        `SELECT e.*,b.persona,b.system_prompt
        FROM group_engagement e
        JOIN bots b ON b.id=e.bot_id
        WHERE b.enabled=1
        ORDER BY e.last_human_at ASC`,
      )
      .all() as GroupEngagement[];
  }

  getGroupEngagement(botId: string, groupId: string) {
    return this.db
      .prepare(
        `SELECT e.*,b.persona,b.system_prompt
        FROM group_engagement e
        JOIN bots b ON b.id=e.bot_id
        WHERE e.bot_id=? AND e.group_id=?`,
      )
      .get(botId, groupId) as GroupEngagement | undefined;
  }

  markIdleSent(
    botId: string,
    groupId: string,
    expectedLastHumanAt: string,
    text: string,
    maxAttempts: number,
    at = new Date(),
  ) {
    const result = this.db
      .prepare(
        `UPDATE group_engagement SET
          last_idle_at=?,
          last_idle_text=?,
          idle_attempts=idle_attempts+1,
          dormant=CASE WHEN idle_attempts+1>=? THEN 1 ELSE 0 END,
          updated_at=?
        WHERE bot_id=? AND group_id=? AND last_human_at=? AND dormant=0`,
      )
      .run(
        at.toISOString(),
        text.slice(0, 500),
        maxAttempts,
        at.toISOString(),
        botId,
        groupId,
        expectedLastHumanAt,
      );
    return result.changes === 1;
  }

  matchCustomCommand(botId: string, groupId: string, text: string) {
    const input = text.trim();
    if (!input) return null;
    const rows = this.db
      .prepare(
        `SELECT * FROM custom_commands
         WHERE enabled=1 AND (bot_id IS NULL OR bot_id=?)
           AND (group_id IS NULL OR group_id=?)
         ORDER BY (bot_id IS NOT NULL)+(group_id IS NOT NULL) DESC,updated_at DESC`,
      )
      .all(botId, groupId) as Array<Record<string, unknown>>;
    return (
      rows.find((row) => {
        const trigger = String(row.trigger_text).trim();
        if (!trigger) return false;
        if (row.match_mode === "prefix") return input.startsWith(trigger);
        if (row.match_mode === "contains") return input.includes(trigger);
        return input === trigger;
      }) || null
    );
  }

  listCustomCommands(botId: string, groupId: string) {
    return this.db
      .prepare(
        `SELECT * FROM custom_commands
         WHERE enabled=1 AND (bot_id IS NULL OR bot_id=?)
           AND (group_id IS NULL OR group_id=?)
         ORDER BY (bot_id IS NOT NULL)+(group_id IS NOT NULL) DESC,updated_at DESC`,
      )
      .all(botId, groupId) as Array<Record<string, unknown>>;
  }

  audit(actor: string, action: string, target?: string, detail: unknown = {}) {
    this.db
      .prepare(
        "INSERT INTO audit_logs (actor,action,target,detail_json,created_at) VALUES (?,?,?,?,?)",
      )
      .run(actor, action, target || null, JSON.stringify(detail), nowIso());
  }
}
