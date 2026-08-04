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

function dataOf(result) {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data;
}

async function expectText(locator, text) {
  await locator.filter({ hasText: text }).waitFor({ state: "visible" });
  assert.match((await locator.textContent()) ?? "", new RegExp(text, "u"));
}

async function selectScore(page, name, value) {
  await page
    .locator(`label:has(input[name="${name}"][value="${value}"])`)
    .click();
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
  await page.goto(origin);
  await page.getByTestId("symptom-form").waitFor({ state: "visible" });
  await page.getByTestId("empty-state").waitFor({ state: "visible" });

  await page.getByTestId("record-date").fill("2026-07-31");
  await selectScore(page, "sneezing", 2);
  await selectScore(page, "runnyNose", 1);
  await selectScore(page, "nasalCongestion", 2);
  await selectScore(page, "nasalItching", 1);
  await page.getByTestId("notes").fill("浏览器真实保存");
  await expectText(page.getByTestId("score-preview"), "6");
  await page.getByTestId("save-button").click();

  await expectText(page.getByTestId("notice"), "已保存到服务端");
  await expectText(page.getByTestId("record-count"), "1 条");
  await expectText(page.getByTestId("record-list"), "TNSS 6");

  await page.getByTestId("record-date").fill("2026-07-30");
  await selectScore(page, "sneezing", 1);
  await selectScore(page, "runnyNose", 1);
  await selectScore(page, "nasalCongestion", 1);
  await selectScore(page, "nasalItching", 0);
  await page.getByTestId("notes").fill("前一天纵向记录");
  await page.getByTestId("save-button").click();
  await expectText(page.getByTestId("record-count"), "2 条");
  await expectText(
    page.getByTestId("record-list").locator("button").first(),
    "2026年7月31日"
  );
  await expectText(page.getByTestId("record-list"), "TNSS 3");

  await page.reload();
  await expectText(page.getByTestId("record-list"), "TNSS 6");
  await expectText(page.getByTestId("record-count"), "2 条");
  await page.getByTestId("record-list").locator("button").first().click();
  await expectText(page.getByTestId("form-title"), "修改症状记录");
  assert.equal(
    await page.getByTestId("notes").inputValue(),
    "浏览器真实保存"
  );

  await selectScore(page, "nasalCongestion", 3);
  await page.getByTestId("save-button").click();
  await expectText(page.getByTestId("notice"), "已更新");
  await expectText(page.getByTestId("record-list"), "TNSS 7");

  const externalSession =
    await application.sessions.createDevelopmentSession("patient-web");
  const listed = await application.execute({
    command: "record symptom list",
    sessionToken: externalSession.token
  });
  const [current] = dataOf(listed).items;
  assert.notEqual(current, undefined);
  const externallyUpdated = await application.execute({
    command: "record symptom update",
    sessionToken: externalSession.token,
    input: {
      id: current.id,
      expectedRevision: current.revision,
      sneezing: 0
    }
  });
  assert.equal(externallyUpdated.ok, true);

  await selectScore(page, "nasalItching", 2);
  await page.getByTestId("save-button").click();
  await expectText(
    page.getByTestId("notice"),
    "其它页面发生变化"
  );

  await page.getByTestId("refresh-button").click();
  await expectText(page.getByTestId("record-list"), "TNSS 5");

  await close(server);
  application.close();
  application = createApplication(databasePath);
  server = createKangminHttpServer(application, {
    appEnvironment: "integration",
    allowDevelopmentSession: true
  });
  origin = await listen(server);

  await page.goto(origin);
  await expectText(page.getByTestId("record-list"), "TNSS 5");
  await expectText(page.getByTestId("record-list"), "TNSS 3");
  await expectText(page.getByTestId("record-count"), "2 条");
  process.stdout.write(
    "web-browser-e2e: PASS longitudinal save refresh update conflict restart\n"
  );
} finally {
  await context.close();
  await browser.close();
  if (server.listening) {
    await close(server);
  }
  application.close();
}
