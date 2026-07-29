import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, truncateSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class DiskSpool {
  private readonly file: string;
  private readonly draining: string;

  constructor(directory: string, private readonly limitBytes: number) {
    const root = resolve(directory);
    mkdirSync(root, { recursive: true });
    this.file = join(root, 'events.jsonl');
    this.draining = join(root, 'events.draining.jsonl');
  }

  append(message: unknown) {
    appendFileSync(this.file, `${JSON.stringify(message)}\n`, 'utf8');
    this.trim();
  }

  drain(send: (message: string) => boolean) {
    try { renameSync(this.file, this.draining); } catch { return; }
    const lines = readFileSync(this.draining, 'utf8').split(/\r?\n/).filter(Boolean);
    let index = 0;
    for (; index < lines.length; index += 1) if (!send(lines[index]!)) break;
    if (index < lines.length) {
      for (const line of lines.slice(index)) appendFileSync(this.file, `${line}\n`, 'utf8');
    }
    truncateSync(this.draining, 0);
  }

  size() {
    try { return statSync(this.file).size; } catch { return 0; }
  }

  private trim() {
    if (this.size() <= this.limitBytes) return;
    const lines = readFileSync(this.file, 'utf8').split(/\r?\n/).filter(Boolean);
    let kept = lines.slice(Math.floor(lines.length / 3));
    while (Buffer.byteLength(kept.join('\n')) > this.limitBytes * 0.8) kept = kept.slice(Math.max(1, Math.floor(kept.length / 10)));
    truncateSync(this.file, 0);
    if (kept.length) appendFileSync(this.file, `${kept.join('\n')}\n`, 'utf8');
  }
}

