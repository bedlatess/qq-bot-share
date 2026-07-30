import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.UI_BASE_URL || "http://127.0.0.1:17866";
const email = process.env.UI_ADMIN_EMAIL || "admin@example.com";
const password = process.env.UI_ADMIN_PASSWORD || "change-this-password";
const output = "test-results/ui";
mkdirSync(output, { recursive: true });

let server;
let runtimeDir;
if (process.env.UI_MANAGED_SERVER === "1") {
  const url = new URL(baseUrl);
  runtimeDir = mkdtempSync(join(tmpdir(), "puff-ui-smoke-"));
  server = spawn(process.execPath, ["apps/control/dist/main.js"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: url.hostname,
      PORT: url.port || "17866",
      DATA_DIR: join(runtimeDir, "data"),
      PUBLIC_URL: baseUrl,
      ADMIN_EMAIL: email,
      ADMIN_PASSWORD: password,
      SESSION_SECRET: "ui-smoke-session-secret-32-characters",
      MASTER_KEY: "ui-smoke-master-secret-32-characters",
    },
  });
  const stderr = [];
  server.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) break;
    } catch {
      // The control process is still starting.
    }
    if (server.exitCode !== null) {
      throw new Error(`managed server exited early: ${stderr.join("")}`);
    }
    if (attempt === 59) {
      throw new Error(`managed server did not become healthy: ${stderr.join("")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "进入控制台" }).click();
  await page.getByRole("heading", { name: "总览" }).waitFor();
  await page.getByText("累计调用", { exact: true }).waitFor();
  errors.length = 0;
  await page.screenshot({
    path: `${output}/dashboard-desktop.png`,
    fullPage: true,
  });

  const desktopOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  if (desktopOverflow)
    throw new Error("desktop layout has horizontal overflow");

  await page.getByRole("button", { name: /机器人设置/ }).click();
  await page.getByRole("heading", { name: "机器人设置" }).waitFor();
  await page.getByRole("button", { name: "人格与节奏" }).click();
  await page.getByRole("heading", { name: "全局人格与回复节奏" }).waitFor();
  await page.getByText("启用冷场自动活跃", { exact: true }).waitFor();
  await page.screenshot({
    path: `${output}/settings-persona-desktop.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "人格调试" }).click();
  await page.getByRole("heading", { name: "人格调试室" }).waitFor();
  await page.screenshot({
    path: `${output}/settings-persona-lab-desktop.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "记忆管理" }).click();
  await page.getByRole("heading", { name: "结构化长期记忆" }).waitFor();
  await page.screenshot({
    path: `${output}/settings-memories-desktop.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "自定义命令" }).click();
  await page.getByText("自定义命令直接返回固定内容", { exact: false }).waitFor();
  await page.getByRole("button", { name: "新增命令" }).click();
  await page.getByLabel("触发词").fill("群规");
  await page.getByLabel("回复内容").fill("{user}，请先查看群公告。");
  await page.getByRole("button", { name: "保存回复" }).click();
  await page.getByRole("cell", { name: "群规", exact: true }).waitFor();
  await page.screenshot({
    path: `${output}/settings-custom-commands-desktop.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: /日志与存储/ }).click();
  await page.getByRole("heading", { name: "日志与存储" }).waitFor();
  await page.getByRole("button", { name: "清空当前日志" }).waitFor();
  await page.screenshot({
    path: `${output}/logs-desktop.png`,
    fullPage: true,
  });
  const logsOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  if (logsOverflow) throw new Error("logs layout has horizontal overflow");
  await page.getByRole("button", { name: /群行为/ }).click();
  await page.getByRole("heading", { name: "群行为", exact: true }).waitFor();
  await page.getByRole("heading", { name: "群行为策略" }).waitFor();
  await page.screenshot({
    path: `${output}/group-behavior-desktop.png`,
    fullPage: true,
  });
  const groupOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  if (groupOverflow) throw new Error("group behavior layout has horizontal overflow");
  await page.getByRole("button", { name: /消息诊断/ }).click();
  await page.getByRole("heading", { name: "消息诊断" }).waitFor();
  await page.getByRole("heading", { name: "消息处理轨迹" }).waitFor();
  await page.screenshot({
    path: `${output}/diagnostics-desktop.png`,
    fullPage: true,
  });
  const diagnosticsOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  if (diagnosticsOverflow)
    throw new Error("diagnostics layout has horizontal overflow");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${output}/diagnostics-mobile.png`,
    fullPage: true,
  });
  const diagnosticsMobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  if (diagnosticsMobileOverflow)
    throw new Error("diagnostics mobile layout has horizontal overflow");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: /机器人设置/ }).click();
  await page.getByRole("heading", { name: "机器人设置" }).waitFor();
  await page.getByRole("button", { name: "出站过滤" }).click();
  await page.getByRole("heading", { name: "AI 出站过滤" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${output}/settings-mobile.png`,
    fullPage: true,
  });
  const mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  if (mobileOverflow) throw new Error("mobile layout has horizontal overflow");
  if (errors.length)
    throw new Error(`browser console errors: ${errors.join(" | ")}`);
  console.log(
    JSON.stringify({
      ok: true,
      baseUrl,
      screenshots: [
        `${output}/dashboard-desktop.png`,
        `${output}/settings-persona-desktop.png`,
        `${output}/settings-persona-lab-desktop.png`,
        `${output}/settings-memories-desktop.png`,
        `${output}/settings-custom-commands-desktop.png`,
        `${output}/logs-desktop.png`,
        `${output}/group-behavior-desktop.png`,
        `${output}/diagnostics-desktop.png`,
        `${output}/diagnostics-mobile.png`,
        `${output}/settings-mobile.png`,
      ],
    }),
  );
} finally {
  await browser.close();
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
  }
  if (runtimeDir)
    rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5 });
}
