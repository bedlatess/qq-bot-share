import assert from "node:assert/strict";
import test from "node:test";
import { seedBot, testStore } from "./helpers.js";

test("conversation overflow is compacted into bounded persistent memory", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store);
    for (let index = 0; index < 8; index += 1) {
      fixture.store.appendConversation(
        "bot_1",
        "group_1",
        "user_1",
        index % 2 ? "assistant" : "user",
        `message-${index}`,
        4,
      );
    }
    const memory = fixture.store.loadConversation(
      "bot_1",
      "group_1",
      "user_1",
      4,
    );
    assert.equal(memory.length, 5);
    assert.match(memory[0].content, /较早会话记忆/);
    assert.match(memory[0].content, /message-3/);
    assert.deepEqual(
      memory.slice(1).map((item) => item.content),
      ["message-4", "message-5", "message-6", "message-7"],
    );
    assert.ok(memory[0].content.length < 1800);
  } finally {
    fixture.close();
  }
});
