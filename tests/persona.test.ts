import assert from "node:assert/strict";
import test from "node:test";
import { EventPipeline } from "../apps/control/src/pipeline.js";
import { Moderator } from "../apps/control/src/moderation.js";
import { botDefaultsFallback } from "../apps/control/src/bot-defaults.js";
import { compilePersona } from "../apps/control/src/persona-engine.js";
import { seedBot, testStore } from "./helpers.js";

function authorize(store: any, groupId = "10001") {
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
    .run("lic_persona", "bot_1", groupId, plan.id, now, now.slice(0, 7), now, now);
}

test("persona compiler keeps identity, tuning, group and memory layers ordered", () => {
  const compiled = compilePersona({
    bot: { persona: "泡芙", system_prompt: "机器人专属规则" },
    defaults: { ...botDefaultsFallback, humorLevel: 5, directnessLevel: 5 },
    groupMode: "active",
    groupPersona: "这个群偏技术讨论",
    memories: [{ content: "用户使用 Debian 12" }],
    modePrompt: "当前按技术问题回答",
  });
  assert.deepEqual(
    compiled.layers.map((layer) => layer.key),
    [
      "identity",
      "style",
      "rules",
      "global",
      "bot",
      "group-mode",
      "group-persona",
      "memories",
      "task-mode",
    ],
  );
  assert.match(compiled.prompt, /长期在线/);
  assert.match(compiled.prompt, /Debian 12/);
  assert.match(compiled.prompt, /活跃模式/);
  assert.equal(compiled.tuning.humorLevel, 5);
});

test("group policies and long-term memories persist and remain independently manageable", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store);
    fixture.store.syncBotGroups("bot_1", [
      { group_id: "10001", group_name: "测试群", member_count: 8 },
    ]);
    fixture.store.setGroupPolicy({
      botId: "bot_1",
      groupId: "10001",
      mode: "active",
      personaOverride: "多聊工程实践",
      settings: { initiativeLevel: 5, lurkQuietSeconds: 2 },
    });
    assert.equal(fixture.store.getGroupPolicy("bot_1", "10001")?.mode, "active");
    assert.equal(
      fixture.store.getGroupPolicy("bot_1", "10001")?.settings.initiativeLevel,
      5,
    );

    const id = fixture.store.addUserMemory({
      botId: "bot_1",
      groupId: "10001",
      userId: "20001",
      content: "我主要使用 TypeScript",
    });
    fixture.store.addUserMemory({
      botId: "bot_1",
      groupId: "10001",
      userId: "20001",
      content: "服务器是 Debian 12",
    });
    assert.equal(fixture.store.listUserMemories({ userId: "20001" }).length, 2);
    assert.equal(
      fixture.store.forgetUserMemories({
        botId: "bot_1",
        groupId: "10001",
        userId: "20001",
        query: "Debian",
      }),
      1,
    );
    assert.equal(fixture.store.deleteUserMemory(id), 1);
  } finally {
    fixture.close();
  }
});

test("authorized users can remember, list and forget without mentioning the bot", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false });
    authorize(fixture.store);
    const actions: any[] = [];
    const hub = {
      sendAction: (_botId: string, action: unknown) => actions.push(action),
    } as any;
    const pool = { chat: async () => ({ text: "unused", providerId: "fake" }) } as any;
    const pipeline = new EventPipeline(
      fixture.store,
      hub,
      pool,
      new Moderator(fixture.store, pool),
    );
    const event = (id: number, message: string) => ({
      post_type: "message",
      message_type: "group",
      group_id: "10001",
      user_id: "20001",
      message_id: id,
      message,
      sender: { nickname: "小明", role: "member" as const },
    });

    await pipeline.enqueue("bot_1", "memory_add", event(1, "记住：我喜欢简洁回答"));
    await pipeline.enqueue("bot_1", "memory_list", event(2, "你记得我什么"));
    await pipeline.enqueue("bot_1", "memory_forget", event(3, "忘掉：简洁回答"));
    await pipeline.enqueue("bot_1", "memory_plain", event(4, "记住今天发布了新版本"));

    assert.equal(actions.length, 3);
    assert.match(actions[1].params.message[1].data.text, /喜欢简洁回答/);
    assert.equal(fixture.store.listUserMemories({ userId: "20001" }).length, 0);
    const traces = fixture.store.db
      .prepare("SELECT event_id,decision FROM message_traces")
      .all() as Array<{ event_id: string; decision: string }>;
    assert.deepEqual(
      Object.fromEntries(traces.map((trace) => [trace.event_id, trace.decision])),
      {
        memory_add: "memory",
        memory_list: "memory",
        memory_forget: "memory",
        memory_plain: "queued",
      },
    );
  } finally {
    fixture.close();
  }
});

