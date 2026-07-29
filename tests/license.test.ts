import assert from "node:assert/strict";
import test from "node:test";
import { seedBot, testStore } from "./helpers.js";

test("activation code binds atomically and quota is enforced", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store);
    const plan = fixture.store.db
      .prepare("SELECT id FROM plans LIMIT 1")
      .get() as { id: string };
    fixture.store.db
      .prepare("UPDATE plans SET monthly_quota=2 WHERE id=?")
      .run(plan.id);
    const [code] = fixture.store.createActivationCodes(plan.id, 1, 30);
    assert.ok(code);

    const license = fixture.store.activateCode(code, "bot_1", "987654321");
    assert.equal(license?.active, true);
    const firstExpiry = new Date(String(license?.expires_at)).getTime();
    const [renewalCode] = fixture.store.createActivationCodes(plan.id, 1, 30);
    assert.ok(renewalCode);
    const renewed = fixture.store.activateCode(
      renewalCode,
      "bot_1",
      "987654321",
    );
    assert.ok(
      new Date(String(renewed?.expires_at)).getTime() >=
        firstExpiry + 29 * 86400000,
    );
    assert.throws(
      () => fixture.store.activateCode(code, "bot_1", "987654321"),
      /无效|使用|撤销/,
    );
    assert.equal(fixture.store.consumeQuota("bot_1", "987654321"), 1);
    assert.equal(fixture.store.consumeQuota("bot_1", "987654321"), 2);
    assert.throws(
      () => fixture.store.consumeQuota("bot_1", "987654321"),
      /额度/,
    );

    fixture.store.db
      .prepare(
        "UPDATE group_licenses SET expires_at='2000-01-01T00:00:00.000Z',permanent=0",
      )
      .run();
    assert.equal(fixture.store.getLicense("bot_1", "987654321")?.active, false);
  } finally {
    fixture.close();
  }
});
