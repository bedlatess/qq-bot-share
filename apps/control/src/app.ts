import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { defaultFeatures, nowIso, PUFF_VERSION } from "@puff/shared";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { Store } from "./db.js";
import { AgentHub } from "./agent-hub.js";
import { ProviderPool } from "./provider-pool.js";
import { Moderator } from "./moderation.js";
import { EventPipeline } from "./pipeline.js";
import { StorageManager } from "./storage.js";
import { botDefaultsFallback, type BotDefaults } from "./bot-defaults.js";
import { compilePersona, normalizeGroupMode } from "./persona-engine.js";
import {
  encryptSecret,
  hashPassword,
  randomId,
  randomToken,
  sha256,
  verifyPassword,
} from "./security.js";

const sessionCookie = "puff_session";

function parseJson(value: unknown, fallback: unknown = {}) {
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function boolean(value: unknown) {
  return Boolean(Number(value));
}

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 4 * 1024 * 1024,
  });
  const agentBundlePath =
    config.agentBundlePath || join(process.cwd(), "puff-agent-update.tar.gz");
  const store = new Store(join(config.dataDir, "puff.sqlite"));
  await store.bootstrap(config.adminEmail, config.adminPassword);
  const agentUpdate = existsSync(agentBundlePath)
    ? {
        version: PUFF_VERSION,
        url: `${config.publicUrl.replace(/\/+$/, "")}/agent-update`,
        sha256: createHash("sha256")
          .update(readFileSync(agentBundlePath))
          .digest("hex"),
      }
    : undefined;
  const hub = new AgentHub(store, agentUpdate);
  const pool = new ProviderPool(store, config.masterKey);
  const moderator = new Moderator(store, pool);
  const pipeline = new EventPipeline(
    store,
    hub,
    pool,
    moderator,
    (error, context) => {
      app.log.error({ err: error, context }, "event pipeline failed");
    },
  );
  const storage = new StorageManager(
    store,
    config.dataDir,
    config.storageLimitBytes,
  );
  hub.onEvent = (botId, eventId, event) =>
    pipeline.enqueue(botId, eventId, event);
  pipeline.start();
  pool.startHealthMonitor();

  await app.register(cookie, {
    secret: config.sessionSecret,
    hook: "onRequest",
  });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  app.setErrorHandler((error, _request, reply) => {
    const zodError = error instanceof z.ZodError;
    const status = zodError ? 400 : (error as any).statusCode || 500;
    if (status >= 500) app.log.error(error);
    const message = zodError
      ? error.issues.map((item) => item.message).join("; ")
      : error instanceof Error
        ? error.message
        : String(error);
    reply.code(status).send({ ok: false, error: message });
  });

  app.addHook("preHandler", async (request, reply) => {
    if (
      !request.url.startsWith("/api/") ||
      request.url === "/api/auth/login" ||
      request.url === "/api/health"
    )
      return;
    const signed = request.cookies[sessionCookie];
    const unsigned = signed ? request.unsignCookie(signed) : null;
    if (!unsigned?.valid)
      return reply.code(401).send({ ok: false, error: "登录已失效" });
    const session = store.db
      .prepare(
        `SELECT s.*,a.email FROM sessions s JOIN admins a ON a.id=s.admin_id
      WHERE s.token_hash=? AND s.expires_at>?`,
      )
      .get(sha256(unsigned.value), nowIso()) as any;
    if (!session)
      return reply.code(401).send({ ok: false, error: "登录已失效" });
    (request as any).admin = {
      id: session.admin_id,
      email: session.email,
      csrf: session.csrf_token,
      sessionId: session.id,
    };
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (request.headers["x-csrf-token"] !== session.csrf_token)
        return reply.code(403).send({ ok: false, error: "CSRF 校验失败" });
      const origin = request.headers.origin;
      if (origin && !sameOrigin(origin, config.publicUrl, request))
        return reply.code(403).send({ ok: false, error: "来源校验失败" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    time: nowIso(),
    version: PUFF_VERSION,
    storage: storage.usage(),
  }));

  app.post("/api/auth/login", async (request, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(8).max(256),
      })
      .parse(request.body);
    const admin = store.db
      .prepare("SELECT * FROM admins WHERE email=?")
      .get(body.email.trim().toLowerCase()) as any;
    if (
      !admin ||
      !(await verifyPassword(
        body.password,
        admin.password_salt,
        admin.password_hash,
      ))
    ) {
      return reply.code(401).send({ ok: false, error: "邮箱或密码错误" });
    }
    const raw = randomToken();
    const csrf = randomToken(18);
    const expires = new Date(Date.now() + 7 * 86400000).toISOString();
    store.db
      .prepare(
        "INSERT INTO sessions (id,token_hash,admin_id,csrf_token,expires_at,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(randomId("ses_"), sha256(raw), admin.id, csrf, expires, nowIso());
    reply.setCookie(sessionCookie, raw, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: config.publicUrl.startsWith("https://"),
      signed: true,
      maxAge: 7 * 86400,
    });
    store.audit(`admin:${admin.email}`, "auth.login");
    return { ok: true, user: { email: admin.email }, csrf };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const admin = (request as any).admin;
    store.db.prepare("DELETE FROM sessions WHERE id=?").run(admin.sessionId);
    reply.clearCookie(sessionCookie, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => ({
    ok: true,
    user: { email: (request as any).admin.email },
    csrf: (request as any).admin.csrf,
  }));

  app.put("/api/auth/password", async (request) => {
    const body = z
      .object({
        currentPassword: z.string().min(8),
        newPassword: z.string().min(10).max(256),
      })
      .parse(request.body);
    const actor = (request as any).admin;
    const admin = store.db
      .prepare("SELECT * FROM admins WHERE id=?")
      .get(actor.id) as any;
    if (
      !(await verifyPassword(
        body.currentPassword,
        admin.password_salt,
        admin.password_hash,
      ))
    )
      throw Object.assign(new Error("当前密码错误"), { statusCode: 400 });
    const next = await hashPassword(body.newPassword);
    store.db
      .prepare(
        "UPDATE admins SET password_hash=?,password_salt=?,updated_at=? WHERE id=?",
      )
      .run(next.hash, next.salt, nowIso(), admin.id);
    store.db
      .prepare("DELETE FROM sessions WHERE admin_id=? AND id<>?")
      .run(admin.id, actor.sessionId);
    store.audit(`admin:${actor.email}`, "auth.password_change");
    return { ok: true };
  });

  app.get("/api/dashboard", async () => {
    const scalar = (sql: string, ...params: unknown[]) =>
      Number((store.db.prepare(sql).get(...params) as any)?.count || 0);
    const chinaDate = new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const todayStart = new Date(`${chinaDate}T00:00:00+08:00`).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const usageTotals = store.db
      .prepare("SELECT * FROM usage_totals WHERE id=1")
      .get() as any;
    const usageRecent = store.db
      .prepare(
        `SELECT COUNT(*) call_count,COALESCE(SUM(input_tokens),0) input_tokens,
         COALESCE(SUM(output_tokens),0) output_tokens,
         COALESCE(ROUND(AVG(NULLIF(latency_ms,0))),0) avg_latency_ms
         FROM usage_events WHERE created_at>=?`,
      )
      .get(todayStart) as any;
    const usageByKind = store.db
      .prepare(
        `SELECT kind,COUNT(*) count FROM usage_events
         WHERE created_at>=? GROUP BY kind ORDER BY count DESC`,
      )
      .all(sevenDaysAgo);
    return {
      ok: true,
      data: {
        nodes: {
          total: scalar("SELECT COUNT(*) count FROM nodes"),
          online: scalar(
            "SELECT COUNT(*) count FROM nodes WHERE status='online' AND julianday(last_seen_at)>=julianday('now','-45 seconds')",
          ),
        },
        bots: {
          total: scalar("SELECT COUNT(*) count FROM bots"),
          online: scalar(
            "SELECT COUNT(*) count FROM bots WHERE status='online' AND julianday(last_seen_at)>=julianday('now','-45 seconds')",
          ),
        },
        licenses: {
          total: scalar("SELECT COUNT(*) count FROM group_licenses"),
          active: scalar(
            "SELECT COUNT(*) count FROM group_licenses WHERE status='active' AND (permanent=1 OR julianday(expires_at)>julianday('now'))",
          ),
        },
        providers: {
          total: scalar("SELECT COUNT(*) count FROM ai_providers"),
          healthy: scalar(
            "SELECT COUNT(*) count FROM ai_providers WHERE health_status='healthy'",
          ),
        },
        usageToday: Number(usageRecent.call_count || 0),
        usage: {
          today: Number(usageRecent.call_count || 0),
          total: Number(usageTotals?.call_count || 0),
          last7Days: scalar(
            "SELECT COUNT(*) count FROM usage_events WHERE created_at>=?",
            sevenDaysAgo,
          ),
          inputTokens: Number(usageTotals?.input_tokens || 0),
          outputTokens: Number(usageTotals?.output_tokens || 0),
          todayInputTokens: Number(usageRecent.input_tokens || 0),
          todayOutputTokens: Number(usageRecent.output_tokens || 0),
          averageLatencyMs: Number(usageRecent.avg_latency_ms || 0),
          byKind: usageByKind,
        },
        moderationToday: scalar(
          "SELECT COUNT(*) count FROM moderation_events WHERE created_at>=?",
          todayStart,
        ),
        storage: storage.usage(),
      },
    };
  });

  registerNodeRoutes(app, store);
  registerBotRoutes(app, store, hub);
  registerPlanRoutes(app, store);
  registerLicenseRoutes(app, store);
  registerCardRoutes(app, store);
  registerProviderRoutes(app, store, pool, config.masterKey);
  registerCustomCommandRoutes(app, store);
  registerGroupRoutes(app, store, hub);
  registerPersonaRoutes(app, store, pool);
  registerDiagnosticRoutes(app, store);
  registerSettingsRoutes(app, store);
  registerLogRoutes(app, store, storage);

  app.get("/agent", { websocket: true }, (socket, request) => {
    const query = z
      .object({ nodeId: z.string().min(1), token: z.string().min(16) })
      .safeParse(request.query);
    if (
      !query.success ||
      !hub.authenticate(query.data.nodeId, query.data.token)
    ) {
      socket.close(4003, "unauthorized");
      return;
    }
    hub.attach(query.data.nodeId, socket);
  });

  app.get("/agent-update", async (request, reply) => {
    const query = z
      .object({ nodeId: z.string().min(1) })
      .safeParse(request.query);
    const authorization = String(request.headers.authorization || "");
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";
    if (
      !query.success ||
      !token ||
      !hub.authenticate(query.data.nodeId, token) ||
      !existsSync(agentBundlePath)
    )
      return reply.code(404).send({ ok: false, error: "Not found" });
    return reply
      .type("application/gzip")
      .header("content-disposition", `attachment; filename="puff-agent-${PUFF_VERSION}.tar.gz"`)
      .header("x-puff-version", PUFF_VERSION)
      .header("x-puff-sha256", agentUpdate?.sha256 || "")
      .send(createReadStream(agentBundlePath));
  });

  if (existsSync(config.publicDir)) {
    await app.register(fastifyStatic, {
      root: config.publicDir,
      wildcard: false,
    });
    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/agent"))
        return reply.code(404).send({ ok: false, error: "Not found" });
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () => ({
      ok: true,
      message: "Control API is running. Build apps/web to enable the console.",
    }));
  }

  const cleanupTimer = setInterval(() => storage.cleanup(), 6 * 60 * 60 * 1000);
  cleanupTimer.unref();
  let syncingGroups = false;
  const syncOnlineGroups = async () => {
    if (syncingGroups) return;
    syncingGroups = true;
    try {
      const bots = store.db
        .prepare(
          `SELECT id FROM bots WHERE enabled=1 AND status='online'
           AND julianday(last_seen_at)>=julianday('now','-45 seconds')`,
        )
        .all() as Array<{ id: string }>;
      for (const bot of bots) {
        try {
          const payload = await hub.requestBotGroups(bot.id);
          const groups = Array.isArray(payload)
            ? payload
            : Array.isArray((payload as any)?.data)
              ? (payload as any).data
              : [];
          store.syncBotGroups(bot.id, groups as Array<Record<string, unknown>>);
        } catch (error) {
          app.log.warn({ err: error, botId: bot.id }, "group sync failed");
        }
      }
    } finally {
      syncingGroups = false;
    }
  };
  const initialGroupSync = setTimeout(() => void syncOnlineGroups(), 90_000);
  const groupSyncTimer = setInterval(() => void syncOnlineGroups(), 10 * 60 * 1000);
  initialGroupSync.unref();
  groupSyncTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    clearTimeout(initialGroupSync);
    clearInterval(groupSyncTimer);
    pool.stopHealthMonitor();
    pipeline.stop();
    store.close();
  });
  return Object.assign(app, {
    puff: { store, hub, pool, pipeline, moderator, storage },
  });
}

