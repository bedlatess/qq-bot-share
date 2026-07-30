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

export type GroupPolicy = {
  bot_id: string;
  group_id: string;
  mode: "quiet" | "balanced" | "active";
  persona_override: string;
  settings_json: string;
  updated_at: string;
  settings: Record<string, unknown>;
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
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_thread
        ON conversation_messages(bot_id,group_id,user_id,id DESC);
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(bot_id,group_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS group_context_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        text TEXT NOT NULL,
        images_json TEXT NOT NULL DEFAULT '[]',
        event_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_group_context
        ON group_context_messages(bot_id,group_id,id DESC);
      CREATE TABLE IF NOT EXISTS message_traces (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        group_id TEXT,
        user_id TEXT,
        message_id TEXT,
        excerpt TEXT NOT NULL DEFAULT '',
        image_count INTEGER NOT NULL DEFAULT 0,
        decision TEXT NOT NULL DEFAULT 'received',
        reason TEXT NOT NULL DEFAULT '',
        provider_id TEXT,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_message_traces_created
        ON message_traces(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_message_traces_scope
        ON message_traces(bot_id,group_id,decision,created_at DESC);
      CREATE TABLE IF NOT EXISTS bot_groups (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        group_name TEXT NOT NULL DEFAULT '',
        member_count INTEGER NOT NULL DEFAULT 0,
        max_member_count INTEGER NOT NULL DEFAULT 0,
        bot_role TEXT NOT NULL DEFAULT 'unknown',
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(bot_id,group_id)
      );
      CREATE INDEX IF NOT EXISTS idx_bot_groups_name
        ON bot_groups(group_name,group_id);
      CREATE TABLE IF NOT EXISTS group_policies (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'balanced' CHECK(mode IN ('quiet','balanced','active')),
        persona_override TEXT NOT NULL DEFAULT '',
        settings_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(bot_id,group_id)
      );
      CREATE TABLE IF NOT EXISTS user_memories (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'chat',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_memories_scope
        ON user_memories(bot_id,group_id,user_id,updated_at DESC);
      CREATE TABLE IF NOT EXISTS persona_versions (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_health_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        healthy INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provider_health_created
        ON provider_health_events(provider_id,created_at DESC);
    `);
    const usageColumns = this.db
      .prepare("PRAGMA table_info(usage_events)")
      .all() as Array<{ name: string }>;
    if (!usageColumns.some((column) => column.name === "latency_ms"))
      this.db.exec(
        "ALTER TABLE usage_events ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0",
      );
    const nodeColumns = this.db
      .prepare("PRAGMA table_info(nodes)")
      .all() as Array<{ name: string }>;
    const addNodeColumn = (name: string, sql: string) => {
      if (!nodeColumns.some((column) => column.name === name)) this.db.exec(sql);
    };
    addNodeColumn(
      "update_state",
      "ALTER TABLE nodes ADD COLUMN update_state TEXT NOT NULL DEFAULT 'unknown'",
    );
    addNodeColumn(
      "target_version",
      "ALTER TABLE nodes ADD COLUMN target_version TEXT",
    );
    addNodeColumn(
      "last_update_at",
      "ALTER TABLE nodes ADD COLUMN last_update_at TEXT",
    );
    addNodeColumn(
      "last_update_error",
      "ALTER TABLE nodes ADD COLUMN last_update_error TEXT",
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

  loadConversation(botId: string, groupId: string, userId: string, limit = 20) {
    const messages = (
      this.db
        .prepare(
          `SELECT role,content FROM conversation_messages
           WHERE bot_id=? AND group_id=? AND user_id=?
           ORDER BY id DESC LIMIT ?`,
        )
        .all(botId, groupId, userId, Math.max(2, Math.min(100, limit))) as Array<{
        role: "user" | "assistant";
        content: string;
      }>
    ).reverse();
    const summary = this.db
      .prepare(
        "SELECT summary FROM conversation_summaries WHERE bot_id=? AND group_id=? AND user_id=?",
      )
      .get(botId, groupId, userId) as { summary: string } | undefined;
    return summary?.summary
      ? [
          {
            role: "user" as const,
            content: `[较早会话记忆]\n${summary.summary}`,
          },
          ...messages,
        ]
      : messages;
  }

  appendConversation(
    botId: string,
    groupId: string,
    userId: string,
    role: "user" | "assistant",
    content: string,
    maxMessages = 20,
  ) {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO conversation_messages
           (bot_id,group_id,user_id,role,content,created_at) VALUES (?,?,?,?,?,?)`,
        )
        .run(botId, groupId, userId, role, content.slice(0, 8000), nowIso());
      const keep = Math.max(2, Math.min(100, maxMessages));
      const overflow = this.db
        .prepare(
          `SELECT id,role,content FROM conversation_messages
           WHERE bot_id=? AND group_id=? AND user_id=? AND id NOT IN (
             SELECT id FROM conversation_messages
             WHERE bot_id=? AND group_id=? AND user_id=?
             ORDER BY id DESC LIMIT ?
           ) ORDER BY id`,
        )
        .all(botId, groupId, userId, botId, groupId, userId, keep) as Array<{
        id: number;
        role: string;
        content: string;
      }>;
      if (overflow.length) {
        const existing = this.db
          .prepare(
            "SELECT summary FROM conversation_summaries WHERE bot_id=? AND group_id=? AND user_id=?",
          )
          .get(botId, groupId, userId) as { summary: string } | undefined;
        const addition = overflow
          .map((item) => `${item.role === "assistant" ? "机器人" : "用户"}: ${item.content.slice(0, 240)}`)
          .join("\n");
        const summary = `${existing?.summary || ""}\n${addition}`.trim().slice(-1600);
        this.db
          .prepare(
            `INSERT INTO conversation_summaries
             (bot_id,group_id,user_id,summary,updated_at) VALUES (?,?,?,?,?)
             ON CONFLICT(bot_id,group_id,user_id) DO UPDATE SET
               summary=excluded.summary,updated_at=excluded.updated_at`,
          )
          .run(botId, groupId, userId, summary, nowIso());
      }
      this.db
        .prepare(
          `DELETE FROM conversation_messages
           WHERE bot_id=? AND group_id=? AND user_id=? AND id NOT IN (
             SELECT id FROM conversation_messages
             WHERE bot_id=? AND group_id=? AND user_id=?
             ORDER BY id DESC LIMIT ?
           )`,
        )
        .run(
          botId,
          groupId,
          userId,
          botId,
          groupId,
          userId,
          keep,
        );
    })();
  }

  clearConversation(botId: string, groupId: string, userId: string) {
    return this.db.transaction(() => {
      const deleted = this.db
        .prepare(
          "DELETE FROM conversation_messages WHERE bot_id=? AND group_id=? AND user_id=?",
        )
        .run(botId, groupId, userId).changes;
      this.db
        .prepare(
          "DELETE FROM conversation_summaries WHERE bot_id=? AND group_id=? AND user_id=?",
        )
        .run(botId, groupId, userId);
      return deleted;
    })();
  }

  appendGroupContext(input: {
    botId: string;
    groupId: string;
    name: string;
    role: "user" | "assistant";
    text: string;
    images?: string[];
    eventId?: string;
    at?: number;
  }) {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO group_context_messages
           (bot_id,group_id,name,role,text,images_json,event_id,created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.botId,
          input.groupId,
          input.name.slice(0, 100),
          input.role,
          input.text.slice(0, 1000),
          JSON.stringify((input.images || []).slice(0, 4)),
          input.eventId || null,
          new Date(input.at || Date.now()).toISOString(),
        );
      this.db
        .prepare(
          `DELETE FROM group_context_messages
           WHERE bot_id=? AND group_id=? AND id NOT IN (
             SELECT id FROM group_context_messages
             WHERE bot_id=? AND group_id=? ORDER BY id DESC LIMIT 40
           )`,
        )
        .run(input.botId, input.groupId, input.botId, input.groupId);
    })();
  }

  listGroupContext(botId: string, groupId: string, limit = 12) {
    return (
      this.db
        .prepare(
          `SELECT name,role,text,images_json,event_id,created_at
           FROM group_context_messages WHERE bot_id=? AND group_id=?
           ORDER BY id DESC LIMIT ?`,
        )
        .all(botId, groupId, Math.max(1, Math.min(40, limit))) as any[]
    )
      .reverse()
      .map((row) => ({
        name: String(row.name),
        role: row.role as "user" | "assistant",
        text: String(row.text),
        images: (() => {
          try {
            return JSON.parse(String(row.images_json)) as string[];
          } catch {
            return [];
          }
        })(),
        eventId: row.event_id ? String(row.event_id) : undefined,
        at: Date.parse(String(row.created_at)),
      }));
  }

  createMessageTrace(input: {
    eventId: string;
    botId: string;
    groupId?: string;
    userId?: string;
    messageId?: string;
    excerpt?: string;
    imageCount?: number;
  }) {
    const id = randomId("trace_");
    const now = nowIso();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO message_traces
         (id,event_id,bot_id,group_id,user_id,message_id,excerpt,image_count,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.eventId,
        input.botId,
        input.groupId || null,
        input.userId || null,
        input.messageId || null,
        (input.excerpt || "").slice(0, 500),
        Math.max(0, Number(input.imageCount || 0)),
        now,
        now,
      );
    return (
      this.db.prepare("SELECT id FROM message_traces WHERE event_id=?").get(input.eventId) as
        | { id: string }
        | undefined
    )?.id;
  }

  updateMessageTrace(
    id: string | undefined,
    decision: string,
    reason = "",
    detail: {
      providerId?: string;
      latencyMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      [key: string]: unknown;
    } = {},
  ) {
    if (!id) return;
    this.db
      .prepare(
        `UPDATE message_traces SET decision=?,reason=?,provider_id=?,latency_ms=?,
         input_tokens=?,output_tokens=?,detail_json=?,updated_at=? WHERE id=?`,
      )
      .run(
        decision,
        reason.slice(0, 500),
        detail.providerId || null,
        Math.max(0, Number(detail.latencyMs || 0)),
        Math.max(0, Number(detail.inputTokens || 0)),
        Math.max(0, Number(detail.outputTokens || 0)),
        JSON.stringify(detail),
        nowIso(),
        id,
      );
  }

  updateMessageTraceByEventId(
    eventId: string | undefined,
    decision: string,
    reason = "",
    detail: {
      providerId?: string;
      latencyMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      [key: string]: unknown;
    } = {},
  ) {
    if (!eventId) return;
    const row = this.db
      .prepare("SELECT id FROM message_traces WHERE event_id=?")
      .get(eventId) as { id: string } | undefined;
    this.updateMessageTrace(row?.id, decision, reason, detail);
  }

  syncBotGroups(botId: string, groups: Array<Record<string, unknown>>) {
    const now = nowIso();
    this.db.transaction(() => {
      const upsert = this.db.prepare(
        `INSERT INTO bot_groups
         (bot_id,group_id,group_name,member_count,max_member_count,bot_role,last_seen_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(bot_id,group_id) DO UPDATE SET
           group_name=excluded.group_name,member_count=excluded.member_count,
           max_member_count=excluded.max_member_count,bot_role=excluded.bot_role,
           last_seen_at=excluded.last_seen_at`,
      );
      for (const group of groups) {
        const groupId = String(group.group_id || "");
        if (!/^\d{5,15}$/.test(groupId)) continue;
        upsert.run(
          botId,
          groupId,
          String(group.group_name || ""),
          Math.max(0, Number(group.member_count || 0)),
          Math.max(0, Number(group.max_member_count || 0)),
          String(group.bot_role || group.role || "unknown"),
          now,
        );
      }
      this.db
        .prepare("DELETE FROM bot_groups WHERE bot_id=? AND last_seen_at<>?")
        .run(botId, now);
    })();
  }

  getGroupPolicy(botId: string, groupId: string): GroupPolicy | null {
    const row = this.db
      .prepare("SELECT * FROM group_policies WHERE bot_id=? AND group_id=?")
      .get(botId, groupId) as Omit<GroupPolicy, "settings"> | undefined;
    if (!row) return null;
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(row.settings_json) as Record<string, unknown>;
    } catch {
      settings = {};
    }
    return { ...row, settings };
  }

  listGroupPolicies(botId?: string) {
    const rows = this.db
      .prepare(
        `SELECT g.bot_id,g.group_id,g.group_name,g.member_count,g.bot_role,
          b.name bot_name,b.qq,gp.mode,gp.persona_override,gp.settings_json,gp.updated_at
         FROM bot_groups g JOIN bots b ON b.id=g.bot_id
         LEFT JOIN group_policies gp ON gp.bot_id=g.bot_id AND gp.group_id=g.group_id
         ${botId ? "WHERE g.bot_id=?" : ""}
         ORDER BY b.name,g.group_name,g.group_id`,
      )
      .all(...(botId ? [botId] : [])) as any[];
    return rows.map((row) => {
      let settings = {};
      try {
        settings = JSON.parse(String(row.settings_json || "{}"));
      } catch {
        settings = {};
      }
      return {
        ...row,
        mode: row.mode || "balanced",
        persona_override: row.persona_override || "",
        settings,
      };
    });
  }

  setGroupPolicy(input: {
    botId: string;
    groupId: string;
    mode: "quiet" | "balanced" | "active";
    personaOverride?: string;
    settings?: Record<string, unknown>;
  }) {
    this.db
      .prepare(
        `INSERT INTO group_policies
         (bot_id,group_id,mode,persona_override,settings_json,updated_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(bot_id,group_id) DO UPDATE SET
           mode=excluded.mode,persona_override=excluded.persona_override,
           settings_json=excluded.settings_json,updated_at=excluded.updated_at`,
      )
      .run(
        input.botId,
        input.groupId,
        input.mode,
        (input.personaOverride || "").slice(0, 6000),
        JSON.stringify(input.settings || {}),
        nowIso(),
      );
  }

  deleteGroupPolicy(botId: string, groupId: string) {
    return this.db
      .prepare("DELETE FROM group_policies WHERE bot_id=? AND group_id=?")
      .run(botId, groupId).changes;
  }

  addUserMemory(input: {
    botId: string;
    groupId: string;
    userId: string;
    content: string;
    source?: string;
  }) {
    const content = input.content.trim().slice(0, 1000);
    const existing = this.db
      .prepare(
        `SELECT id FROM user_memories
         WHERE bot_id=? AND group_id=? AND user_id=? AND content=?`,
      )
      .get(input.botId, input.groupId, input.userId, content) as
      | { id: string }
      | undefined;
    if (existing) {
      this.db
        .prepare("UPDATE user_memories SET updated_at=? WHERE id=?")
        .run(nowIso(), existing.id);
      return existing.id;
    }
    const id = randomId("mem_");
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO user_memories
         (id,bot_id,group_id,user_id,content,source,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.botId,
        input.groupId,
        input.userId,
        content,
        input.source || "chat",
        now,
        now,
      );
    return id;
  }

  listUserMemories(filter: {
    botId?: string;
    groupId?: string;
    userId?: string;
    query?: string;
    limit?: number;
  } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.botId) {
      where.push("m.bot_id=?");
      params.push(filter.botId);
    }
    if (filter.groupId) {
      where.push("m.group_id=?");
      params.push(filter.groupId);
    }
    if (filter.userId) {
      where.push("m.user_id=?");
      params.push(filter.userId);
    }
    if (filter.query) {
      where.push("m.content LIKE ? ESCAPE '\\'");
      params.push(`%${filter.query.replace(/[\\%_]/g, "\\$&")}%`);
    }
    params.push(Math.max(1, Math.min(500, filter.limit || 100)));
    return this.db
      .prepare(
        `SELECT m.*,b.name bot_name,b.qq,g.group_name
         FROM user_memories m JOIN bots b ON b.id=m.bot_id
         LEFT JOIN bot_groups g ON g.bot_id=m.bot_id AND g.group_id=m.group_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY m.updated_at DESC LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
  }

  forgetUserMemories(input: {
    botId: string;
    groupId: string;
    userId: string;
    query?: string;
  }) {
    if (!input.query?.trim())
      return this.db
        .prepare(
          "DELETE FROM user_memories WHERE bot_id=? AND group_id=? AND user_id=?",
        )
        .run(input.botId, input.groupId, input.userId).changes;
    const escaped = input.query.trim().replace(/[\\%_]/g, "\\$&");
    return this.db
      .prepare(
        `DELETE FROM user_memories WHERE bot_id=? AND group_id=? AND user_id=?
         AND content LIKE ? ESCAPE '\\'`,
      )
      .run(input.botId, input.groupId, input.userId, `%${escaped}%`).changes;
  }

  deleteUserMemory(id: string) {
    return this.db.prepare("DELETE FROM user_memories WHERE id=?").run(id).changes;
  }

  savePersonaVersion(config: unknown, note = "") {
    const id = randomId("persona_");
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO persona_versions (id,config_json,note,created_at) VALUES (?,?,?,?)",
        )
        .run(id, JSON.stringify(config), note.trim().slice(0, 200), nowIso());
      this.db.prepare(
        `DELETE FROM persona_versions WHERE id NOT IN (
           SELECT id FROM persona_versions ORDER BY created_at DESC LIMIT 20
         )`,
      ).run();
    })();
    return id;
  }

  listPersonaVersions() {
    return (this.db
      .prepare("SELECT id,note,created_at FROM persona_versions ORDER BY created_at DESC")
      .all() as Array<Record<string, unknown>>);
  }

  getPersonaVersion(id: string) {
    const row = this.db
      .prepare("SELECT config_json FROM persona_versions WHERE id=?")
      .get(id) as { config_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.config_json) as unknown;
    } catch {
      return null;
    }
  }

  recordProviderHealth(
    providerId: string,
    source: "call" | "probe",
    healthy: boolean,
    latencyMs: number,
    error = "",
  ) {
    this.db
      .prepare(
        `INSERT INTO provider_health_events
         (provider_id,source,healthy,latency_ms,error,created_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(
        providerId,
        source,
        healthy ? 1 : 0,
        Math.max(0, latencyMs),
        error.slice(0, 500),
        nowIso(),
      );
  }

  audit(actor: string, action: string, target?: string, detail: unknown = {}) {
    this.db
      .prepare(
        "INSERT INTO audit_logs (actor,action,target,detail_json,created_at) VALUES (?,?,?,?,?)",
      )
      .run(actor, action, target || null, JSON.stringify(detail), nowIso());
  }
}