test("direct replies cannot race with proactive lurk replies", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false, chat: true, lurk: true });
    authorize(fixture.store);
    fixture.store.setSetting("bot_defaults", {
      ...botDefaultsFallback,
      cooldownMs: 0,
      lurkEnabled: true,
      lurkMinMessages: 1,
      lurkQuietSeconds: 1,
    });
    let release!: (value: any) => void;
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    const pool = {
      chat: async () => {
        calls += 1;
        started();
        return await new Promise((resolve) => { release = resolve; });
      },
    } as any;
    const actions: any[] = [];
    const pipeline = new EventPipeline(
      fixture.store,
      { sendAction: (_botId: string, action: unknown) => actions.push(action) } as any,
      pool,
      new Moderator(fixture.store, pool),
    );
    const processing = pipeline.enqueue("bot_1", "race_direct", {
      post_type: "message",
      message_type: "group",
      group_id: "10001",
      user_id: "20001",
      message_id: 20,
      message: "为什么 Docker 启动失败？",
      sender: { nickname: "小明", role: "member" },
    });
    await modelStarted;
    await pipeline.tick(Date.now() + 5_000);
    assert.equal(calls, 1);
    assert.equal(actions.length, 0);
    release({ text: "先看容器日志。", providerId: "fake" });
    await processing;
    assert.equal(calls, 1);
    assert.equal(actions.length, 1);
  } finally {
    fixture.close();
  }
});

test("active mode uses intent scoring and group cooldown overrides", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false, chat: true, lurk: true });
    authorize(fixture.store);
    fixture.store.setSetting("bot_defaults", {
      ...botDefaultsFallback,
      cooldownMs: 60_000,
      lurkEnabled: false,
    });
    fixture.store.setGroupPolicy({
      botId: "bot_1",
      groupId: "10001",
      mode: "active",
      settings: { cooldownMs: 0, lurkEnabled: false },
    });
    let calls = 0;
    const actions: any[] = [];
    const pool = {
      chat: async () => ({ text: `回答${++calls}`, providerId: "fake" }),
    } as any;
    const pipeline = new EventPipeline(
      fixture.store,
      { sendAction: (_botId: string, action: unknown) => actions.push(action) } as any,
      pool,
      new Moderator(fixture.store, pool),
    );
    const send = (id: number, message: string) => pipeline.enqueue("bot_1", `score_${id}`, {
      post_type: "message",
      message_type: "group",
      group_id: "10001",
      user_id: "20001",
      message_id: id,
      message,
      sender: { nickname: "小明", role: "member" },
    });
    await send(1, "今天的天气真不错。");
    await send(2, "为什么今天这么热？");
    await send(3, "怎么判断明天会不会下雨？");
    assert.equal(calls, 2);
    assert.equal(actions.length, 2);
  } finally {
    fixture.close();
  }
});

test("balanced groups answer clear contextual questions directly and inject user memory", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store, { moderation: false, chat: true, tech: true });
    authorize(fixture.store);
    fixture.store.setSetting("bot_defaults", {
      ...botDefaultsFallback,
      cooldownMs: 0,
      lurkEnabled: true,
    });
    fixture.store.addUserMemory({
      botId: "bot_1",
      groupId: "10001",
      userId: "20001",
      content: "用户的服务器是 Debian 12",
    });
    const calls: any[] = [];
    const actions: any[] = [];
    const pool = {
      chat: async (...args: unknown[]) => {
        calls.push(args);
        return { text: "先检查服务日志。", providerId: "fake", latencyMs: 120 };
      },
    } as any;
    const pipeline = new EventPipeline(
      fixture.store,
      { sendAction: (_botId: string, action: unknown) => actions.push(action) } as any,
      pool,
      new Moderator(fixture.store, pool),
    );
    await pipeline.enqueue("bot_1", "question_direct", {
      post_type: "message",
      message_type: "group",
      group_id: "10001",
      user_id: "20001",
      message_id: 9,
      message: "为什么服务启动后马上退出？",
      sender: { nickname: "小明", role: "member" },
    });
    assert.equal(calls.length, 1);
    assert.match(String(calls[0][0][0].content), /Debian 12/);
    assert.equal(actions.length, 1);
    const trace = fixture.store.db
      .prepare("SELECT decision,reason FROM message_traces WHERE event_id=?")
      .get("question_direct") as any;
    assert.equal(trace.decision, "replied");
    assert.equal(trace.reason, "技术问题自动响应");
  } finally {
    fixture.close();
  }
});
