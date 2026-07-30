import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";
import { BotConnection } from "../apps/agent/src/bot-connection.js";

test("agent correlates OneBot API responses for group synchronization", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string") throw new Error("unexpected pipe address");
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      assert.equal(request.action, "get_group_list");
      socket.send(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          echo: request.echo,
          data: [
            {
              group_id: 10001,
              group_name: "测试群",
              member_count: 28,
              max_member_count: 200,
            },
          ],
        }),
      );
    });
  });
  const bot = new BotConnection(
    {
      id: "bot_1",
      qq: "123456789",
      oneBotWs: `ws://127.0.0.1:${address.port}`,
      webuiUrl: "http://127.0.0.1:6099",
      webuiToken: "",
    },
    () => undefined,
  );
  try {
    bot.start();
    for (let index = 0; index < 50 && !bot.online; index += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(bot.online, true);
    const groups = (await bot.request("get_group_list", { no_cache: true })) as any[];
    assert.equal(groups[0].group_name, "测试群");
  } finally {
    bot.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
