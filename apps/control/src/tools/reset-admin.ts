import { join } from "node:path";
import { loadConfig } from "../config.js";
import { Store } from "../db.js";
import { hashPassword, randomId } from "../security.js";
import { nowIso } from "@puff/shared";

const config = loadConfig();
const email = (process.argv[2] || process.env.ADMIN_EMAIL || "")
  .trim()
  .toLowerCase();
const password = process.argv[3] || process.env.ADMIN_PASSWORD || "";
if (!email || !email.includes("@") || password.length < 10) {
  console.error(
    "用法: npm run admin:reset -- admin@example.com 至少10位新密码",
  );
  process.exit(2);
}

const store = new Store(join(config.dataDir, "puff.sqlite"));
try {
  const next = await hashPassword(password);
  const current = store.db.prepare("SELECT id FROM admins LIMIT 1").get() as
    { id: string } | undefined;
  const now = nowIso();
  if (current) {
    store.db
      .prepare(
        "UPDATE admins SET email=?,password_hash=?,password_salt=?,updated_at=? WHERE id=?",
      )
      .run(email, next.hash, next.salt, now, current.id);
    store.db.prepare("DELETE FROM sessions WHERE admin_id=?").run(current.id);
  } else {
    store.db
      .prepare(
        `INSERT INTO admins (id,email,password_hash,password_salt,created_at,updated_at)
      VALUES (?,?,?,?,?,?)`,
      )
      .run(randomId("adm_"), email, next.hash, next.salt, now, now);
  }
  console.log(`管理员已重置: ${email}`);
} finally {
  store.close();
}
