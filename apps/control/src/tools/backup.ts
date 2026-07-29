import { join } from "node:path";
import { loadConfig } from "../config.js";
import { Store } from "../db.js";
import { StorageManager } from "../storage.js";

const config = loadConfig();
const store = new Store(join(config.dataDir, "puff.sqlite"));
try {
  const storage = new StorageManager(
    store,
    config.dataDir,
    config.storageLimitBytes,
  );
  console.log(await storage.backup());
} finally {
  store.close();
}
