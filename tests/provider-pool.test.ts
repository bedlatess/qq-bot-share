import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { nowIso } from "@puff/shared";
import {
  chatRequestPolicy,
  ProviderPool,
} from "../apps/control/src/provider-pool.js";
import { encryptSecret } from "../apps/control/src/security.js";
import { seedBot, testStore } from "./helpers.js";

test("chat request policy keeps short replies fast without truncating technical answers", () => {
  assert.deepEqual(chatRequestPolicy("lurk", 30_000), {
    maxTokens: 256,
    temperature: 0.75,
    timeoutMs: 6_000,
  });
  assert.deepEqual(chatRequestPolicy("chat", 30_000), {
    maxTokens: 512,
    temperature: 0.75,
    timeoutMs: 6_000,
  });
  assert.deepEqual(chatRequestPolicy("tech", 30_000), {
    maxTokens: 2_048,
    temperature: 0.35,
    timeoutMs: 30_000,
  });
});

test("provider pool fails over in priority order and records health", async () => {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/bad/")) {
      response.writeHead(503, { "content-type": "text/plain" }).end("down");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        choices: [{ message: { content: "fallback-ok" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing test server address");
  const fixture = await testStore();
  try {
    seedBot(fixture.store);
    const now = nowIso();
    const insert = fixture.store.db.prepare(`INSERT INTO ai_providers
      (id,name,base_url,api_key_enc,model,priority,timeout_ms,capabilities_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    insert.run(
      "bad",
      "故障网关",
      `http://127.0.0.1:${address.port}/bad`,
      encryptSecret("key-1", "master"),
      "gpt-test",
      1,
      2000,
      '{"text":true,"vision":false,"image":false}',
      now,
      now,
    );
    insert.run(
      "good",
      "备用网关",
      `http://127.0.0.1:${address.port}/good`,
      encryptSecret("key-2", "master"),
      "gpt-test",
      2,
      2000,
      '{"text":true,"vision":false,"image":false}',
      now,
      now,
    );

    const pool = new ProviderPool(fixture.store, "master");
    const result = await pool.chat(
      [{ role: "user", content: "hello" }],
      "text",
      { botId: "bot_1", groupId: "group_1", kind: "chat" },
    );
    assert.equal(result.text, "fallback-ok");
    assert.equal(result.providerId, "good");
    const health = fixture.store.db
      .prepare(
        "SELECT id,health_status,failure_count FROM ai_providers ORDER BY priority",
      )
      .all() as any[];
    assert.deepEqual(
      health.map((item) => [item.id, item.health_status, item.failure_count]),
      [
        ["bad", "unhealthy", 1],
        ["good", "healthy", 0],
      ],
    );
    assert.equal(
      (
        fixture.store.db
          .prepare("SELECT COUNT(*) count FROM usage_events")
          .get() as any
      ).count,
      1,
    );
  } finally {
    fixture.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
