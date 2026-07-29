import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { oneBotEventSchema, type OneBotAction, type OneBotEvent } from '@puff/shared';
import type { BotConfig } from './config.js';

export class BotConnection {
  private socket?: WebSocket;
  private stopped = false;
  private retries = 0;
  private reconnectTimer?: NodeJS.Timeout;
  lastError: string | null = null;

  constructor(readonly config: BotConfig, private readonly onEvent: (eventId: string, event: OneBotEvent) => void) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  get online() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(action: OneBotAction) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error(`OneBot ${this.config.qq} offline`);
    this.socket.send(JSON.stringify(action));
  }

  private connect() {
    if (this.stopped) return;
    const socket = new WebSocket(this.config.oneBotWs, { handshakeTimeout: 10000 });
    this.socket = socket;
    socket.on('open', () => { this.retries = 0; this.lastError = null; console.log(`[bot ${this.config.qq}] OneBot connected`); });
    socket.on('message', (raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      const result = oneBotEventSchema.safeParse(parsed);
      if (!result.success || result.data.post_type !== 'message') return;
      const value = `${this.config.id}:${result.data.message_id || ''}:${result.data.time || Date.now()}:${result.data.user_id || ''}`;
      const eventId = createHash('sha256').update(value).digest('hex');
      this.onEvent(eventId, result.data);
    });
    socket.on('error', (error) => { this.lastError = error.message; });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
      if (this.stopped) return;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retries++, 5)) + Math.floor(Math.random() * 800);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }
}

