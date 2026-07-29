import { hostname } from 'node:os';
import WebSocket from 'ws';
import type { AgentEvent, ControlMessage } from '@puff/shared';
import type { AgentConfig } from './config.js';
import { BotConnection } from './bot-connection.js';
import { DiskSpool } from './spool.js';
import { napCatOperation } from './napcat.js';

export class Agent {
  private control?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private retries = 0;
  private stopped = false;
  private readonly spool: DiskSpool;
  private readonly bots = new Map<string, BotConnection>();

  constructor(private readonly config: AgentConfig) {
    this.spool = new DiskSpool(config.spoolDir, config.spoolLimitBytes);
    for (const item of config.bots) {
      this.bots.set(item.id, new BotConnection(item, (eventId, event) => {
        const message: AgentEvent = { type: 'event', eventId, nodeId: config.nodeId, botId: item.id, event };
        try {
          if (!this.send(message)) this.spool.append(message);
        } catch (error) {
          console.error('[spool]', error instanceof Error ? error.stack || error.message : String(error));
        }
      }));
    }
  }

  start() {
    this.stopped = false;
    for (const bot of this.bots.values()) bot.start();
    this.connectControl();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.control?.close();
    for (const bot of this.bots.values()) bot.stop();
  }

  private connectControl() {
    if (this.stopped) return;
    const url = new URL(this.config.controlUrl);
    url.searchParams.set('nodeId', this.config.nodeId);
    url.searchParams.set('token', this.config.nodeToken);
    const socket = new WebSocket(url, { handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024 });
    this.control = socket;
    socket.on('open', () => {
      this.retries = 0;
      console.log('[control] connected');
      this.sendHello();
      this.spool.drain((line) => {
        if (socket.readyState !== WebSocket.OPEN) return false;
        socket.send(line);
        return true;
      });
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 15000);
      this.sendHeartbeat();
    });
    socket.on('message', (raw) => void this.handleControl(raw.toString()));
    socket.on('error', (error) => console.error('[control]', error.message));
    socket.on('close', () => {
      if (this.control === socket) this.control = undefined;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.stopped) return;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retries++, 5)) + Math.floor(Math.random() * 1000);
      this.reconnectTimer = setTimeout(() => this.connectControl(), delay);
    });
  }

  private send(value: unknown) {
    const socket = this.control;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(value));
      return true;
    } catch (error) {
      console.error('[control:send]', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private sendHello() {
    this.send({ type: 'hello', nodeId: this.config.nodeId, version: '2.0.0', hostname: hostname(), bots: [...this.bots.values()].map((bot) => ({ id: bot.config.id, qq: bot.config.qq, online: bot.online })) });
  }

  private sendHeartbeat() {
    this.send({
      type: 'heartbeat', nodeId: this.config.nodeId, at: Date.now(),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024), queueDepth: this.spool.size(),
      bots: [...this.bots.values()].map((bot) => ({ id: bot.config.id, qq: bot.config.qq, oneBotOnline: bot.online, loginError: bot.lastError })),
    });
  }

  private async handleControl(raw: string) {
    let message: ControlMessage;
    try { message = JSON.parse(raw) as ControlMessage; } catch { return; }
    if (message.type === 'action') {
      try { this.bots.get(message.botId)?.send(message.action); } catch (error) { console.error('[action]', error); }
      return;
    }
    if (message.type === 'napcat_request') {
      const bot = this.bots.get(message.botId)?.config;
      if (!bot) return this.send({ type: 'napcat_response', requestId: message.requestId, ok: false, error: 'bot not found' });
      try {
        const data = await napCatOperation(bot, message.operation);
        this.send({ type: 'napcat_response', requestId: message.requestId, ok: true, data });
      } catch (error) {
        this.send({ type: 'napcat_response', requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