function sameOrigin(
  origin: string,
  publicUrl: string,
  request: FastifyRequest,
) {
  try {
    const allowed = new URL(publicUrl);
    const received = new URL(origin);
    if (allowed.host === received.host) return true;
    return received.host === request.headers.host;
  } catch {
    return false;
  }
}

function registerNodeRoutes(app: any, store: Store) {
  app.get("/api/nodes", async () => {
    const rows = store.db
      .prepare(
        `SELECT n.*,
    (SELECT COUNT(*) FROM bots b WHERE b.node_id=n.id) bot_count FROM nodes n ORDER BY n.created_at DESC`,
      )
      .all() as any[];
    return {
      ok: true,
      data: rows.map((row) => ({
        ...row,
        status: effectivePresence(row.status, row.last_seen_at),
      })),
    };
  });
  app.post("/api/nodes", async (request: any) => {
    const body = z
      .object({ name: z.string().min(1).max(80) })
      .parse(request.body);
    const token = randomToken();
    const id = randomId("node_");
    store.db
      .prepare(
        "INSERT INTO nodes (id,name,token_hash,created_at) VALUES (?,?,?,?)",
      )
      .run(id, body.name.trim(), sha256(token), nowIso());
    store.audit(`admin:${request.admin.email}`, "node.create", id);
    return {
      ok: true,
      data: { nodeId: id, nodeToken: token, name: body.name.trim() },
    };
  });
  app.delete("/api/nodes/:id", async (request: any) => {
    const id = z.string().parse(request.params.id);
    if (
      (
        store.db
          .prepare("SELECT COUNT(*) count FROM bots WHERE node_id=?")
          .get(id) as any
      ).count > 0
    )
      throw Object.assign(new Error("节点下还有机器人，不能删除"), {
        statusCode: 409,
      });
    store.db.prepare("DELETE FROM nodes WHERE id=?").run(id);
    store.audit(`admin:${request.admin.email}`, "node.delete", id);
    return { ok: true };
  });
}

