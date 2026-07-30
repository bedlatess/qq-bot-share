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
    lurkEnabled: true,
    lurkMinMessages: 3,
    lurkQuietSeconds: 3,
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
      lurkEnabled: true,
      lurkMinMessages: 1,
      lurkQuietSeconds: 3,
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
    for (let index = 0; index < 1; index += 1) {
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
    await pipeline.tick(started + 4_000);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, "send_group_msg");
    assert.equal(actions[0].params.message, "自然插话");
    assert.equal(fixture.store.getLicense("bot_1", "group_1")?.usage_count, 1);
  } finally {
    fixture.close();
  }
});

test("disabled proactive replies leave a final diagnostic instead of a queued trace", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false, lurk: true });
    authorizeGroup(fixture.store);
    fixture.store.setSetting(
      "bot_defaults",
      engagementSettings({ lurkEnabled: false }),
    );
    const pipeline = new EventPipeline(
      fixture.store,
      { sendAction: () => undefined } as any,
      { chat: async () => ({ text: "不应调用", providerId: "fake" }) } as any,
      new Moderator(fixture.store, {} as any),
    );

    await pipeline.enqueue("bot_1", "lurk_disabled_1", {
      post_type: "message",
      message_type: "group",
      group_id: "group_1",
      user_id: "10001",
      message_id: 20,
      message: "今晚吃什么",
      sender: { nickname: "小明", role: "member" },
    });

    const trace = fixture.store.db
      .prepare("SELECT decision,reason FROM message_traces WHERE event_id=?")
      .get("lurk_disabled_1") as any;
    assert.equal(trace.decision, "ignored");
    assert.equal(trace.reason, "未触发直接回复，自动接话未启用");
  } finally {
    fixture.close();
  }
});

test("silent proactive decisions close queued diagnostics", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false, lurk: true });
    authorizeGroup(fixture.store);
    fixture.store.setSetting(
      "bot_defaults",
      engagementSettings({ lurkMinMessages: 1 }),
    );
    const actions: unknown[] = [];
    const pool = {
      chat: async () => ({ text: "[[SILENT]]", providerId: "fake" }),
    } as any;
    const pipeline = new EventPipeline(
      fixture.store,
      { sendAction: (_botId: string, action: unknown) => actions.push(action) } as any,
      pool,
      new Moderator(fixture.store, pool),
    );
    const started = Date.now();

    await pipeline.enqueue("bot_1", "lurk_silent_1", {
      post_type: "message",
      message_type: "group",
      group_id: "group_1",
      user_id: "10001",
      message_id: 21,
      message: "今天挺安静",
      sender: { nickname: "小明", role: "member" },
    });
    await pipeline.tick(started + 4_000);

    const trace = fixture.store.db
      .prepare("SELECT decision,reason FROM message_traces WHERE event_id=?")
      .get("lurk_silent_1") as any;
    assert.equal(actions.length, 0);
    assert.equal(trace.decision, "ignored");
    assert.equal(trace.reason, "AI 判断无需接话");
  } finally {
    fixture.close();
  }
});

test("contextual replies preserve group images for vision and follow-up questions", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false, lurk: true, vision: true });
    authorizeGroup(fixture.store);
    fixture.store.setSetting(
      "bot_defaults",
      engagementSettings({ lurkMinMessages: 1, lurkIntervalSeconds: 5 }),
    );
    const calls: any[] = [];
    const actions: any[] = [];
    const pool = {
      chat: async (...args: unknown[]) => {
        calls.push(args);
        return { text: "看到了图片", providerId: "vision" };
      },
    } as any;
    const pipeline = new EventPipeline(
      fixture.store,
      { sendAction: (_botId: string, action: unknown) => actions.push(action) } as any,
      pool,
      new Moderator(fixture.store, pool),
    );
    const started = Date.now();
    await pipeline.enqueue("bot_1", "vision_lurk_1", {
      post_type: "message",
      message_type: "group",
      group_id: "group_1",
      user_id: "10001",
      message_id: 101,
      message: [
        { type: "image", data: { url: "https://example.test/token-usage.png" } },
        { type: "text", data: { text: "这个 token 消耗合理吗" } },
      ],
      sender: { nickname: "主人", role: "owner" },
    });
    await pipeline.tick(started + 4_000);

    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], "vision");
    assert.deepEqual(calls[0][0][1].content.at(-1), {
      type: "image_url",
      image_url: { url: "https://example.test/token-usage.png" },
    });

    await pipeline.enqueue("bot_1", "vision_lurk_2", {
      post_type: "message",
      message_type: "group",
      group_id: "group_1",
      user_id: "10001",
      message_id: 102,
      message: "你看得见这个图片内容吗",
      sender: { nickname: "主人", role: "owner" },
    });
    await pipeline.tick(started + 10_001);

    assert.equal(calls.length, 2);
    assert.equal(calls[1][1], "vision");
    assert.ok(
      calls[1][0][1].content.some(
        (part: any) => part.type === "image_url" && part.image_url.url.includes("token-usage.png"),
      ),
    );
    assert.equal(actions.length, 2);
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

