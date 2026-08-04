import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createApplication } from "../dist/app/composition-root.js";
import { createKangminHttpServer } from "../dist/http/server.js";
import { KangminDatabase } from "../dist/infrastructure/database.js";
import { SqliteAccountRepository } from "../dist/infrastructure/sqlite-account-repository.js";
// 浏览器 E2E 以本地开发模式运行：组合根需要 dev 明文加密降级。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

const adminCli = fileURLToPath(
  new URL("../dist/cli/kangmin-admin.js", import.meta.url)
);
const adminSessionScript = fileURLToPath(
  new URL("../dist/dev/create-admin-session.js", import.meta.url)
);

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

  // ---- 首页/我的统计（record overview）：无记录账户为空态 ----
  await expectText(page.getByTestId("home-overview"), "暂无真实健康记录");
  await page.locator(".bottom-nav button", { hasText: "我的" }).click();
  const emptyOverview = page.getByTestId("profile-overview");
  await emptyOverview.waitFor({ state: "visible" });
  const emptyCells = emptyOverview.locator("div");
  assert.match((await emptyCells.nth(0).textContent()) ?? "", /^--连续记录\/天$/u);
  assert.match((await emptyCells.nth(1).textContent()) ?? "", /^--本月记录\/次$/u);
  assert.match((await emptyCells.nth(2).textContent()) ?? "", /^暂无最近评估$/u);
  await page.locator(".bottom-nav button", { hasText: "首页" }).click();

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

  // ---- 首页/我的统计（record overview）：保存后显示真值 ----
  // 今天一条症状记录（TNSS 7）：连续 1 天、本月 1 次、最近评估 TNSS 7/12。
  await page.locator(".bottom-nav button", { hasText: "首页" }).click();
  await expectText(page.getByTestId("home-overview"), "连续记录 1 天 · 本月 1 次");
  await page.locator(".bottom-nav button", { hasText: "我的" }).click();
  const filledOverview = page.getByTestId("profile-overview");
  const filledCells = filledOverview.locator("div");
  await expectText(filledOverview, "TNSS 7/12");
  assert.match((await filledCells.nth(0).textContent()) ?? "", /^1连续记录\/天$/u);
  assert.match((await filledCells.nth(1).textContent()) ?? "", /^1本月记录\/次$/u);
  assert.match((await filledCells.nth(2).textContent()) ?? "", /最近评估 · \d{1,2}月\d{1,2}日$/u);
  await page.locator(".bottom-nav button", { hasText: "首页" }).click();

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

  // ---- 学一学（discover）内容页 ----
  // 空库下进入"学一学"：文章 tab 展示空态；方案 tab 在 candidate 门禁下
  // browse plan list 返回空是设计行为，如实提示暂未开放。
  await page.locator(".bottom-nav button", { hasText: "首页" }).click();
  await page.locator(".learn-module").click();
  await page.getByTestId("discover-view").waitFor({ state: "visible" });
  await expectText(
    page.getByTestId("discover-empty"),
    "暂无已发布内容，发布后将出现在这里"
  );
  await page.locator(".discover-tabs button", { hasText: "调理方案" }).click();
  await expectText(page.getByTestId("discover-empty"), "方案内容暂未开放");

  // 管理 CLI 造数（与 e2e 服务同一 SQLite；local/integration 的开发管理员
  // 会话由 KANGMIN_ALLOW_DEV_ADMIN_SESSION 放行，令牌经环境变量传入）。
  const adminEnv = {
    ...process.env,
    KANGMIN_APP_ENV: "integration",
    KANGMIN_ALLOW_DEV_SESSION: "1",
    KANGMIN_ALLOW_DEV_ADMIN_SESSION: "1",
    KANGMIN_DB_PATH: databasePath
  };
  const adminSession = JSON.parse(execFileSync(
    process.execPath,
    [adminSessionScript, "--subject", "e2e-discover-owner"],
    { env: adminEnv, encoding: "utf8" }
  ));
  const runAdmin = (args) => {
    const output = execFileSync(
      process.execPath,
      [adminCli, ...args, "--json"],
      {
        env: { ...adminEnv, KANGMIN_ADMIN_TOKEN: adminSession.adminToken },
        encoding: "utf8"
      }
    );
    const result = JSON.parse(output);
    assert.equal(result.ok, true, `admin 造数失败：${output}`);
    return result.data;
  };
  runAdmin([
    "content", "category", "create",
    "--name", "日常防护",
    "--kind", "article"
  ]);
  const created = runAdmin([
    "content", "article", "create",
    "--title", "换季鼻敏感注意事项",
    "--category", "日常防护",
    "--idempotency-key", "e2e-discover-article"
  ]);
  runAdmin([
    "content", "article", "update", created.id,
    "--expected-revision", "1",
    "--summary", "换季科普摘要",
    "--body", "换季期间注意保暖和清洁，正文内容。",
    "--source", "客户已审核来源"
  ]);
  runAdmin([
    "content", "article", "publish", created.id,
    "--expected-revision", "2",
    "--yes"
  ]);

  // 切回文章 tab：已发布文章出现在列表，点卡片可见详情正文与免责声明。
  await page.locator(".discover-tabs button", { hasText: "科普文章" }).click();
  const articleCard = page.locator(".discover-grid article", {
    hasText: "换季鼻敏感注意事项"
  });
  await articleCard.waitFor({ state: "visible" });
  await articleCard.click();
  await expectText(
    page.getByTestId("discover-detail"),
    "换季期间注意保暖和清洁，正文内容。"
  );
  await expectText(
    page.locator(".discover-detail footer"),
    "不代替门诊诊断"
  );
  await page.locator(".discover-detail > button").click();
  await expectText(
    page.locator(".discover-footer"),
    "不能替代门诊诊断"
  );

  // ---- chat 底部输入接 agent exec（真对话）----
  // dev 无模型 key：降级模式下助手回复为结构化问诊提问，并带固定
  // system_notice 降级提示；conversationId 经 sessionStorage 持久化续聊。
  await page.locator(".bottom-nav button", { hasText: "问助手" }).click();
  const chatInput = page.locator('input[aria-label="输入症状或问题"]');
  await chatInput.waitFor({ state: "visible" });
  await chatInput.fill("我最近鼻塞，晚上比较严重");
  await page.locator(".send-button").click();
  await page.locator(".user-bubble", { hasText: "我最近鼻塞，晚上比较严重" }).waitFor({ state: "visible" });
  await page.locator(".ai-bubble", { hasText: "为了继续评估" }).first().waitFor({ state: "visible" });
  await expectText(page.getByTestId("chat-notice"), "智能提取服务暂不可用");
  const conversationId = await page.evaluate(() =>
    sessionStorage.getItem("kangmin.agent.conversationId")
  );
  assert.ok(conversationId, "首轮发送后应持久化 conversationId");

  // 续聊：携带同一 conversationId，助手回复仍出现且会话 id 不变。
  await chatInput.fill("还有打喷嚏和流清鼻涕");
  await page.locator(".send-button").click();
  await page.locator(".ai-bubble", { hasText: "为了继续评估" }).nth(1).waitFor({ state: "visible" });
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("kangmin.agent.conversationId")),
    conversationId
  );

  // 刷新后同 conversationId 续接，会话不丢。
  await page.reload();
  await page.locator(".demo-shell .bottom-nav").waitFor({ state: "visible" });
  await page.locator(".bottom-nav button", { hasText: "问助手" }).click();
  await chatInput.waitFor({ state: "visible" });
  await chatInput.fill("症状早上更明显");
  await page.locator(".send-button").click();
  await page.locator(".ai-bubble", { hasText: "为了继续评估" }).first().waitFor({ state: "visible" });
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("kangmin.agent.conversationId")),
    conversationId
  );
  process.stdout.write(
    "web-browser-e2e: PASS shell save reflect-update reload restart discover overview-stats chat-exec\n"
  );
} finally {
  await context.close();
  await browser.close();
  if (server.listening) {
    await close(server);
  }
  application.close();
}
