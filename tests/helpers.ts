import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nowIso, type FeatureFlags } from "@puff/shared";
import { Store } from "../apps/control/src/db.js";

export async function testStore() {
  const dir = mkdtempSync(join(tmpdir(), "puff-test-"));
  const store = new Store(join(dir, "puff.sqlite"));
  await store.bootstrap("admin@example.com", "test-password-123");
  return {
    dir,
    store,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function seedBot(store: Store, features?: Partial<FeatureFlags>) {
  const now = nowIso();
  store.db
    .prepare(
      `INSERT INTO nodes (id,name,token_hash,status,created_at) VALUES ('node_1','测试节点','hash','offline',?)`,
    )
    .run(now);
  store.db
    .prepare(
      `INSERT INTO bots (id,node_id,qq,name,enabled,created_at) VALUES ('bot_1','node_1','123456789','测试机器人',1,?)`,
    )
    .run(now);
  if (features) {
    const plan = store.db
      .prepare("SELECT id,features_json FROM plans LIMIT 1")
      .get() as { id: string; features_json: string };
    store.db
      .prepare("UPDATE plans SET features_json=? WHERE id=?")
      .run(
        JSON.stringify({ ...JSON.parse(plan.features_json), ...features }),
        plan.id,
      );
  }
}
