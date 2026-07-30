import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AgentHub } from "../apps/control/src/agent-hub.js";
import { seedBot, testStore } from "./helpers.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

test("agent hub tracks pending and completed automatic updates", async () => {
  const fixture = await testStore();
  try {
    seedBot(fixture.store);
    const hub = new AgentHub(fixture.store, {
      version: "2.2.0",
      url: "https://control.test/agent-update",
      sha256: "a".repeat(64),
    });
    const socket = new FakeSocket();
    hub.attach("node_1", socket as any);
    assert.match(socket.sent[0] || "", /2\.2\.0/);

    socket.emit(
      "message",
      JSON.stringify({
        type: "hello",
        nodeId: "node_1",
        version: "2.1.0",
        hostname: "WIN-NODE",
        bots: [{ id: "bot_1", qq: "123456789", online: true }],
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    let node = fixture.store.db
      .prepare("SELECT * FROM nodes WHERE id='node_1'")
      .get() as any;
    assert.equal(node.update_state, "pending");
    assert.equal(node.target_version, "2.2.0");

    socket.emit(
      "message",
      JSON.stringify({
        type: "hello",
        nodeId: "node_1",
        version: "2.2.0",
        hostname: "WIN-NODE",
        bots: [{ id: "bot_1", qq: "123456789", online: true }],
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    node = fixture.store.db
      .prepare("SELECT * FROM nodes WHERE id='node_1'")
      .get() as any;
    assert.equal(node.update_state, "current");
    assert.ok(node.last_update_at);

    socket.emit(
      "message",
      JSON.stringify({
        type: "hello",
        nodeId: "node_1",
        version: "2.1.0",
        hostname: "WIN-NODE",
        autoUpdate: false,
        bots: [{ id: "bot_1", qq: "123456789", online: true }],
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    node = fixture.store.db
      .prepare("SELECT * FROM nodes WHERE id='node_1'")
      .get() as any;
    assert.equal(node.update_state, "disabled");

    socket.emit(
      "message",
      JSON.stringify({
        type: "heartbeat",
        nodeId: "node_1",
        version: "2.1.0",
        autoUpdate: true,
        updateStatus: {
          state: "failed",
          targetVersion: "2.2.0",
          at: "2026-07-30T01:00:00.000Z",
          error: "下载超时",
        },
        at: Date.now(),
        memoryMb: 80,
        queueDepth: 0,
        bots: [],
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    node = fixture.store.db
      .prepare("SELECT * FROM nodes WHERE id='node_1'")
      .get() as any;
    assert.equal(node.update_state, "failed");
    assert.equal(node.last_update_error, "下载超时");
    assert.equal(node.last_update_at, "2026-07-30T01:00:00.000Z");
  } finally {
    fixture.close();
  }
});