test("balanced moderation skips ordinary chat before calling AI", async () => {
  const fixture = await testStore();
  try {
    fixture.store.setSetting("moderation", {
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
    let calls = 0;
    const pool = {
      chat: async () => {
        calls += 1;
        return {
          text: '{"violation":true,"reason":"推广"}',
          providerId: "fake",
        };
      },
    } as any;
    const moderator = new Moderator(fixture.store, pool);

    assert.equal(
      await moderator.reviewText("这个 Docker 日志应该怎么看？", "bot_1", "group_1"),
      null,
    );
    assert.equal(calls, 0);
    assert.equal(
      await moderator.reviewText("低价代理上车，加我微信 abcdef", "bot_1", "group_1"),
      "推广",
    );
    assert.equal(calls, 1);
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
    assert.match(systemPrompt, /你叫“小泡”/);
    assert.match(systemPrompt, /内部身份约束/);
    assert.match(systemPrompt, /机器人专属基础人格/);
    assert.match(systemPrompt, /技术附加规则/);
  } finally {
    fixture.close();
  }
});

test("conversation memory and diagnostics survive pipeline recreation", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false, tech: true });
    authorizeGroup(fixture.store);
    fixture.store.setSetting("bot_defaults", engagementSettings({ maxHistory: 10 }));
    const calls: any[][] = [];
    const pool = {
      chat: async (messages: any[]) => {
        calls.push(messages);
        return {
          text: calls.length === 1 ? "先检查 Docker 日志" : "继续检查端口映射",
          providerId: "fake",
          latencyMs: 120,
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        };
      },
    } as any;
    const hub = { sendAction: () => undefined } as any;
    const send = (pipeline: EventPipeline, id: string, text: string) =>
      pipeline.enqueue("bot_1", id, {
        post_type: "message",
        message_type: "group",
        group_id: "group_1",
        user_id: "10001",
        message_id: id,
        message: text,
        sender: { nickname: "测试成员", role: "member" },
      });

    const first = new EventPipeline(
      fixture.store,
      hub,
      pool,
      new Moderator(fixture.store, pool),
    );
    await send(first, "memory_1", "Docker 怎么检查启动错误");
    await first.tick(Date.now() + 20_000);
    assert.equal(calls.length, 1);

    const recreated = new EventPipeline(
      fixture.store,
      hub,
      pool,
      new Moderator(fixture.store, pool),
    );
    await send(recreated, "memory_2", "Docker 这个问题怎么继续排查");

    assert.equal(calls.length, 2);
    assert.ok(
      calls[1].some(
        (item) => item.role === "assistant" && item.content === "先检查 Docker 日志",
      ),
    );
    const traces = fixture.store.db
      .prepare(
        "SELECT event_id,decision,provider_id,latency_ms FROM message_traces ORDER BY created_at",
      )
      .all() as any[];
    assert.deepEqual(
      traces.map((item) => [item.event_id, item.decision, item.provider_id]),
      [
        ["memory_1", "replied", "fake"],
        ["memory_2", "replied", "fake"],
      ],
    );
    assert.equal(traces[0].latency_ms, 120);
  } finally {
    fixture.close();
  }
});

