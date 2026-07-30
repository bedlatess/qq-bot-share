import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PUFF_VERSION } from "@puff/shared";
import { buildApp } from "../apps/control/src/app.js";
import { encryptSecret } from "../apps/control/src/security.js";

test("admin login, CSRF protection and node creation work through HTTP API", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "puff-app-test-"));
  const agentBundlePath = join(dataDir, "agent-bundle.tar.gz");
  writeFileSync(agentBundlePath, "test-agent-bundle");
  const app = await buildApp({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    publicDir: join(dataDir, "missing-public"),
    agentBundlePath,
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

    const agentBundle = await app.inject({
      method: "GET",
      url: `/agent-update?nodeId=${created.json().data.nodeId}`,
      headers: { authorization: `Bearer ${created.json().data.nodeToken}` },
    });
    assert.equal(agentBundle.statusCode, 200);
    assert.equal(agentBundle.body, "test-agent-bundle");
    assert.equal(agentBundle.headers["x-puff-version"], PUFF_VERSION);
    assert.equal(
      agentBundle.headers["x-puff-sha256"],
      createHash("sha256").update("test-agent-bundle").digest("hex"),
    );
    const rejectedAgentBundle = await app.inject({
      method: "GET",
      url: `/agent-update?nodeId=${created.json().data.nodeId}`,
    });
    assert.equal(rejectedAgentBundle.statusCode, 404);

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

    app.puff.store.syncBotGroups(bot.json().data.id, [
      {
        group_id: "10001",
        group_name: "测试群",
        member_count: 28,
        max_member_count: 200,
        role: "admin",
      },
    ]);
    const groups = await app.inject({
      method: "GET",
      url: "/api/groups",
      headers: { cookie },
    });
    assert.equal(groups.statusCode, 200);
    assert.equal(groups.json().data[0].group_name, "测试群");
    assert.equal(groups.json().data[0].member_count, 28);

    const groupPolicy = await app.inject({
      method: "PUT",
      url: "/api/group-policies",
      headers: { cookie, "x-csrf-token": loginBody.csrf },
      payload: {
        botId: bot.json().data.id,
        groupId: "10001",
        mode: "active",
        personaOverride: "优先讨论工程实践",
        settings: { initiativeLevel: 5, lurkQuietSeconds: 2, cooldownMs: 0 },
      },
    });
    assert.equal(groupPolicy.statusCode, 200);
    const policies = await app.inject({
      method: "GET",
      url: "/api/group-policies",
      headers: { cookie },
    });
    assert.equal(policies.json().data[0].mode, "active");
    assert.equal(policies.json().data[0].settings.initiativeLevel, 5);
    assert.equal(policies.json().data[0].settings.cooldownMs, 0);

    const memory = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers: { cookie, "x-csrf-token": loginBody.csrf },
      payload: {
        botId: bot.json().data.id,
        groupId: "10001",
        userId: "20001",
        content: "服务器使用 Debian 12",
      },
    });
    assert.equal(memory.statusCode, 200);
    const memoryRows = await app.inject({
      method: "GET",
      url: "/api/memories?userId=20001",
      headers: { cookie },
    });
    assert.equal(memoryRows.json().data.length, 1);

    const providerNow = new Date().toISOString();
    app.puff.store.db
      .prepare(
        `INSERT INTO ai_providers
         (id,name,base_url,api_key_enc,model,priority,timeout_ms,capabilities_json,created_at,updated_at)
         VALUES (?,?,?,?,?,1,5000,?,?,?)`,
      )
      .run(
        "persona_provider",
        "人格测试网关",
        "https://provider.test",
        encryptSecret("test-key", "master-secret-at-least-32-characters"),
        "gpt-test",
        JSON.stringify({ text: true, vision: false, image: false }),
        providerNow,
        providerNow,
      );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "这是人格预览回复" } }],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const preview = await app.inject({
        method: "POST",
        url: "/api/persona/preview",
        headers: { cookie, "x-csrf-token": loginBody.csrf },
        payload: {
          botId: bot.json().data.id,
          groupId: "10001",
          userId: "20001",
          message: "解释一下部署问题",
          technical: true,
        },
      });
      assert.equal(preview.statusCode, 200);
      assert.equal(preview.json().data.reply, "这是人格预览回复");
      assert.ok(
        preview.json().data.layers.some((layer: any) => layer.key === "memories"),
      );
      assert.equal(
        Object.hasOwn(preview.json().data.layers[0], "content"),
        false,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const resetPolicy = await app.inject({
      method: "DELETE",
      url: `/api/group-policies/${bot.json().data.id}/10001`,
      headers: { cookie, "x-csrf-token": loginBody.csrf },
    });
    assert.equal(resetPolicy.statusCode, 200);
    assert.equal(resetPolicy.json().data.deleted, 1);
    const resetPolicies = await app.inject({
      method: "GET",
      url: "/api/group-policies",
      headers: { cookie },
    });
    assert.equal(resetPolicies.json().data[0].mode, "balanced");
    assert.deepEqual(resetPolicies.json().data[0].settings, {});

    const traceId = app.puff.store.createMessageTrace({
      eventId: "event-diagnostic-1",
      botId: bot.json().data.id,
      groupId: "10001",
      userId: "20001",
      excerpt: "机器人为什么没回复",
    });
    app.puff.store.updateMessageTrace(traceId, "ignored", "群未授权");
    const diagnostics = await app.inject({
      method: "GET",
      url: "/api/diagnostics?decision=ignored",
      headers: { cookie },
    });
    assert.equal(diagnostics.statusCode, 200);
    assert.equal(diagnostics.json().data.rows[0].reason, "群未授权");

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
    assert.equal(usageDashboard.json().data.usage.total, 3);
    assert.equal(usageDashboard.json().data.usage.inputTokens, 220);
    assert.equal(usageDashboard.json().data.usage.outputTokens, 58);
    assert.ok(usageDashboard.json().data.usage.averageLatencyMs >= 600);
    assert.ok(usageDashboard.json().data.usage.averageLatencyMs <= 1000);

    const logCounts = await app.inject({
      method: "GET",
      url: "/api/logs/counts",
      headers: { cookie },
    });
    assert.equal(logCounts.json().data.usage, 3);
    const clearedUsage = await app.inject({
      method: "DELETE",
      url: "/api/logs/usage",
      headers: { cookie, "x-csrf-token": loginBody.csrf },
    });
    assert.equal(clearedUsage.json().data.deleted, 3);
    const dashboardAfterClear = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie },
    });
    assert.equal(dashboardAfterClear.json().data.usage.total, 3);
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
