import assert from "node:assert/strict";
import test from "node:test";
import {
  createActivationCode,
  decryptSecret,
  encryptSecret,
  hashPassword,
  verifyPassword,
} from "../apps/control/src/security.js";

test("password hashing and AES-GCM secret encryption round trip", async () => {
  const password = await hashPassword("correct horse battery staple");
  assert.equal(
    await verifyPassword(
      "correct horse battery staple",
      password.salt,
      password.hash,
    ),
    true,
  );
  assert.equal(
    await verifyPassword("wrong password", password.salt, password.hash),
    false,
  );

  const encrypted = encryptSecret("sk-secret-value", "master-key");
  assert.notEqual(encrypted.includes("sk-secret-value"), true);
  assert.equal(decryptSecret(encrypted, "master-key"), "sk-secret-value");
  assert.throws(() => decryptSecret(encrypted, "wrong-key"));
});

test("activation codes avoid ambiguous characters", () => {
  const code = createActivationCode();
  assert.match(code, /^PUFF(?:-[A-HJ-NP-Z2-9]{5}){4}$/);
  assert.doesNotMatch(code, /[01IO]/);
});
