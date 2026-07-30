import type WebSocket from "ws";
import {
  nowIso,
  type AgentMessage,
  type AgentUpdateManifest,
  type ControlNapCatRequest,
  type OneBotAction,
} from "@puff/shared";
import type { Store } from "./db.js";
import { randomId, sha256 } from "./security.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class AgentHub {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly botNodes = new Map<string, string>();
  private readonly pending = new Map<string, PendingRequest>();
  onEvent?: (botId: string, eventId: string, event: any) => Promise<void>;

  constructor(
    private readonly store: Store,
    private readonly agentUpdate?: AgentUpdateManifest,
  ) {}

  authenticate(nodeId: string, token: string) {
    return Boolean(
      this.store.db
        .prepare("SELECT id FROM nodes WHERE id=? AND token_hash=?")
        .get(nodeId, sha256(token)),
    );
  }

  attach(nodeId: string, socket: WebSocket) {
    const old = this.sockets.get(nodeId);
    if (old && old !== socket) old.close(4001, "replaced");
    this.sockets.set(nodeId, socket);
    this.store.db
      .prepare(`UPDATE nodes SET status='online',last_seen_at=? WHERE id=?`)
      .run(nowIso(), nodeId);

    socket.on("message", (raw) => {
      void this.handle(nodeId, raw.toString());
    });
    socket.on("close", () => {
      if (this.sockets.get(nodeId) !== socket) return;
      this.sockets.delete(nodeId);
      this.store.db
        .prepare(`UPDATE nodes SET status='offline',last_seen_at=? WHERE id=?`)
        .run(nowIso(), nodeId);
      this.store.db
        .prepare(
          `UPDATE bots SET status='offline',last_seen_at=? WHERE node_id=?`,
        )
        .run(nowIso(), nodeId);
    });
    socket.send(
      JSON.stringify({
        type: "hello_ack",
        at: Date.now(),
        ...(this.agentUpdate ? { update: this.agentUpdate } : {}),
      }),
    );
  }

  private async handle(nodeId: string, raw: string) {
    let message: AgentMessage;
    try {
      message = JSON.parse(raw) as AgentMessage;
    } catch {
      return;
    }
    if (message.type === "hello") {
      this.store.db
        .prepare(
          `UPDATE nodes SET hostname=?,version=?,status='online',last_seen_at=? WHERE id=?`,
        )
        .run(message.hostname, message.version, nowIso(), nodeId);
      for (const bot of message.bots) {
        this.botNodes.set(bot.id, nodeId);
        this.store.db
          .prepare(
            `UPDATE bots SET status=?,last_seen_at=? WHERE id=? AND node_id=?`,
          )
          .run(bot.online ? "online" : "offline", nowIso(), bot.id, nodeId);
      }
      return;
    }
    if (message.type === "heartbeat") {
      this.store.db
        .prepare(`UPDATE nodes SET status='online',last_seen_at=? WHERE id=?`)
        .run(nowIso(), nodeId);
      for (const bot of message.bots) {
        this.botNodes.set(bot.id, nodeId);
        this.store.db
          .prepare(
            `UPDATE bots SET status=?,last_seen_at=?,last_error=? WHERE id=? AND node_id=?`,
          )
          .run(
            bot.oneBotOnline ? "online" : "offline",
            nowIso(),
            bot.loginError || null,
            bot.id,
            nodeId,
          );
      }
      return;
    }
    if (message.type === "event") {
      this.botNodes.set(message.botId, nodeId);
      await this.onEvent?.(message.botId, message.eventId, message.event);
      return;
    }
    if (message.type === "napcat_response" || message.type === "bot_response") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      message.ok
        ? pending.resolve(message.data)
        : pending.reject(new Error(message.error || "NapCat request failed"));
    }
  }

  sendAction(botId: string, action: OneBotAction) {
    const nodeId =
      this.botNodes.get(botId) ||
      (
        this.store.db
          .prepare("SELECT node_id FROM bots WHERE id=?")
          .get(botId) as any
      )?.node_id;
    const socket = nodeId ? this.sockets.get(nodeId) : undefined;
    if (!socket || socket.readyState !== 1) throw new Error("机器人节点离线");
    socket.send(
      JSON.stringify({
        type: "action",
        requestId: randomId("act_"),
        botId,
        action,
      }),
    );
  }

  requestNapCat(
    botId: string,
    operation: ControlNapCatRequest["operation"],
    timeoutMs = 10000,
  ) {
    const nodeId =
      this.botNodes.get(botId) ||
      (
        this.store.db
          .prepare("SELECT node_id FROM bots WHERE id=?")
          .get(botId) as any
      )?.node_id;
    const socket = nodeId ? this.sockets.get(nodeId) : undefined;
    if (!socket || socket.readyState !== 1)
      return Promise.reject(new Error("机器人节点离线"));
    const requestId = randomId("nc_");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("NapCat request timeout"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          type: "napcat_request",
          requestId,
          botId,
          operation,
        } satisfies ControlNapCatRequest),
      );
    });
  }

  requestBotGroups(botId: string, timeoutMs = 20000) {
    const nodeId =
      this.botNodes.get(botId) ||
      (
        this.store.db
          .prepare("SELECT node_id FROM bots WHERE id=?")
          .get(botId) as any
      )?.node_id;
    const socket = nodeId ? this.sockets.get(nodeId) : undefined;
    if (!socket || socket.readyState !== 1)
      return Promise.reject(new Error("机器人节点离线"));
    const requestId = randomId("botreq_");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("群列表同步超时"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          type: "bot_request",
          requestId,
          botId,
          operation: "groups",
        }),
      );
    });
  }

  onlineNodeIds() {
    return [...this.sockets.keys()];
  }
}
