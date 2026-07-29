import assert from "node:assert/strict";
import test from "node:test";
import {
  botDefaultsFallback,
  legacyBotDefaultValues,
} from "../apps/control/src/bot-defaults.js";
import { seedBot, testStore } from "./helpers.js";

test("bootstrap upgrades known legacy persona prompts without touching custom values", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store);
    const legacy = legacyBotDefaultValues.systemPrompt?.at(-1);
    assert.ok(legacy);
    const existing = fixture.store.getSetting<Record<string, unknown>>(
      "bot_defaults",
      {},
    );
    fixture.store.setSetting("bot_defaults", {
      ...existing,
      systemPrompt: legacy,
      persona: "泡芙",
    });
    fixture.store.db
      .prepare("UPDATE bots SET system_prompt=? WHERE id='bot_1'")
      .run(legacy);

    await fixture.store.bootstrap("admin@example.com", "test-password-123");

    const upgraded = fixture.store.getSetting<Record<string, unknown>>(
      "bot_defaults",
      {},
    );
    assert.equal(upgraded.systemPrompt, botDefaultsFallback.systemPrompt);
    assert.equal(
      (
        fixture.store.db
          .prepare("SELECT system_prompt FROM bots WHERE id='bot_1'")
          .get() as { system_prompt: string }
      ).system_prompt,
      "",
    );
  } finally {
    fixture.close();
  }
});
