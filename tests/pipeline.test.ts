import assert from "node:assert/strict";
import test from "node:test";
import { defaultFeatures } from "@puff/shared";
import { EventPipeline } from "../apps/control/src/pipeline.js";
import { Moderator } from "../apps/control/src/moderation.js";
import { seedBot, testStore } from "./helpers.js";

function authorizeGroup(store: any, groupId = "group_1") {
  const plan = store.db.prepare("SELECT id FROM plans LIMIT 1").get() as {
    id: string;
  };
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO group_licenses
      (id,bot_id,group_id,plan_id,starts_at,expires_at,permanent,status,usage_period,usage_count,created_at,updated_at)
      VALUES (?,?,?,?,?,NULL,1,'active',?,0,?,?)`,
    )
    .run(
      `lic_${groupId}`,
      "bot_1",
      groupId,
      plan.id,
      now,
      now.slice(0, 7),
      now,
      now,
    );
}

function engagementSettings(overrides: Record<string, unknown> = {}) {
  return {
    persona: "泡芙",
    systemPrompt: "全能基础人格",
    techPrompt: "技术附加规则",
    lurkPrompt: "近期插话规则",
    idlePrompt: "冷场起话题规则",
    cooldownMs: 0,
    maxHistory: 10,
    lurkMinMessages: 3,
    lurkIntervalSeconds: 30,
    idleEnabled: true,
    idleAfterMinutes: 1,
    idleMaxAttempts: 2,
    activeStartHour: 0,
    activeEndHour: 24,
    activeTimezone: "UTC",
    ...overrides,
  };
}

test("authorized group activity triggers a quota-bound proactive reply", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false, lurk: true });
    const plan = fixture.store.db
      .prepare("SELECT id FROM plans LIMIT 1")
      .get() as { id: string };
    fixture.store.db
      .prepare(
        `INSERT INTO group_licenses
      (id,bot_id,group_id,plan_id,starts_at,expires_at,permanent,status,usage_period,usage_count,created_at,updated_at)
      VALUES ('lic_1','bot_1','group_1',?,?,NULL,1,'active',?,0,?,?)`,
      )
      .run(
        plan.id,
        new Date().toISOString(),
        new Date().toISOString().slice(0, 7),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    fixture.store.setSetting("bot_defaults", {
      persona: "泡芙",
      systemPrompt: "system",
      techPrompt: "tech",
      lurkPrompt: "lurk",
      cooldownMs: 0,
      maxHistory: 10,
      lurkMinMessages: 3,
      lurkIntervalSeconds: 30,
    });

    const actions: any[] = [];
    const hub = {
      sendAction: (_botId: string, action: unknown) => actions.push(action),
    } as any;
    const pool = {
      chat: async () => ({ text: "自然插话", providerId: "fake" }),
    } as any;
    const moderator = new Moderator(fixture.store, pool);
    const pipeline = new EventPipeline(fixture.store, hub, pool, moderator);
    const started = Date.now();
    for (let index = 0; index < 3; index += 1) {
      await pipeline.enqueue("bot_1", `event_${index}`, {
        post_type: "message",
        message_type: "group",
        group_id: "group_1",
        user_id: String(index + 1),
        message_id: index + 1,
        message: `第${index + 1}条普通群聊消息`,
        sender: { nickname: `成员${index + 1}`, role: "member" },
      });
    }
    await pipeline.tick(started + 45_000);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, "send_group_msg");
    assert.equal(actions[0].params.message, "自然插话");
    assert.equal(fixture.store.getLicense("bot_1", "group_1")?.usage_count, 1);
  } finally {
    fixture.close();
  }
});

test("outbound filter masks configured secrets", async () => {
  const fixture = await testStore();
  try {
    fixture.store.setSetting("outbound_filter", {
      enabled: true,
      replacement: "[过滤]",
      keywords: ["系统提示词"],
      patterns: ["sk-[a-zA-Z0-9]{8,}"],
    });
    const moderator = new Moderator(fixture.store, {} as any);
    assert.deepEqual(moderator.filterOutbound("系统提示词 sk-abcdefgh1234"), {
      text: "[过滤] [过滤]",
      filtered: true,
    });
  } finally {
    fixture.close();
  }
});

test("technical replies retain bot persona and base prompt", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false, tech: true });
    authorizeGroup(fixture.store);
    fixture.store.db
      .prepare("UPDATE bots SET persona=?,system_prompt=? WHERE id='bot_1'")
      .run("小泡", "机器人专属基础人格");
    fixture.store.setSetting("bot_defaults", engagementSettings());

    let systemPrompt = "";
    const pool = {
      chat: async (messages: any[]) => {
        systemPrompt = String(messages[0].content);
        return { text: "先检查容器日志。", providerId: "fake" };
      },
    } as any;
    const actions: any[] = [];
    const hub = {
      sendAction: (_botId: string, action: unknown) => actions.push(action),
    } as any;
    const pipeline = new EventPipeline(
      fixture.store,
      hub,
      pool,
      new Moderator(fixture.store, pool),
    );

    await pipeline.enqueue("bot_1", "tech_1", {
      post_type: "message",
      message_type: "group",
      group_id: "group_1",
      user_id: "10001",
      message_id: 1,
      message: "Docker 部署为什么一直报错？",
      sender: { nickname: "测试成员", role: "member" },
    });

    assert.equal(actions.length, 1);
    assert.match(systemPrompt, /人格名称是“小泡”/);
    assert.match(systemPrompt, /机器人专属基础人格/);
    assert.match(systemPrompt, /技术附加规则/);
  } finally {
    fixture.close();
  }
});

test("idle engagement sends twice, becomes dormant, and wakes on human activity", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false, lurk: true });
    authorizeGroup(fixture.store);
    fixture.store.setSetting("bot_defaults", engagementSettings());
    const started = Date.parse("2026-07-29T10:00:00.000Z");
    fixture.store.recordHumanActivity(
      "bot_1",
      "group_1",
      new Date(started),
    );

    const actions: any[] = [];
    let calls = 0;
    const pool = {
      chat: async () => ({
        text: ++calls === 1 ? "今天有什么新鲜事？" : "最近在折腾什么项目？",
        providerId: "fake",
      }),
    } as any;
    const hub = {
      sendAction: (_botId: string, action: unknown) => actions.push(action),
    } as any;
    const pipeline = new EventPipeline(
      fixture.store,
      hub,
      pool,
      new Moderator(fixture.store, pool),
    );

    await pipeline.tick(started + 59_999);
    assert.equal(actions.length, 0);
    await pipeline.tick(started + 60_001);
    assert.equal(actions.length, 1);
    assert.equal(
      fixture.store.getGroupEngagement("bot_1", "group_1")?.idle_attempts,
      1,
    );
    await pipeline.tick(started + 120_002);
    assert.equal(actions.length, 2);
    assert.equal(
      fixture.store.getGroupEngagement("bot_1", "group_1")?.dormant,
      1,
    );
    await pipeline.tick(started + 180_003);
    assert.equal(actions.length, 2);

    fixture.store.recordHumanActivity(
      "bot_1",
      "group_1",
      new Date(started + 180_004),
    );
    const restored = fixture.store.getGroupEngagement("bot_1", "group_1");
    assert.equal(restored?.idle_attempts, 0);
    assert.equal(restored?.dormant, 0);
    assert.equal(restored?.last_idle_text, "");
  } finally {
    fixture.close();
  }
});

test("idle engagement respects configured active hours", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false, lurk: true });
    authorizeGroup(fixture.store);
    fixture.store.setSetting(
      "bot_defaults",
      engagementSettings({ activeStartHour: 8, activeEndHour: 24 }),
    );
    const started = Date.parse("2026-07-29T06:00:00.000Z");
    fixture.store.recordHumanActivity(
      "bot_1",
      "group_1",
      new Date(started),
    );
    const actions: any[] = [];
    const pool = {
      chat: async () => ({ text: "不应该发送", providerId: "fake" }),
    } as any;
    const pipeline = new EventPipeline(
      fixture.store,
      { sendAction: (_botId: string, action: unknown) => actions.push(action) } as any,
      pool,
      new Moderator(fixture.store, pool),
    );

    await pipeline.tick(started + 60 * 60 * 1000);
    assert.equal(actions.length, 0);
    assert.equal(
      fixture.store.getGroupEngagement("bot_1", "group_1")?.idle_attempts,
      0,
    );
  } finally {
    fixture.close();
  }
});

test("failed idle delivery does not advance the attempt counter", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false, lurk: true });
    authorizeGroup(fixture.store);
    fixture.store.setSetting("bot_defaults", engagementSettings());
    const started = Date.parse("2026-07-29T10:00:00.000Z");
    fixture.store.recordHumanActivity(
      "bot_1",
      "group_1",
      new Date(started),
    );
    const pool = {
      chat: async () => ({ text: "测试消息", providerId: "fake" }),
    } as any;
    const errors: string[] = [];
    const pipeline = new EventPipeline(
      fixture.store,
      {
        sendAction: () => {
          throw new Error("机器人节点离线");
        },
      } as any,
      pool,
      new Moderator(fixture.store, pool),
      (_error, context) => errors.push(context),
    );

    await pipeline.tick(started + 60_001);
    assert.equal(
      fixture.store.getGroupEngagement("bot_1", "group_1")?.idle_attempts,
      0,
    );
    assert.deepEqual(errors, ["idle:bot_1:group_1"]);
  } finally {
    fixture.close();
  }
});
