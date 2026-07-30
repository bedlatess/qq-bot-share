import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "@puff/shared";
import type { Store } from "./db.js";

type ManagedFile = { path: string; size: number; mtime: number };

function filesUnder(root: string): ManagedFile[] {
  const output: ManagedFile[] = [];
  try {
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      const stat = statSync(path);
      if (stat.isDirectory()) output.push(...filesUnder(path));
      else output.push({ path, size: stat.size, mtime: stat.mtimeMs });
    }
  } catch {
    return output;
  }
  return output;
}

export class StorageManager {
  readonly backupDir: string;

  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
    private readonly limitBytes: number,
  ) {
    this.backupDir = join(dataDir, "backups");
    mkdirSync(this.backupDir, { recursive: true });
  }

  usage() {
    const files = filesUnder(this.dataDir);
    const usedBytes = files.reduce((sum, file) => sum + file.size, 0);
    return {
      usedBytes,
      limitBytes: this.limitBytes,
      percent: Math.round((usedBytes / this.limitBytes) * 1000) / 10,
      fileCount: files.length,
    };
  }

  async backup() {
    const target = join(
      this.backupDir,
      `puff-${nowIso().replace(/[:.]/g, "-")}.sqlite`,
    );
    await this.store.db.backup(target);
    this.rotateBackups();
    return target;
  }

  cleanup() {
    const now = Date.now();
    const operationalCutoff = new Date(now - 7 * 86400000).toISOString();
    const evidenceCutoff = new Date(now - 30 * 86400000).toISOString();
    const result = {
      sessions: this.store.db
        .prepare("DELETE FROM sessions WHERE expires_at < ?")
        .run(nowIso()).changes,
      usageEvents: this.store.db
        .prepare("DELETE FROM usage_events WHERE created_at < ?")
        .run(operationalCutoff).changes,
      auditLogs: this.store.db
        .prepare("DELETE FROM audit_logs WHERE created_at < ?")
        .run(operationalCutoff).changes,
      moderationEvents: this.store.db
        .prepare("DELETE FROM moderation_events WHERE created_at < ?")
        .run(evidenceCutoff).changes,
      messageTraces: this.store.db
        .prepare("DELETE FROM message_traces WHERE created_at < ?")
        .run(operationalCutoff).changes,
      groupContext: this.store.db
        .prepare("DELETE FROM group_context_messages WHERE created_at < ?")
        .run(operationalCutoff).changes,
      conversations: this.store.db
        .prepare(
          "DELETE FROM conversation_messages WHERE created_at < datetime('now','-14 days')",
        )
        .run().changes,
      conversationSummaries: this.store.db
        .prepare(
          "DELETE FROM conversation_summaries WHERE updated_at < datetime('now','-30 days')",
        )
        .run().changes,
      providerHealth: this.store.db
        .prepare("DELETE FROM provider_health_events WHERE created_at < ?")
        .run(operationalCutoff).changes,
      filesDeleted: 0,
    };
    this.rotateBackups();
    let usage = this.usage();
    if (usage.usedBytes > this.limitBytes) {
      const deletable = filesUnder(this.backupDir).sort(
        (a, b) => a.mtime - b.mtime,
      );
      for (const file of deletable) {
        if (usage.usedBytes <= this.limitBytes * 0.9) break;
        try {
          unlinkSync(file.path);
          result.filesDeleted += 1;
        } catch {
          /* continue */
        }
        usage = this.usage();
      }
      if (usage.usedBytes > this.limitBytes) {
        const emergencyCutoff = new Date(now - 86400000).toISOString();
        this.store.db
          .prepare("DELETE FROM usage_events WHERE created_at < ?")
          .run(emergencyCutoff);
        this.store.db
          .prepare("DELETE FROM audit_logs WHERE created_at < ?")
          .run(emergencyCutoff);
      }
    }
    this.store.db.pragma("wal_checkpoint(TRUNCATE)");
    return { ...result, ...this.usage() };
  }

  private rotateBackups() {
    const backups = filesUnder(this.backupDir).sort(
      (a, b) => b.mtime - a.mtime,
    );
    for (const file of backups.slice(7)) {
      try {
        unlinkSync(file.path);
      } catch {
        /* continue */
      }
    }
  }
}
