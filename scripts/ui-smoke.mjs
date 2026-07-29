import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const baseUrl = process.env.UI_BASE_URL || "http://127.0.0.1:17866";
const email = process.env.UI_ADMIN_EMAIL || "admin@example.com";
const password = process.env.UI_ADMIN_PASSWORD || "change-this-password";
const output = "test-results/ui";
mkdirSync(output, { recursive: true });

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
  await page.getByRole("heading", { name: "全局人格默认值" }).waitFor();
  await page.getByText("启用冷场自动活跃", { exact: true }).waitFor();
  await page.screenshot({
    path: `${output}/settings-persona-desktop.png`,
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
        `${output}/settings-custom-commands-desktop.png`,
        `${output}/settings-mobile.png`,
      ],
    }),
  );
} finally {
  await browser.close();
}
