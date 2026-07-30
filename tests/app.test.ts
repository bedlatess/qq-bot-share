import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../apps/control/src/app.js";

test("admin login, CSRF protection and node creation work through HTTP API", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "puff-app-test-"));
  const app = await buildApp({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    publicDir: join(dataDir, "missing-public"),
    publicUrl: "http://127.0.0.1:17866",
    adminEmail: "admin@example.com",
    adminPassword: "test-password-123",
    sessionSecret: "session-secret-at-least-32-characters",
    masterKey: "master-secret-at-least-32-characters",
    storageLimitBytes: 100 * 1024 * 1024,
    logLevel: "silent",
    isProduction: false,
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "test-password-123" },
    });
    assert.equal(login.statusCode, 200);
    const loginBody = login.json();
    const cookie = login.headers["set-cookie"]?.split(";")[0];
    assert.ok(cookie);
    assert.ok(loginBody.csrf);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/nodes",
      headers: { cookie },
      payload: { name: "节点A" },
    });
    assert.equal(rejected.statusCode, 403);
    const created = await app.inject({
      method: "POST",
      url: "/api/nodes",
      headers: { cookie, "x-csrf-token": loginBody.csrf },
      payload: { name: "节点A" },
    });
    assert.equal(created.statusCode, 200);
    assert.match(created.json().data.nodeToken, /^[A-Za-z0-9_-]{20,}$/);

    const nodes = await app.inject({
      method: "GET",
      url: "/api/nodes",
      headers: { cookie },
    });
    assert.equal(nodes.json().data.length, 1);
    assert.ok(created.json().data.nodeId);
    assert.ok(created.json().data.nodeToken);
    assert.equal(created.json().data.id, undefined);

    app.puff.store.db
      .prepare("UPDATE nodes SET status='online',last_seen_at=?")
      .run(new Date(Date.now() - 60_000).toISOString());
    const staleDashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie },
    });
    assert.equal(staleDashboard.json().data.nodes.online, 0);
    app.puff.store.db
      .prepare("UPDATE nodes SET last_seen_at=?")
      .run(new Date().toISOString());
    const freshDashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie },
    });
    assert.equal(freshDashboard.json().data.nodes.online, 1);

    const bot = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers: { cookie, "x-csrf-token": loginBody.csrf },
      payload: {
        nodeId: created.json().data.nodeId,
        qq: "123456789",
        name: "测试机器人",
      },
    });
    assert.equal(bot.statusCode, 200);
    const custom = await app.inject({
      method: "POST",
      url: "/api/custom-commands",
      headers: { cookie, "x-csrf-token": loginBody.csrf },
      payload: {
        botId: bot.json().data.id,
        groupId: null,
        trigger: "群规",
        response: "请看群公告",
        matchMode: "exact",
        enabled: true,
      },
    });
    assert.equal(custom.statusCode, 200);
    const customRows = await app.inject({
      method: "GET",
      url: "/api/custom-commands",
      headers: { cookie },
    });
    assert.equal(customRows.json().data.length, 1);
    assert.equal(customRows.json().data[0].trigger_text, "群规");

    app.puff.store.recordUsage({
      botId: bot.json().data.id,
      groupId: "10001",
      providerId: "provider_1",
      kind: "chat",
      inputTokens: 120,
      outputTokens: 30,
      latencyMs: 850,
    });
    app.puff.store.recordUsage({
      botId: bot.json().data.id,
      groupId: "10001",
      providerId: "provider_1",
      kind: "lurk",
      inputTokens: 80,
      outputTokens: 20,
      latencyMs: 1150,
    });
    const usageDashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie },
    });
    assert.equal(usageDashboard.json().data.usage.total, 2);
    assert.equal(usageDashboard.json().data.usage.inputTokens, 200);
    assert.equal(usageDashboard.json().data.usage.outputTokens, 50);
    assert.equal(usageDashboard.json().data.usage.averageLatencyMs, 1000);

    const logCounts = await app.inject({
      method: "GET",
      url: "/api/logs/counts",
      headers: { cookie },
    });
    assert.equal(logCounts.json().data.usage, 2);
    const clearedUsage = await app.inject({
      method: "DELETE",
      url: "/api/logs/usage",
      headers: { cookie, "x-csrf-token": loginBody.csrf },
    });
    assert.equal(clearedUsage.json().data.deleted, 2);
    const dashboardAfterClear = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie },
    });
    assert.equal(dashboardAfterClear.json().data.usage.total, 2);
    assert.equal(dashboardAfterClear.json().data.usage.today, 0);

    const clearedAudit = await app.inject({
      method: "DELETE",
      url: "/api/logs/audit",
      headers: { cookie, "x-csrf-token": loginBody.csrf },
    });
    assert.ok(clearedAudit.json().data.deleted > 0);
    const countsAfterClear = await app.inject({
      method: "GET",
      url: "/api/logs/counts",
      headers: { cookie },
    });
    assert.equal(countsAfterClear.json().data.audit, 0);
    assert.equal(countsAfterClear.json().data.usage, 0);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