test("custom replies support scoped templates without calling AI", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false });
    authorizeGroup(fixture.store);
    const now = new Date().toISOString();
    fixture.store.db
      .prepare(
        `INSERT INTO custom_commands
        (id,bot_id,group_id,trigger_text,response_text,match_mode,enabled,created_at,updated_at)
        VALUES ('cmd_1','bot_1','group_1','群规','{user}，群规在群公告。','exact',1,?,?)`,
      )
      .run(now, now);
    let aiCalls = 0;
    const pool = {
      chat: async () => {
        aiCalls += 1;
        return { text: "不应调用", providerId: "fake" };
      },
    } as any;
    const actions: any[] = [];
    const pipeline = new EventPipeline(
      fixture.store,
      { sendAction: (_botId: string, action: unknown) => actions.push(action) } as any,
      pool,
      new Moderator(fixture.store, pool),
    );

    await pipeline.enqueue("bot_1", "custom_1", {
      post_type: "message",
      message_type: "group",
      group_id: "group_1",
      user_id: "10001",
      message_id: 10,
      message: "群规",
      sender: { nickname: "小明", role: "member" },
    });

    assert.equal(aiCalls, 0);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].params.message[1].data.text, " 小明，群规在群公告。");
    assert.equal(fixture.store.getLicense("bot_1", "group_1")?.usage_count, 0);
  } finally {
    fixture.close();
  }
});

test("status, quota, and help commands use readable structured replies", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false });
    authorizeGroup(fixture.store);
    const now = new Date().toISOString();
    fixture.store.db
      .prepare(
        `INSERT INTO custom_commands
        (id,bot_id,group_id,trigger_text,response_text,match_mode,enabled,created_at,updated_at)
        VALUES ('cmd_help','bot_1','group_1','群规','查看群公告','exact',1,?,?)`,
      )
      .run(now, now);
    const actions: any[] = [];
    const pool = {} as any;
    const pipeline = new EventPipeline(
      fixture.store,
      { sendAction: (_botId: string, action: unknown) => actions.push(action) } as any,
      pool,
      new Moderator(fixture.store, pool),
    );
    const send = (id: string, message: string) =>
      pipeline.enqueue("bot_1", id, {
        post_type: "message",
        message_type: "group",
        group_id: "group_1",
        user_id: "10001",
        message_id: Number(id.slice(-1)),
        message,
        sender: { nickname: "小明", role: "member" },
      });

    await send("command_1", "/授权状态");
    await send("command_2", "/剩余额度");
    await send("command_3", "/帮助");

    assert.match(actions[0].params.message[1].data.text, /授权信息\n状态：正常/);
    assert.match(actions[0].params.message[1].data.text, /套餐：默认专业版/);
    assert.match(actions[1].params.message[1].data.text, /本月额度\n剩余：3000 次/);
    assert.match(actions[2].params.message[1].data.text, /可用指令\n\/授权状态/);
    assert.match(actions[2].params.message[1].data.text, /自定义命令\n- 群规/);
  } finally {
    fixture.close();
  }
});

test("failed AI calls do not consume group quota", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false, chat: true });
    authorizeGroup(fixture.store);
    fixture.store.setSetting("bot_defaults", engagementSettings());
    const pool = {
      chat: async () => {
        throw new Error("全部模型网关失败");
      },
    } as any;
    const actions: any[] = [];
    const pipeline = new EventPipeline(
      fixture.store,
      { sendAction: (_botId: string, action: unknown) => actions.push(action) } as any,
      pool,
      new Moderator(fixture.store, pool),
    );

    await pipeline.enqueue("bot_1", "failed_ai_1", {
      post_type: "message",
      message_type: "group",
      group_id: "group_1",
      user_id: "10001",
      message_id: 11,
      message: [{ type: "at", data: { qq: "123456789" } }, { type: "text", data: { text: "在吗" } }],
      sender: { nickname: "小明", role: "member" },
    });

    assert.equal(actions.length, 1);
    assert.match(actions[0].params.message[1].data.text, /全部模型网关失败/);
    assert.equal(fixture.store.getLicense("bot_1", "group_1")?.usage_count, 0);
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
    await pipeline.tick(started + 70_001);
    assert.equal(actions.length, 1);
    assert.equal(
      fixture.store.getGroupEngagement("bot_1", "group_1")?.idle_attempts,
      1,
    );
    await pipeline.tick(started + 140_002);
    assert.equal(actions.length, 2);
    assert.equal(
      fixture.store.getGroupEngagement("bot_1", "group_1")?.dormant,
      1,
    );
    await pipeline.tick(started + 210_003);
    assert.equal(actions.length, 2);

    fixture.store.recordHumanActivity(
      "bot_1",
      "group_1",
      new Date(started + 210_004),
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