function registerBotRoutes(app: any, store: Store, hub: AgentHub) {
  app.get("/api/bots", async () => ({
    ok: true,
    data: (
      store.db
        .prepare(
          `SELECT b.*,n.name node_name FROM bots b JOIN nodes n ON n.id=b.node_id ORDER BY b.created_at DESC`,
        )
        .all() as any[]
    ).map((row) => ({
      ...row,
      status: effectivePresence(row.status, row.last_seen_at),
      enabled: boolean(row.enabled),
      settings: parseJson(row.settings_json),
    })),
  }));
  app.post("/api/bots", async (request: any) => {
    const body = z
      .object({
        nodeId: z.string(),
        qq: z.string().regex(/^\d{5,15}$/),
        name: z.string().min(1).max(80),
        persona: z.string().max(100).optional(),
        systemPrompt: z.string().max(10000).optional(),
      })
      .parse(request.body);
    const id = randomId("bot_");
    store.db
      .prepare(
        `INSERT INTO bots (id,node_id,qq,name,persona,system_prompt,created_at) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        body.nodeId,
        body.qq,
        body.name,
        body.persona || "",
        body.systemPrompt || "",
        nowIso(),
      );
    store.audit(`admin:${request.admin.email}`, "bot.create", id, {
      qq: body.qq,
    });
    return { ok: true, data: { id } };
  });
  app.put("/api/bots/:id", async (request: any) => {
    const body = z
      .object({
        name: z.string().min(1).max(80),
        enabled: z.boolean(),
        persona: z.string().max(100),
        systemPrompt: z.string().max(10000),
        settings: z.record(z.unknown()).default({}),
      })
      .parse(request.body);
    store.db
      .prepare(
        `UPDATE bots SET name=?,enabled=?,persona=?,system_prompt=?,settings_json=? WHERE id=?`,
      )
      .run(
        body.name,
        body.enabled ? 1 : 0,
        body.persona,
        body.systemPrompt,
        JSON.stringify(body.settings),
        request.params.id,
      );
    store.audit(
      `admin:${request.admin.email}`,
      "bot.update",
      request.params.id,
    );
    return { ok: true };
  });
  app.delete("/api/bots/:id", async (request: any) => {
    store.db.prepare("DELETE FROM bots WHERE id=?").run(request.params.id);
    store.audit(
      `admin:${request.admin.email}`,
      "bot.delete",
      request.params.id,
    );
    return { ok: true };
  });
  for (const [route, operation] of [
    ["status", "status"],
    ["qrcode", "qrcode"],
    ["refresh-qrcode", "refresh_qrcode"],
    ["restart", "restart"],
  ] as const) {
    app.post(`/api/bots/:id/${route}`, async (request: any) => ({
      ok: true,
      data: await hub.requestNapCat(request.params.id, operation),
    }));
  }
}

function effectivePresence(status: unknown, lastSeenAt: unknown) {
  const seen = Date.parse(String(lastSeenAt || ""));
  return status === "online" &&
    Number.isFinite(seen) &&
    Date.now() - seen < 45_000
    ? "online"
    : "offline";
}

function registerPlanRoutes(app: any, store: Store) {
  app.get("/api/plans", async () => ({
    ok: true,
    data: (
      store.db
        .prepare("SELECT * FROM plans ORDER BY created_at DESC")
        .all() as any[]
    ).map((row) => ({
      ...row,
      enabled: boolean(row.enabled),
      features: parseJson(row.features_json),
    })),
  }));
  app.post("/api/plans", async (request: any) => {
    const body = z
      .object({
        name: z.string().min(1).max(80),
        durationDays: z.number().int().min(0).nullable(),
        monthlyQuota: z.number().int().min(0),
        features: z.record(z.boolean()).default(defaultFeatures),
      })
      .parse(request.body);
    const id = randomId("plan_");
    const now = nowIso();
    store.db
      .prepare(
        `INSERT INTO plans (id,name,duration_days,monthly_quota,features_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)`,
      )
      .run(
        id,
        body.name,
        body.durationDays,
        body.monthlyQuota,
        JSON.stringify({ ...defaultFeatures, ...body.features }),
        now,
        now,
      );
    store.audit(`admin:${request.admin.email}`, "plan.create", id);
    return { ok: true, data: { id } };
  });
  app.put("/api/plans/:id", async (request: any) => {
    const body = z
      .object({
        name: z.string().min(1).max(80),
        durationDays: z.number().int().min(0).nullable(),
        monthlyQuota: z.number().int().min(0),
        features: z.record(z.boolean()),
        enabled: z.boolean(),
      })
      .parse(request.body);
    store.db
      .prepare(
        `UPDATE plans SET name=?,duration_days=?,monthly_quota=?,features_json=?,enabled=?,updated_at=? WHERE id=?`,
      )
      .run(
        body.name,
        body.durationDays,
        body.monthlyQuota,
        JSON.stringify({ ...defaultFeatures, ...body.features }),
        body.enabled ? 1 : 0,
        nowIso(),
        request.params.id,
      );
    return { ok: true };
  });
}

function registerLicenseRoutes(app: any, store: Store) {
  app.get("/api/licenses", async () => ({
    ok: true,
    data: store.db
      .prepare(
        `SELECT l.*,b.name bot_name,b.qq,p.name plan_name,p.monthly_quota
    FROM group_licenses l JOIN bots b ON b.id=l.bot_id JOIN plans p ON p.id=l.plan_id ORDER BY l.updated_at DESC`,
      )
      .all(),
  }));
  app.post("/api/licenses", async (request: any) => {
    const body = z
      .object({
        botId: z.string(),
        groupId: z.string().regex(/^\d{5,15}$/),
        planId: z.string(),
        durationDays: z.number().int().min(0).nullable().optional(),
        permanent: z.boolean().default(false),
      })
      .parse(request.body);
    const plan = store.db
      .prepare("SELECT * FROM plans WHERE id=?")
      .get(body.planId) as any;
    if (!plan)
      throw Object.assign(new Error("套餐不存在"), { statusCode: 404 });
    const days = body.permanent
      ? 0
      : (body.durationDays ?? plan.duration_days ?? 30);
    const existing = store.db
      .prepare(
        "SELECT expires_at,permanent FROM group_licenses WHERE bot_id=? AND group_id=?",
      )
      .get(body.botId, body.groupId) as
      { expires_at: string | null; permanent: number } | undefined;
    const base =
      existing?.expires_at &&
      new Date(existing.expires_at).getTime() > Date.now()
        ? new Date(existing.expires_at).getTime()
        : Date.now();
    const expires =
      days > 0 ? new Date(base + days * 86400000).toISOString() : null;
    const now = nowIso();
    store.db
      .prepare(
        `INSERT INTO group_licenses
      (id,bot_id,group_id,plan_id,starts_at,expires_at,permanent,status,usage_period,usage_count,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'active',?,0,?,?) ON CONFLICT(bot_id,group_id) DO UPDATE SET
      plan_id=excluded.plan_id,starts_at=excluded.starts_at,expires_at=excluded.expires_at,permanent=excluded.permanent,status='active',updated_at=excluded.updated_at`,
      )
      .run(
        randomId("lic_"),
        body.botId,
        body.groupId,
        body.planId,
        now,
        expires,
        days <= 0 ? 1 : 0,
        now.slice(0, 7),
        now,
        now,
      );
    store.audit(
      `admin:${request.admin.email}`,
      "license.upsert",
      `${body.botId}:${body.groupId}`,
    );
    return { ok: true };
  });
  app.delete("/api/licenses/:id", async (request: any) => {
    store.db
      .prepare("DELETE FROM group_licenses WHERE id=?")
      .run(request.params.id);
    store.audit(
      `admin:${request.admin.email}`,
      "license.delete",
      request.params.id,
    );
    return { ok: true };
  });
}

function registerCardRoutes(app: any, store: Store) {
  app.get("/api/cards", async () => ({
    ok: true,
    data: store.db
      .prepare(
        `SELECT c.id,c.code_prefix,c.plan_id,c.duration_days,c.status,
    c.bound_bot_id,c.bound_group_id,c.created_at,c.used_at,c.revoked_at,p.name plan_name FROM activation_codes c
    JOIN plans p ON p.id=c.plan_id ORDER BY c.created_at DESC LIMIT 1000`,
      )
      .all(),
  }));
  app.post("/api/cards/generate", async (request: any) => {
    const body = z
      .object({
        planId: z.string(),
        count: z.number().int().min(1).max(500),
        durationDays: z.number().int().min(0).nullable().optional(),
      })
      .parse(request.body);
    const codes = store.createActivationCodes(
      body.planId,
      body.count,
      body.durationDays,
    );
    store.audit(`admin:${request.admin.email}`, "card.generate", body.planId, {
      count: body.count,
    });
    return { ok: true, data: { codes } };
  });
  app.post("/api/cards/:id/revoke", async (request: any) => {
    store.db
      .prepare(
        "UPDATE activation_codes SET status='revoked',revoked_at=? WHERE id=? AND status='unused'",
      )
      .run(nowIso(), request.params.id);
    store.audit(
      `admin:${request.admin.email}`,
      "card.revoke",
      request.params.id,
    );
    return { ok: true };
  });
}

function registerProviderRoutes(
  app: any,
  store: Store,
  pool: ProviderPool,
  masterKey: string,
) {
  const publicRows = () =>
    (
      store.db
        .prepare("SELECT * FROM ai_providers ORDER BY priority,created_at")
        .all() as any[]
    ).map((row) => {
      const cutoff = new Date(Date.now() - 86400000).toISOString();
      const health = store.db
        .prepare(
          `SELECT COUNT(*) samples,COALESCE(SUM(healthy),0) successes,
           COALESCE(ROUND(AVG(CASE WHEN healthy=1 THEN latency_ms END)),0) avg_latency_ms,
           MAX(created_at) last_checked_at
           FROM provider_health_events WHERE provider_id=? AND created_at>=?`,
        )
        .get(row.id, cutoff) as any;
      const samples = Number(health?.samples || 0);
      return {
        ...row,
        api_key_enc: undefined,
        apiKeyMasked: row.api_key_enc ? "已配置" : "未配置",
        enabled: boolean(row.enabled),
        capabilities: parseJson(row.capabilities_json),
        health24h: {
          samples,
          successRate: samples
            ? Math.round((Number(health.successes || 0) / samples) * 1000) / 10
            : null,
          averageLatencyMs: Number(health?.avg_latency_ms || 0),
          lastCheckedAt: health?.last_checked_at || null,
        },
      };
    });
  app.get("/api/providers", async () => ({ ok: true, data: publicRows() }));
  app.post("/api/providers", async (request: any) => {
    const body = z
      .object({
        name: z.string().min(1).max(80),
        baseUrl: z.string().url(),
        apiKey: z.string().min(1),
        model: z.string().min(1),
        priority: z.number().int().min(0).max(10000),
        timeoutMs: z.number().int().min(1000).max(180000),
      })
      .parse(request.body);
    const id = randomId("ai_");
    const now = nowIso();
    store.db
      .prepare(
        `INSERT INTO ai_providers (id,name,base_url,api_key_enc,model,priority,timeout_ms,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        body.name,
        body.baseUrl.replace(/\/+$/, ""),
        encryptSecret(body.apiKey, masterKey),
        body.model,
        body.priority,
        body.timeoutMs,
        now,
        now,
      );
    store.audit(`admin:${request.admin.email}`, "provider.create", id);
    return { ok: true, data: { id, probe: await pool.probe(id) } };
  });
  app.put("/api/providers/:id", async (request: any) => {
    const body = z
      .object({
        name: z.string().min(1),
        baseUrl: z.string().url(),
        apiKey: z.string().optional(),
        model: z.string().min(1),
        priority: z.number().int().min(0),
        timeoutMs: z.number().int().min(1000),
        enabled: z.boolean(),
      })
      .parse(request.body);
    if (body.apiKey)
      store.db
        .prepare(
          `UPDATE ai_providers SET name=?,base_url=?,api_key_enc=?,model=?,priority=?,timeout_ms=?,enabled=?,updated_at=? WHERE id=?`,
        )
        .run(
          body.name,
          body.baseUrl.replace(/\/+$/, ""),
          encryptSecret(body.apiKey, masterKey),
          body.model,
          body.priority,
          body.timeoutMs,
          body.enabled ? 1 : 0,
          nowIso(),
          request.params.id,
        );
    else
      store.db
        .prepare(
          `UPDATE ai_providers SET name=?,base_url=?,model=?,priority=?,timeout_ms=?,enabled=?,updated_at=? WHERE id=?`,
        )
        .run(
          body.name,
          body.baseUrl.replace(/\/+$/, ""),
          body.model,
          body.priority,
          body.timeoutMs,
          body.enabled ? 1 : 0,
          nowIso(),
          request.params.id,
        );
    return { ok: true };
  });
  app.post("/api/providers/:id/probe", async (request: any) => ({
    ok: true,
    data: await pool.probe(request.params.id),
  }));
  app.delete("/api/providers/:id", async (request: any) => {
    store.db
      .prepare("DELETE FROM ai_providers WHERE id=?")
      .run(request.params.id);
    return { ok: true };
  });
}

function registerCustomCommandRoutes(app: any, store: Store) {
  const commandSchema = z.object({
    botId: z.string().nullable().default(null),
    groupId: z
      .union([z.string().regex(/^\d{5,15}$/), z.literal(""), z.null()])
      .default(null),
    trigger: z.string().trim().min(1).max(200),
    response: z.string().trim().min(1).max(4000),
    matchMode: z.enum(["exact", "prefix", "contains"]).default("exact"),
    enabled: z.boolean().default(true),
  });
  const publicRows = () =>
    store.db
      .prepare(
        `SELECT c.*,b.name bot_name,b.qq bot_qq
         FROM custom_commands c LEFT JOIN bots b ON b.id=c.bot_id
         ORDER BY c.updated_at DESC`,
      )
      .all();

  app.get("/api/custom-commands", async () => ({
    ok: true,
    data: publicRows(),
  }));
  app.post("/api/custom-commands", async (request: any) => {
    const body = commandSchema.parse(request.body);
    const id = randomId("cmd_");
    const now = nowIso();
    store.db
      .prepare(
        `INSERT INTO custom_commands
         (id,bot_id,group_id,trigger_text,response_text,match_mode,enabled,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        body.botId || null,
        body.groupId || null,
        body.trigger,
        body.response,
        body.matchMode,
        body.enabled ? 1 : 0,
        now,
        now,
      );
    store.audit(`admin:${request.admin.email}`, "custom_command.create", id);
    return { ok: true, data: { id } };
  });
  app.put("/api/custom-commands/:id", async (request: any) => {
    const body = commandSchema.parse(request.body);
    const result = store.db
      .prepare(
        `UPDATE custom_commands SET bot_id=?,group_id=?,trigger_text=?,response_text=?,
         match_mode=?,enabled=?,updated_at=? WHERE id=?`,
      )
      .run(
        body.botId || null,
        body.groupId || null,
        body.trigger,
        body.response,
        body.matchMode,
        body.enabled ? 1 : 0,
        nowIso(),
        request.params.id,
      );
    if (!result.changes)
      throw Object.assign(new Error("自定义命令不存在"), { statusCode: 404 });
    store.audit(
      `admin:${request.admin.email}`,
      "custom_command.update",
      request.params.id,
    );
    return { ok: true };
  });
  app.delete("/api/custom-commands/:id", async (request: any) => {
    store.db
      .prepare("DELETE FROM custom_commands WHERE id=?")
      .run(request.params.id);
    store.audit(
      `admin:${request.admin.email}`,
      "custom_command.delete",
      request.params.id,
    );
    return { ok: true };
  });
}

function registerGroupRoutes(app: any, store: Store, hub: AgentHub) {
  app.get("/api/groups", async (request: any) => {
    const query = z
      .object({ botId: z.string().optional() })
      .parse(request.query);
    const rows = query.botId
      ? store.db
          .prepare(
            `SELECT g.*,b.name bot_name,b.qq,l.id license_id,l.status license_status,
             l.expires_at,l.permanent,p.name plan_name
             FROM bot_groups g JOIN bots b ON b.id=g.bot_id
             LEFT JOIN group_licenses l ON l.bot_id=g.bot_id AND l.group_id=g.group_id
             LEFT JOIN plans p ON p.id=l.plan_id
             WHERE g.bot_id=? ORDER BY g.group_name,g.group_id`,
          )
          .all(query.botId)
      : store.db
          .prepare(
            `SELECT g.*,b.name bot_name,b.qq,l.id license_id,l.status license_status,
             l.expires_at,l.permanent,p.name plan_name
             FROM bot_groups g JOIN bots b ON b.id=g.bot_id
             LEFT JOIN group_licenses l ON l.bot_id=g.bot_id AND l.group_id=g.group_id
             LEFT JOIN plans p ON p.id=l.plan_id
             ORDER BY b.name,g.group_name,g.group_id`,
          )
          .all();
    return { ok: true, data: rows };
  });

  app.post("/api/bots/:id/sync-groups", async (request: any) => {
    const botId = z.string().parse(request.params.id);
    const payload = await hub.requestBotGroups(botId);
    const groups = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as any)?.data)
        ? (payload as any).data
        : [];
    store.syncBotGroups(botId, groups as Array<Record<string, unknown>>);
    store.audit(`admin:${request.admin.email}`, "bot.groups.sync", botId, {
      count: groups.length,
    });
    return { ok: true, data: { count: groups.length } };
  });
}

const groupPolicySettingsSchema = z
  .object({
    humorLevel: z.number().int().min(1).max(5).optional(),
    initiativeLevel: z.number().int().min(1).max(5).optional(),
    directnessLevel: z.number().int().min(1).max(5).optional(),
    technicalDepth: z.number().int().min(1).max(5).optional(),
    answerLength: z.number().int().min(1).max(5).optional(),
    cooldownMs: z.number().int().min(0).max(3600000).optional(),
    lurkEnabled: z.boolean().optional(),
    lurkMinMessages: z.number().int().min(1).max(20).optional(),
    lurkQuietSeconds: z.number().int().min(1).max(60).optional(),
    lurkIntervalSeconds: z.number().int().min(5).max(3600).optional(),
    idleEnabled: z.boolean().optional(),
    idleAfterMinutes: z.number().int().min(1).max(1440).optional(),
    idleMaxAttempts: z.number().int().min(1).max(5).optional(),
    activeStartHour: z.number().int().min(0).max(23).optional(),
    activeEndHour: z.number().int().min(1).max(24).optional(),
  })
  .strict();

function registerPersonaRoutes(app: any, store: Store, pool: ProviderPool) {
  app.get("/api/group-policies", async (request: any) => {
    const query = z.object({ botId: z.string().optional() }).parse(request.query);
    return { ok: true, data: store.listGroupPolicies(query.botId) };
  });

  app.put("/api/group-policies", async (request: any) => {
    const body = z
      .object({
        botId: z.string().min(1),
        groupId: z.string().regex(/^\d{5,15}$/),
        mode: z.enum(["quiet", "balanced", "active"]),
        personaOverride: z.string().max(6000).default(""),
        settings: groupPolicySettingsSchema.default({}),
      })
      .parse(request.body);
    const group = store.db
      .prepare("SELECT 1 FROM bot_groups WHERE bot_id=? AND group_id=?")
      .get(body.botId, body.groupId);
    if (!group)
      throw Object.assign(new Error("群信息不存在，请先同步群列表"), {
        statusCode: 404,
      });
    store.setGroupPolicy(body);
    store.audit(
      `admin:${request.admin.email}`,
      "group_policy.update",
      `${body.botId}:${body.groupId}`,
      { mode: body.mode },
    );
    return { ok: true };
  });

  app.delete("/api/group-policies/:botId/:groupId", async (request: any) => {
    const params = z
      .object({
        botId: z.string().min(1),
        groupId: z.string().regex(/^\d{5,15}$/),
      })
      .parse(request.params);
    const deleted = store.deleteGroupPolicy(params.botId, params.groupId);
    store.audit(
      `admin:${request.admin.email}`,
      "group_policy.reset",
      `${params.botId}:${params.groupId}`,
      { deleted },
    );
    return { ok: true, data: { deleted } };
  });

  app.get("/api/memories", async (request: any) => {
    const query = z
      .object({
        botId: z.string().optional(),
        groupId: z.string().optional(),
        userId: z.string().optional(),
        query: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(request.query);
    return { ok: true, data: store.listUserMemories(query) };
  });

  app.post("/api/memories", async (request: any) => {
    const body = z
      .object({
        botId: z.string().min(1),
        groupId: z.string().regex(/^\d{5,15}$/),
        userId: z.string().regex(/^\d{5,15}$/),
        content: z.string().trim().min(1).max(1000),
      })
      .parse(request.body);
    const group = store.db
      .prepare("SELECT 1 FROM bot_groups WHERE bot_id=? AND group_id=?")
      .get(body.botId, body.groupId);
    if (!group)
      throw Object.assign(new Error("机器人与群不匹配，请先同步群列表"), {
        statusCode: 404,
      });
    const id = store.addUserMemory({ ...body, source: "admin" });
    store.audit(`admin:${request.admin.email}`, "memory.add", id);
    return { ok: true, data: { id } };
  });

  app.delete("/api/memories/:id", async (request: any) => {
    const id = z.string().parse(request.params.id);
    const deleted = store.deleteUserMemory(id);
    store.audit(`admin:${request.admin.email}`, "memory.delete", id);
    return { ok: true, data: { deleted } };
  });

  app.delete("/api/memories", async (request: any) => {
    const body = z
      .object({
        botId: z.string().min(1),
        groupId: z.string().regex(/^\d{5,15}$/),
        userId: z.string().regex(/^\d{5,15}$/),
      })
      .parse(request.body);
    const deleted = store.forgetUserMemories(body);
    store.audit(
      `admin:${request.admin.email}`,
      "memory.clear",
      `${body.botId}:${body.groupId}:${body.userId}`,
      { deleted },
    );
    return { ok: true, data: { deleted } };
  });

  app.post("/api/persona/preview", async (request: any) => {
    const body = z
      .object({
        botId: z.string().min(1),
        groupId: z.string().optional().default(""),
        userId: z.string().optional().default(""),
        message: z.string().trim().min(1).max(4000),
        technical: z.boolean().default(false),
        defaults: groupPolicySettingsSchema.optional(),
      })
      .parse(request.body);
    const bot = store.db
      .prepare("SELECT * FROM bots WHERE id=?")
      .get(body.botId) as any;
    if (!bot)
      throw Object.assign(new Error("机器人不存在"), { statusCode: 404 });
    const baseDefaults = {
      ...botDefaultsFallback,
      ...store.getSetting<Partial<BotDefaults>>("bot_defaults", {}),
    };
    const policy = body.groupId
      ? store.getGroupPolicy(body.botId, body.groupId)
      : null;
    const defaults = {
      ...baseDefaults,
      ...(policy?.settings || {}),
      ...(body.defaults || {}),
    } as BotDefaults;
    const memories = body.groupId && body.userId
      ? store.listUserMemories({
          botId: body.botId,
          groupId: body.groupId,
          userId: body.userId,
          limit: 12,
        })
      : [];
    const compiled = compilePersona({
      bot,
      defaults,
      groupMode: normalizeGroupMode(policy?.mode),
      groupPersona: policy?.persona_override,
      modePrompt: body.technical ? defaults.techPrompt : undefined,
      memories,
    });
    const started = Date.now();
    const result = await pool.chat(
      [
        { role: "system", content: compiled.prompt },
        { role: "user", content: body.message },
      ],
      "text",
      {
        botId: body.botId,
        groupId: body.groupId || undefined,
        kind: "persona_preview",
      },
    );
    return {
      ok: true,
      data: {
        reply: result.text,
        providerId: result.providerId,
        latencyMs: Number((result as any).latencyMs || Date.now() - started),
        layers: compiled.layers.map((layer) => ({
          key: layer.key,
          label: layer.label,
          characters: layer.content.length,
        })),
      },
    };
  });

  app.get("/api/persona/versions", async () => ({
    ok: true,
    data: store.listPersonaVersions(),
  }));
  app.post("/api/persona/versions", async (request: any) => {
    const body = z.object({ note: z.string().max(200).default("") }).parse(request.body);
    const config = store.getSetting("bot_defaults", botDefaultsFallback);
    const id = store.savePersonaVersion(config, body.note);
    store.audit(`admin:${request.admin.email}`, "persona.version.save", id);
    return { ok: true, data: { id } };
  });
  app.post("/api/persona/versions/:id/restore", async (request: any) => {
    const id = z.string().parse(request.params.id);
    const config = store.getPersonaVersion(id);
    if (!config)
      throw Object.assign(new Error("人格版本不存在"), { statusCode: 404 });
    store.setSetting("bot_defaults", config);
    store.audit(`admin:${request.admin.email}`, "persona.version.restore", id);
    return { ok: true };
  });
}

function registerDiagnosticRoutes(app: any, store: Store) {
  app.get("/api/diagnostics", async (request: any) => {
    const query = z
      .object({
        botId: z.string().optional(),
        groupId: z.string().optional(),
        decision: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(request.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.botId) {
      where.push("t.bot_id=?");
      params.push(query.botId);
    }
    if (query.groupId) {
      where.push("t.group_id=?");
      params.push(query.groupId);
    }
    if (query.decision) {
      where.push("t.decision=?");
      params.push(query.decision);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = store.db
      .prepare(
        `SELECT t.*,b.name bot_name,b.qq,p.name provider_name
         FROM message_traces t JOIN bots b ON b.id=t.bot_id
         LEFT JOIN ai_providers p ON p.id=t.provider_id
         ${clause} ORDER BY t.created_at DESC LIMIT ?`,
      )
      .all(...params, query.limit);
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const counts = store.db
      .prepare(
        `SELECT decision,COUNT(*) count FROM message_traces
         WHERE created_at>=? GROUP BY decision ORDER BY count DESC`,
      )
      .all(cutoff);
    return { ok: true, data: { rows, counts } };
  });

  app.delete("/api/diagnostics", async (request: any) => {
    const deleted = store.db.prepare("DELETE FROM message_traces").run().changes;
    store.audit(`admin:${request.admin.email}`, "diagnostics.clear", undefined, {
      deleted,
    });
    return { ok: true, data: { deleted } };
  });
}

function registerSettingsRoutes(app: any, store: Store) {
  app.get("/api/settings", async () => ({
    ok: true,
    data: store.listSettings(),
  }));
  app.put("/api/settings/:key", async (request: any) => {
    const key = z
      .enum([
        "global_admin_qqs",
        "commands",
        "moderation",
        "bot_defaults",
        "outbound_filter",
      ])
      .parse(request.params.key);
    let value = z.unknown().parse(request.body);
    if (key === "bot_defaults") {
      value = z
        .object({
          persona: z.string().min(1).max(100),
          systemPrompt: z.string().max(10000),
          techPrompt: z.string().max(10000),
          lurkPrompt: z.string().max(10000),
          idlePrompt: z.string().max(10000),
          cooldownMs: z.number().int().min(0).max(3600000),
          maxHistory: z.number().int().min(2).max(100),
          lurkEnabled: z.boolean(),
          lurkMinMessages: z.number().int().min(1).max(20),
          lurkQuietSeconds: z.number().int().min(1).max(60),
          lurkIntervalSeconds: z.number().int().min(5).max(3600),
          idleEnabled: z.boolean(),
          idleAfterMinutes: z.number().int().min(1).max(1440),
          idleMaxAttempts: z.number().int().min(1).max(5),
          activeStartHour: z.number().int().min(0).max(23),
          activeEndHour: z.number().int().min(1).max(24),
          activeTimezone: z.string().min(1).max(100),
          humorLevel: z.number().int().min(1).max(5),
          initiativeLevel: z.number().int().min(1).max(5),
          directnessLevel: z.number().int().min(1).max(5),
          technicalDepth: z.number().int().min(1).max(5),
          answerLength: z.number().int().min(1).max(5),
        })
        .parse(value);
    }
    store.setSetting(key, value);
    store.audit(`admin:${request.admin.email}`, "setting.update", key);
    return { ok: true };
  });
}

function registerLogRoutes(app: any, store: Store, storage: StorageManager) {
  const tableFor = (type: "audit" | "moderation" | "usage") =>
    type === "moderation"
      ? "moderation_events"
      : type === "usage"
        ? "usage_events"
        : "audit_logs";
  app.get("/api/logs", async (request: any) => {
    const query = z
      .object({
        type: z.enum(["audit", "moderation", "usage"]).default("audit"),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(request.query);
    const table = tableFor(query.type);
    return {
      ok: true,
      data: store.db
        .prepare(`SELECT * FROM ${table} ORDER BY created_at DESC LIMIT ?`)
        .all(query.limit),
    };
  });
  app.get("/api/logs/counts", async () => ({
    ok: true,
    data: {
      audit: Number(
        (store.db.prepare("SELECT COUNT(*) count FROM audit_logs").get() as any)
          ?.count || 0,
      ),
      moderation: Number(
        (
          store.db
            .prepare("SELECT COUNT(*) count FROM moderation_events")
            .get() as any
        )?.count || 0,
      ),
      usage: Number(
        (store.db.prepare("SELECT COUNT(*) count FROM usage_events").get() as any)
          ?.count || 0,
      ),
    },
  }));
  app.delete("/api/logs/:type", async (request: any) => {
    const type = z.enum(["audit", "moderation", "usage"]).parse(request.params.type);
    const deleted = store.db.prepare(`DELETE FROM ${tableFor(type)}`).run().changes;
    if (type !== "audit")
      store.audit(`admin:${request.admin.email}`, `logs.${type}.clear`, undefined, {
        deleted,
      });
    return { ok: true, data: { deleted } };
  });
  app.get("/api/storage", async () => ({ ok: true, data: storage.usage() }));
  app.post("/api/storage/cleanup", async (request: any) => {
    const result = storage.cleanup();
    store.audit(`admin:${request.admin.email}`, "storage.cleanup");
    return { ok: true, data: result };
  });
  app.post("/api/storage/backup", async (request: any) => {
    const path = await storage.backup();
    store.audit(`admin:${request.admin.email}`, "storage.backup");
    return { ok: true, data: { file: path.split(/[\\/]/).pop() } };
  });
}
