import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { oneBotEventSchema, type OneBotAction, type OneBotEvent } from '@puff/shared';
import type { BotConfig } from './config.js';

export class BotConnection {
  private socket?: WebSocket;
  private stopped = false;
  private retries = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  lastError: string | null = null;

  constructor(readonly config: BotConfig, private readonly onEvent: (eventId: string, event: OneBotEvent) => void) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.rejectPending(new Error(`OneBot ${this.config.qq} stopped`));
    this.socket?.close();
  }

  get online() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(action: OneBotAction) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error(`OneBot ${this.config.qq} offline`);
    this.socket.send(JSON.stringify(action));
  }

  request(action: string, params: Record<string, unknown> = {}, timeoutMs = 10000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error(`OneBot ${this.config.qq} offline`));
    const echo = `puff_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot ${action} timeout`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ action, params, echo }));
    });
  }

  private connect() {
    if (this.stopped) return;
    const socket = new WebSocket(this.config.oneBotWs, { handshakeTimeout: 10000 });
    this.socket = socket;
    socket.on('open', () => { this.retries = 0; this.lastError = null; console.log(`[bot ${this.config.qq}] OneBot connected`); });
    socket.on('message', (raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      const response = parsed as {
        echo?: unknown;
        status?: unknown;
        retcode?: unknown;
        data?: unknown;
        message?: unknown;
      };
      if (response?.echo != null) {
        const pending = this.pending.get(String(response.echo));
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(String(response.echo));
          if (response.status === 'failed' || Number(response.retcode || 0) !== 0)
            pending.reject(new Error(String(response.message || `OneBot retcode ${response.retcode}`)));
          else pending.resolve(response.data);
          return;
        }
      }
      const result = oneBotEventSchema.safeParse(parsed);
      if (!result.success || result.data.post_type !== 'message') return;
      const value = `${this.config.id}:${result.data.message_id || ''}:${result.data.time || Date.now()}:${result.data.user_id || ''}`;
      const eventId = createHash('sha256').update(value).digest('hex');
      try {
        this.onEvent(eventId, result.data);
      } catch (error) {
        console.error(`[bot ${this.config.qq}:event]`, error instanceof Error ? error.stack || error.message : String(error));
      }
    });
    socket.on('error', (error) => { this.lastError = error.message; });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
      this.rejectPending(new Error(`OneBot ${this.config.qq} disconnected`));
      if (this.stopped) return;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retries++, 5)) + Math.floor(Math.random() * 800);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
