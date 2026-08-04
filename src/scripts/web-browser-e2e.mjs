import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";

import { createApplication } from "../dist/app/composition-root.js";
import { createKangminHttpServer } from "../dist/http/server.js";
import { KangminDatabase } from "../dist/infrastructure/database.js";
import { SqliteAccountRepository } from "../dist/infrastructure/sqlite-account-repository.js";
// 浏览器 E2E 以本地开发模式运行：组合根需要 dev 明文加密降级。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

async function listen(server) {
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    assert.fail("Browser E2E server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function expectText(locator, text) {
  await locator.filter({ hasText: text }).waitFor({ state: "visible" });
  assert.match((await locator.textContent()) ?? "", new RegExp(text, "u"));
}

/** 打开日历 tab 并切到列表模式。 */
async function openCalendarList(page) {
  await page.getByTestId("nav-calendar").click();
  await page.getByTestId("symptom-add-today").waitFor({ state: "visible" });
  await page.getByTestId("calendar-mode-toggle").click();
  await page.getByTestId("calendar-list").waitFor({ state: "visible" });
}

const directory = mkdtempSync(join(tmpdir(), "kangmin-browser-"));
const databasePath = join(directory, "records.sqlite");
let application = createApplication(databasePath);
// record 写入需 health_data 授权（issue-155 fail-closed）：薄壳固定使用
// subject "patient-web" 的开发会话（web/app.js），直接经仓储补记授权。
const seeded =
  await application.sessions.createDevelopmentSession("patient-web");
const seedDatabase = new KangminDatabase(databasePath);
try {
  await new SqliteAccountRepository(seedDatabase).appendConsent({
    patientId: seeded.patientId,
    consentType: "health_data",
    decision: "granted",
    policyVersion: "2026-08-01.1",
    requestId: "web-e2e-seed",
    createdAt: new Date().toISOString()
  });
} finally {
  seedDatabase.close();
}
let server = createKangminHttpServer(application, {
  appEnvironment: "integration",
  allowDevelopmentSession: true
});
let origin = await listen(server);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }
});
const page = await context.newPage();

try {
  // 首页薄壳渲染（品牌横幅 + 手机壳 + 底部导航）。
  await page.goto(origin);
  await page.locator(".demo-shell .bottom-nav").waitFor({ state: "visible" });
  await expectText(page.locator(".real-title"), "抗敏先锋");

  // 打开日历并新增今天的症状记录（2,1,2,1 → TNSS 6）。
  await page.getByTestId("nav-calendar").click();
  await page.getByTestId("symptom-add-today").click();
  await page.getByTestId("entry-sheet").waitFor({ state: "visible" });
  await page.getByTestId("score-0-2").click();
  await page.getByTestId("score-1-1").click();
  await page.getByTestId("score-2-2").click();
  await page.getByTestId("score-3-1").click();
  await page.getByTestId("symptom-save").click();
  await page.getByTestId("entry-sheet").waitFor({ state: "detached" });

  // 列表模式确认服务端记录已回读。
  await page.getByTestId("calendar-mode-toggle").click();
  await expectText(
    page.getByTestId("calendar-list"),
    "喷嚏 2 · 流涕 1 · 鼻塞 2 · 鼻痒 1"
  );

  // 从列表回显该日期并修改鼻塞评分（2 → 3，TNSS 7）。
  await page.getByTestId("calendar-list").locator("button").first().click();
  await page.getByTestId("entry-sheet").waitFor({ state: "visible" });
  // 保存按钮解除禁用才表示该日服务端记录已回显完成。
  await page.waitForSelector('[data-testid="symptom-save"]:not([disabled])');
  assert.match(
    (await page.getByTestId("score-0-2").getAttribute("class")) ?? "",
    /selected/u
  );
  await page.getByTestId("score-2-3").click();
  await page.getByTestId("symptom-save").click();
  await page.getByTestId("entry-sheet").waitFor({ state: "detached" });
  await expectText(
    page.getByTestId("calendar-list"),
    "喷嚏 2 · 流涕 1 · 鼻塞 3 · 鼻痒 1"
  );

  // 刷新页面（同一会话 Cookie）后记录仍在。
  await page.reload();
  await page.locator(".demo-shell .bottom-nav").waitFor({ state: "visible" });
  await openCalendarList(page);
  await expectText(
    page.getByTestId("calendar-list"),
    "喷嚏 2 · 流涕 1 · 鼻塞 3 · 鼻痒 1"
  );

  // 服务重启（同一 SQLite）后，新开发会话仍解析到同一患者记录。
  await close(server);
  application.close();
  application = createApplication(databasePath);
  server = createKangminHttpServer(application, {
    appEnvironment: "integration",
    allowDevelopmentSession: true
  });
  origin = await listen(server);

  await page.goto(origin);
  await page.locator(".demo-shell .bottom-nav").waitFor({ state: "visible" });
  await openCalendarList(page);
  await expectText(
    page.getByTestId("calendar-list"),
    "喷嚏 2 · 流涕 1 · 鼻塞 3 · 鼻痒 1"
  );
  process.stdout.write(
    "web-browser-e2e: PASS shell save reflect-update reload restart\n"
  );
} finally {
  await context.close();
  await browser.close();
  if (server.listening) {
    await close(server);
  }
  application.close();
}
