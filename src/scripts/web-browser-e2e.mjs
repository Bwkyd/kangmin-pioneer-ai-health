import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createApplication } from "../dist/app/composition-root.js";
import { createAdminApplicationWithOps } from "../dist/app/admin-composition-root.js";
import { createKangminHttpServer } from "../dist/http/server.js";
import { KangminDatabase } from "../dist/infrastructure/database.js";
// 浏览器 E2E 以本地开发模式运行：组合根需要 dev 明文加密降级。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

// 浏览器全链路会在同一进程内集中执行大量真实命令。单独提高测试实例额度，
// 避免用例规模增长后误触生产默认限流；限流行为由 http-ops.e2e 独立验证。
const browserE2eRateLimits = {
  strictPerWindow: 1_000,
  commandsPerWindow: 1_000,
  uploadPerWindow: 1_000
};

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

function dataOf(result, message) {
  assert.equal(result.ok, true, message ?? "命令应成功");
  return result.data;
}

/** 中央新增按钮必须完整收纳在底栏内，避免跨页面遮挡正文。 */
async function expectAddButtonInsideNavigation(page, pageName) {
  const navigationBox = await page.locator(".bottom-nav").boundingBox();
  const addButtonBox = await page.getByTestId("symptom-add-today").boundingBox();
  assert.ok(navigationBox, `${pageName}应显示底部导航`);
  assert.ok(addButtonBox, `${pageName}应显示症状新增按钮`);
  assert.ok(
    addButtonBox.y >= navigationBox.y &&
      addButtonBox.y + addButtonBox.height <= navigationBox.y + navigationBox.height,
    `${pageName}的症状新增按钮不应溢出底栏`
  );
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
const mediaDirectory = join(directory, "admin-media");
mkdirSync(mediaDirectory, { recursive: true });
const browserFollowUps = [];
const browserPlanDialogue = {
  async generatePlan() {
    return "已根据规则结果整理为通俗说明，完整已审核方案如下。";
  },
  async answerFollowUp({ question, sources, context }) {
    browserFollowUps.push({ question, sources, context });
    if (sources.some((source) => source.name === "过敏性鼻炎适宜技术手册·迎香穴")) {
      return "迎香位于鼻翼外缘附近；当前只采用方案列出的指腹擦迎香。";
    }
    assert.ok(context.assessment.answers.some((answer) => answer.fieldCode === "q14"));
    return "我换一种简单说法：这是沿用你刚完成的评估，不需要重新填写问卷。";
  }
};
let application = createApplication(databasePath, { planDialogue: browserPlanDialogue });
let adminOps = createAdminApplicationWithOps(databasePath, { mediaDirectory });
const ownerCreated = await adminOps.application.execute({
  command: "auth admins add",
  input: {
    username: "browser-owner",
    password: "browser-owner-password",
    role: "owner"
  }
});
assert.equal(ownerCreated.ok, true, "浏览器 E2E 应创建真实主管理员");
let server = createKangminHttpServer(application, {
  appEnvironment: "integration",
  allowDevelopmentSession: true,
  adminApplication: adminOps.application,
  adminObjectStorage: adminOps.objectStorage,
  rateLimits: browserE2eRateLimits
});
let origin = await listen(server);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }
});
const page = await context.newPage();
let isolatedContext;

try {
  // 全新数据库首次进入必须先明确授权，测试不直写数据库造假。
  await page.goto(origin);
  await page.getByTestId("preview-consent").waitFor({ state: "visible" });
  await expectText(page.getByTestId("preview-consent"), "不提供诊断或替代门诊建议");
  await expectText(page.getByTestId("preview-consent"), "客户确认结束后");
  await page.getByRole("checkbox").check();
  await page.getByTestId("preview-consent-submit").click();
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

  // ---- 健康档案主线：空态、三类保存和刷新回读 ----
  // 仿小程序胶囊保持移除；底部恢复一个有明确动作的蓝色“+”，
  // 点击后直接进入原有的当天症状录入弹层。
  assert.equal(await page.locator(".mini-program-menu").count(), 0);
  assert.equal(await page.locator(".nav-add").count(), 1);
  assert.equal(await page.locator(".bottom-nav button").count(), 5);
  await page.locator(".bottom-nav button", { hasText: "首页" }).click();
  await expectAddButtonInsideNavigation(page, "首页");
  await page.locator(".bottom-nav button", { hasText: "问助手" }).click();
  await expectAddButtonInsideNavigation(page, "问助手");
  const mascot = page.getByTestId("assistant-mascot");
  await mascot.waitFor({ state: "visible" });
  const mascotBox = await mascot.boundingBox();
  const composerBox = await page.locator(".composer").boundingBox();
  const composerInputBox = await page.locator(".composer input").boundingBox();
  assert.ok(mascotBox && composerBox && composerInputBox, "问助手输入区应显示动画助手");
  const mascotImage = mascot.locator("img");
  await mascotImage.evaluate((image) => {
    if (image.complete) return;
    return new Promise((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => reject(new Error("assistant mascot image failed to load")), { once: true });
    });
  });
  assert.ok(
    await mascotImage.evaluate((image) => image.complete && image.naturalWidth > 0),
    "动画助手资源应成功加载"
  );
  assert.ok(
    mascotBox.y >= composerBox.y - 8 &&
      mascotBox.y + mascotBox.height <= composerBox.y + composerBox.height &&
      mascotBox.x >= composerBox.x &&
      mascotBox.x + mascotBox.width <= composerInputBox.x,
    "动画助手应位于输入区左侧预留位且不遮挡输入文字"
  );
  await page.getByTestId("nav-calendar").click();
  await expectAddButtonInsideNavigation(page, "日历");
  await page.locator(".bottom-nav button", { hasText: "我的" }).click();
  await expectAddButtonInsideNavigation(page, "我的");
  await page.getByRole("button", { name: "健康档案" }).click();
  await page.getByTestId("health-profile-view").waitFor({ state: "visible" });
  await expectText(page.getByTestId("profile-status"), "暂无健康档案");
  assert.equal(
    await page.locator(".health-profile-view .record-notice.error").count(),
    0
  );

  await page.getByTestId("health-profile-edit").click();
  await page.getByLabel("姓名或称呼").fill("体验用户");
  await page.getByLabel("出生日期").fill("1990-01-02");
  await page.getByLabel("性别").selectOption("female");
  await page.getByLabel("过敏史").fill("花粉季节曾有鼻部不适");
  await page.getByRole("button", { name: "保存健康档案" }).click();
  await expectText(page.getByTestId("profile-status"), "健康档案已由服务端确认保存");
  await expectText(page.getByTestId("health-profile-view"), "体验用户");

  await page.getByTestId("exposure-add").click();
  await page.getByRole("heading", { name: "记录接触过的因素" }).waitFor({ state: "visible" });
  // 手机端日期选择应使用卡片完整宽度，不再与重复日期摘要各占一半。
  const linkedDateCard = page.getByTestId("allergen-linked-date");
  const linkedDateInput = linkedDateCard.getByLabel("记录日期");
  const linkedDateCardBox = await linkedDateCard.boundingBox();
  const linkedDateInputBox = await linkedDateInput.boundingBox();
  assert.ok(linkedDateCardBox && linkedDateInputBox, "日期关联卡及输入框应可见");
  assert.ok(
    linkedDateInputBox.width / linkedDateCardBox.width >= 0.85,
    "手机端日期输入应占满日期关联卡可用宽度"
  );
  assert.equal(
    await linkedDateCard.locator("strong").count(),
    0,
    "日期关联卡不应在输入框旁重复展示同一天"
  );
  await linkedDateCard.getByRole("button", { name: "查看当天症状" }).waitFor({ state: "visible" });
  await page.getByRole("checkbox", { name: "花粉" }).check({ force: true });
  await page.getByRole("button", { name: "保存记录" }).click();
  await expectText(page.locator(".exposure-history"), "花粉");
  await page.getByRole("button", { name: "返回" }).click();
  await page.getByTestId("health-profile-view").waitFor({ state: "visible" });
  await expectText(page.getByTestId("health-profile-view"), "花粉");

  await page.getByTestId("medication-add").click();
  await page.getByLabel("药物名称").fill("氯雷他定");
  await page.getByRole("textbox", { name: "剂量", exact: true }).fill("10");
  await page.getByRole("textbox", { name: "单位", exact: true }).fill("mg");
  await page.getByRole("textbox", { name: "实际用量情况", exact: true }).fill("按医嘱服用一次");
  await page.getByRole("button", { name: "保存记录" }).click();
  await expectText(page.getByTestId("medication-history"), "氯雷他定");

  // 刷新后回到默认首页，再进入档案应回读三类真实数据。
  await page.reload();
  await page.locator(".demo-shell .bottom-nav").waitFor({ state: "visible" });
  await page.locator(".bottom-nav button", { hasText: "我的" }).click();
  await page.getByRole("button", { name: "健康档案" }).click();
  await page.getByTestId("health-profile-view").waitFor({ state: "visible" });
  await expectText(page.getByTestId("health-profile-view"), "体验用户");
  await expectText(page.getByTestId("health-profile-view"), "花粉");
  await expectText(page.getByTestId("medication-history"), "氯雷他定");
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
  const symptomTrend = page.getByLabel("本月过敏严重程度趋势图");
  await symptomTrend.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas[aria-label="本月过敏严重程度趋势图"]');
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0 || canvas.height === 0) return false;
    const context = canvas.getContext("2d");
    if (context === null) return false;
    return context.getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0);
  });
  await expectText(page.locator(".trend-card"), "仅根据用户主动保存的症状记录展示，不代表诊断");

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

  // 第二个浏览器必须重新授权，且不得看到第一个客户的记录。
  isolatedContext = await browser.newContext({
    viewport: { width: 390, height: 844 }
  });
  const isolatedPage = await isolatedContext.newPage();
  await isolatedPage.goto(origin);
  await isolatedPage.getByTestId("preview-consent").waitFor({ state: "visible" });
  await isolatedPage.getByRole("checkbox").check();
  await isolatedPage.getByTestId("preview-consent-submit").click();
  await isolatedPage.locator(".demo-shell .bottom-nav").waitFor({ state: "visible" });
  await expectText(
    isolatedPage.getByTestId("home-overview"),
    "暂无真实健康记录"
  );
  await isolatedContext.close();
  isolatedContext = undefined;

  // 服务重启（同一 SQLite）后，新开发会话仍解析到同一患者记录。
  await close(server);
  application.close();
  adminOps.application.close();
  application = createApplication(databasePath, { planDialogue: browserPlanDialogue });
  adminOps = createAdminApplicationWithOps(databasePath, { mediaDirectory });
  server = createKangminHttpServer(application, {
    appEnvironment: "integration",
    allowDevelopmentSession: true,
    adminApplication: adminOps.application,
    adminObjectStorage: adminOps.objectStorage,
    rateLimits: browserE2eRateLimits
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
  // 空库下进入"学一学"：默认进入成人视频分类目录；规则包虽已启用，
  // 但数据库没有已启用方案，browse plan list 仍应如实提示暂未开放。
  await page.locator(".bottom-nav button", { hasText: "首页" }).click();
  await page.locator(".learn-module").click();
  await page.getByTestId("discover-view").waitFor({ state: "visible" });
  await expectText(
    page.getByTestId("discover-empty"),
    "该分类暂无已发布视频"
  );
  await expectText(page.getByTestId("discover-video-catalog"), "快速通窍方案");
  await page.locator(".discover-category-rail button", { hasText: "调体方案" }).click();
  await expectText(page.getByTestId("discover-video-catalog"), "肺气虚寒");
  await page.getByRole("button", { name: "儿童方案" }).click();
  await expectText(page.getByTestId("discover-video-catalog"), "调体方案");
  await page.locator(".discover-tabs button", { hasText: "调理方案" }).click();
  await expectText(page.getByTestId("discover-empty"), "方案内容暂未开放");

  // 为诊一诊动态方案浏览器路径准备真实 SQLite 数据：走管理应用创建并启用
  // 两个方案和一条知识，不注入方案注册表/知识检索替身，不污染仓库本地库。
  const planDataSession = await adminOps.application.sessions.createDevelopmentSession(
    "e2e-plan-dialogue-owner"
  );
  const planAdminToken = planDataSession.token;
  const createAndEnableBrowserPlan = async (input) => {
    const createdPlan = dataOf(await adminOps.application.execute({
      command: "agent plan create",
      adminToken: planAdminToken,
      input: {
        ...input,
        audience: "adult",
        precautions: "仅用于自动化验证，不作为真实操作说明。",
        risks: "测试数据不替代已审核医学资料。",
        contraindications: "真实使用前必须由客户启用正式方案。"
      }
    }), "浏览器 E2E 应创建方案");
    return dataOf(await adminOps.application.execute({
      command: "agent plan enable",
      adminToken: planAdminToken,
      input: {
        id: createdPlan.id,
        expectedRevision: createdPlan.revision,
        yes: true
      }
    }), "浏览器 E2E 应启用方案");
  };
  await createAndEnableBrowserPlan({
    name: "急性期迎香测试方案",
    syndrome: "ACUTE",
    phaseCode: "acute",
    method: "指腹擦迎香",
    steps: ["指腹擦迎香"]
  });
  await createAndEnableBrowserPlan({
    name: "寒热错杂测试调体方案",
    syndrome: "COLD_HEAT_COMPLEX",
    method: "肺俞、风门、大椎、耳穴过敏区",
    steps: ["肺俞", "风门", "大椎", "耳穴过敏区"]
  });
  const planKnowledgeFile = join(mediaDirectory, "迎香测试资料.md");
  writeFileSync(
    planKnowledgeFile,
    "# 迎香测试资料\n\n迎香位于鼻翼外缘附近。当前测试方案采用指腹擦迎香。"
  );
  const planKnowledge = dataOf(await adminOps.application.execute({
    command: "agent knowledge add",
    adminToken: planAdminToken,
    input: { file: planKnowledgeFile, source: "客户授权测试资料" }
  }), "浏览器 E2E 应添加知识");
  const namedPlanKnowledge = dataOf(await adminOps.application.execute({
    command: "agent knowledge update",
    adminToken: planAdminToken,
    input: {
      id: planKnowledge.id,
      name: "过敏性鼻炎适宜技术手册·迎香穴",
      source: "客户授权测试资料"
    }
  }), "浏览器 E2E 应更新知识名称");
  const indexedPlanKnowledge = dataOf(await adminOps.application.execute({
    command: "agent knowledge index",
    adminToken: planAdminToken,
    input: { id: namedPlanKnowledge.id }
  }), "浏览器 E2E 应建立知识索引");
  dataOf(await adminOps.application.execute({
    command: "agent knowledge enable",
    adminToken: planAdminToken,
    input: { id: indexedPlanKnowledge.id, yes: true }
  }), "浏览器 E2E 应启用知识");

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

  // ---- chat：页面严格按《页面展示》Q1-Q14，规则按《前置规则》----
  await page.locator(".bottom-nav button", { hasText: "问助手" }).click();
  const chatInput = page.locator('input[aria-label="输入症状或问题"]');
  await chatInput.waitFor({ state: "visible" });
  await chatInput.fill("我最近鼻塞，晚上比较严重");
  await page.locator(".send-button").click();
  await page.locator(".user-bubble", { hasText: "我最近鼻塞，晚上比较严重" }).waitFor({ state: "visible" });
  await page.locator(".question-card", { hasText: "您打喷嚏的情况是" }).waitFor({ state: "visible" });
  await expectText(page.getByTestId("chat-notice"), "未识别到您的回答");
  const conversationId = await page.evaluate(() =>
    sessionStorage.getItem("kangmin.agent.conversationId")
  );
  assert.ok(conversationId, "首轮发送后应持久化 conversationId");

  await page.locator(".question-card-options button", { hasText: "偶尔打喷嚏" }).click();
  await page.locator(".question-card", { hasText: "您的鼻涕通常是" }).waitFor({ state: "visible" });

  // 自由文本无法替代当前结构化选项，仍停留 Q2；会话 ID 不变。
  await chatInput.fill("还有打喷嚏和流清鼻涕");
  await page.locator(".send-button").click();
  await page.getByTestId("chat-notice").nth(1).waitFor({ state: "visible" });
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("kangmin.agent.conversationId")),
    conversationId
  );

  // 刷新后从服务端恢复完整有序消息与 Q2。
  await page.reload();
  await page.locator(".demo-shell .bottom-nav").waitFor({ state: "visible" });
  await page.locator(".bottom-nav button", { hasText: "问助手" }).click();
  await chatInput.waitFor({ state: "visible" });
  await page.locator(".user-bubble", { hasText: "我最近鼻塞，晚上比较严重" }).waitFor({ state: "visible" });
  await page.locator(".user-bubble", { hasText: "还有打喷嚏和流清鼻涕" }).waitFor({ state: "visible" });
  await page.locator(".question-card", { hasText: "您的鼻涕通常是" }).waitFor({ state: "visible" });
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("kangmin.agent.conversationId")),
    conversationId
  );

  // 模拟部署后规则包升级：旧会话第一次续答即废弃；选项不得乐观追加，
  // 页面只提示一次“请新建对话”，从根上覆盖客户截图中的重复“不清楚”。
  const upgradeDatabase = new KangminDatabase(databasePath);
  try {
    upgradeDatabase.connection
      .prepare(`UPDATE agent_conversations
                SET rule_package_version = 'clinical-rules-v2-stale',
                    rule_package_hash = 'stale-hash'
                WHERE id = ?`)
      .run(conversationId);
  } finally {
    upgradeDatabase.close();
  }
  const q2AnswerCountBefore = await page.locator(".user-bubble", { hasText: "清水样" }).count();
  await page.locator(".question-card-options button", { hasText: "清水样" }).click();
  await page.locator(".conversation-ended").waitFor({ state: "visible" });
  await expectText(page.locator(".conversation-ended"), "评估规则已更新，请新建对话后重新评估");
  assert.equal(await chatInput.isDisabled(), true);
  assert.equal(
    await page.locator(".user-bubble", { hasText: "清水样" }).count(),
    q2AnswerCountBefore,
    "规则升级失败的选项不得写进聊天历史"
  );

  // 新会话完整走客户真实路径：Q1-Q11 → 两个独立确认节点 → Q12-Q14。
  await page.getByTestId("chat-new").click();
  await chatInput.fill("开始评估");
  await page.locator(".send-button").click();
  await page.locator(".question-card", { hasText: "您打喷嚏的情况是" }).waitFor({ state: "visible" });
  await page.locator(".question-card-options button", { hasText: "基本不打喷嚏" }).click();
  const pagePath = [
    ["您的鼻涕通常是", "白黏鼻涕"],
    ["您的鼻塞情况是", "左右交替鼻塞"],
    ["您的鼻痒程度", "不痒"],
    ["什么情况下容易发作或加重", "无明显规律"],
    ["是否比别人更怕风、怕冷", "稍微有一点"],
    ["您是否容易感冒", "很少感冒"],
    ["是否经常感觉疲倦、没力气", "没有"],
    ["手脚是否经常冰凉", "一年四季手脚都凉"],
    ["是否经常感觉口干、想喝水", "偶尔口干"],
    ["哪项最符合您的日常感觉", "以上都不明显"],
    ["是否经常感觉疲倦、没力气", "偶尔有"],
    ["是否经常感觉口干、想喝水", "经常口干，想喝凉的"],
    ["最近 1 周", "基本没有"],
    ["目前最迫切想解决的问题", "调理体质"],
    ["症状发作时", "长期处于"]
  ];
  for (const [questionText, optionText] of pagePath) {
    const card = page.locator(".question-card", { hasText: questionText });
    await card.waitFor({ state: "visible" });
    await card.locator("button", { hasText: optionText }).click();
  }
  const sixStepResult = page.locator(".result-card", { hasText: "寒热错杂" });
  await sixStepResult.waitFor({ state: "visible" });
  await page.locator(".conversation-ended").waitFor({ state: "visible" });
  const completedMascotBox = await page.getByTestId("assistant-mascot").boundingBox();
  const completedNoticeBox = await page.locator(".conversation-ended").boundingBox();
  assert.ok(completedMascotBox && completedNoticeBox, "评估完成后应同时显示助手和状态提示");
  assert.ok(
    completedMascotBox.y >= completedNoticeBox.y + completedNoticeBox.height,
    "动画助手不应遮挡评估完成提示"
  );
  assert.match((await sixStepResult.textContent()) ?? "", /寒热错杂/u);
  await expectText(page.locator(".conversation-ended"), "可以继续追问当前方案");
  assert.equal(await chatInput.isDisabled(), false);
  await chatInput.fill("迎香穴具体位置在哪里？");
  await page.evaluate(() => {
    globalThis.__kangminStreamLengths = [];
    const chat = document.querySelector(".chat");
    const observer = new MutationObserver(() => {
      const current = document.querySelector('[data-testid="streaming-response"]');
      if (current instanceof HTMLElement) {
        globalThis.__kangminStreamLengths.push(current.innerText.length);
      }
    });
    if (chat !== null) observer.observe(chat, { childList: true, subtree: true, characterData: true });
    globalThis.__kangminStreamObserver = observer;
  });
  await page.locator(".send-button").click();
  await page.locator(".user-bubble", { hasText: "迎香穴具体位置在哪里" }).waitFor({ state: "visible" });
  await page.getByTestId("streaming-response").waitFor({ state: "visible" });
  await page.locator(".typing").waitFor({ state: "detached" });
  await expectText(page.locator(".chat"), "迎香位于鼻翼外缘附近");
  await expectText(page.locator(".chat"), "过敏性鼻炎适宜技术手册·迎香穴");
  const streamLengths = await page.evaluate(() => {
    globalThis.__kangminStreamObserver?.disconnect();
    return globalThis.__kangminStreamLengths ?? [];
  });
  const positiveStreamLengths = [...new Set(streamLengths.filter((length) => length > 0))];
  assert.ok(positiveStreamLengths.length >= 2, "患者端应观察到至少两次递增的流式正文");

  // 刷新后结果、追问与可继续输入状态都从服务端恢复。
  await page.reload();
  await page.locator(".bottom-nav button", { hasText: "问助手" }).click();
  await page.locator(".result-card", { hasText: "寒热错杂" }).waitFor({ state: "visible" });
  await expectText(page.locator(".chat"), "迎香位于鼻翼外缘附近");
  await expectText(page.locator(".conversation-ended"), "可以继续追问当前方案");
  assert.equal(await chatInput.isDisabled(), false);
  await page.waitForFunction(() => {
    const chat = document.querySelector(".chat");
    return chat instanceof HTMLElement &&
      chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 2;
  });

  // 新建聊天继承患者级评估：不再出现 Q1；承接式追问使用完整问卷与最近对话。
  await page.getByTestId("chat-new").click();
  await page.locator(".start-card", { hasText: "沿用最近评估开始聊天" }).click();
  await expectText(page.locator(".chat"), "不需要重新填写问卷");
  assert.equal(await page.locator(".question-card").count(), 0);
  await chatInput.fill("我不明白");
  await page.locator(".send-button").click();
  await page.locator(".typing").waitFor({ state: "detached" });
  await expectText(page.locator(".chat"), "我换一种简单说法");
  const contextual = browserFollowUps.at(-1);
  assert.equal(contextual.question, "我不明白");
  assert.ok(contextual.context.recentMessages.some(
    (message) => message.role === "assistant" && message.content.includes("不需要重新填写问卷")
  ));
  assert.ok(contextual.context.assessment.answers.some((answer) => answer.fieldCode === "q1"));
  assert.ok(contextual.context.assessment.answers.some((answer) => answer.fieldCode === "q14"));

  // ---- 管理 Web：真实账号、HttpOnly 会话、文章发布闭环、知识上传 ----
  const adminPage = await context.newPage();
  await adminPage.goto(`${origin}/admin`);
  await adminPage.getByTestId("admin-username").fill("browser-owner");
  await adminPage.getByTestId("admin-password").fill("browser-owner-password");
  await adminPage.getByTestId("admin-login").click();
  await adminPage.getByTestId("admin-nav-overview").waitFor({ state: "visible" });
  await adminPage.getByRole("heading", { name: "今天先处理最重要的任务" }).waitFor({ state: "visible" });
  const adminNavLabels = await adminPage.locator(".admin-nav-label").allTextContents();
  assert.ok(adminNavLabels.includes("内容运营"), "管理后台应显示内容运营分组");
  assert.ok(adminNavLabels.includes("消息与素材"), "管理后台应显示消息与素材分组");
  await adminPage.getByRole("heading", { name: "从内容开始" }).waitFor({ state: "visible" });
  const overviewCopy = await adminPage.locator(".admin-shell").innerText();
  assert.doesNotMatch(overviewCopy, /报价|交付/u, "工作台不应显示报价或交付内部话术");
  await adminPage.getByText("校验", { exact: true }).waitFor({ state: "visible" });
  await adminPage.getByText("服务端同步", { exact: true }).waitFor({ state: "visible" });
  await adminPage.getByText("可用素材", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await adminPage.getByRole("link", { name: /查看用户端/u }).count(), 0, "管理后台不再跳转患者 Web，患者入口统一为小程序");
  assert.deepEqual(await adminPage.evaluate(() => ({
    local: Object.keys(localStorage).filter((key) => /admin|token/iu.test(key)),
    session: Object.keys(sessionStorage).filter((key) => /admin|token/iu.test(key))
  })), { local: [], session: [] });

  await adminPage.getByTestId("admin-nav-article").click();
  await adminPage.getByText("内容运营 / 科普内容", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await adminPage.getByRole("button", { name: "回到工作台" }).count(), 0, "内容页不应显示返回工作台按钮");
  await adminPage.getByLabel("搜索文章").waitFor({ state: "visible" });
  await adminPage.getByLabel("筛选文章状态").waitFor({ state: "visible" });
  await adminPage.getByRole("button", { name: "新增文章" }).click();
  const blankArticleForm = adminPage.locator(".content-form");
  await blankArticleForm.getByRole("button", { name: "保存草稿" }).click();
  await expectText(adminPage.getByRole("status"), "文章草稿已保存");
  await adminPage.locator("tbody tr").first().getByRole("button", { name: "编辑" }).click();
  await adminPage.getByPlaceholder("没有合适分类？输入新分类").fill("客户试用");
  await adminPage.getByRole("button", { name: "创建分类" }).click();
  await expectText(adminPage.getByRole("status"), "分类已创建");
  const articleForm = adminPage.locator(".content-form");
  await articleForm.getByLabel("标题").fill("后台发布闭环测试文章");
  await articleForm.getByLabel("摘要").fill("用于确认管理后台发布和下架真实生效");
  await articleForm.getByLabel("正文", { exact: true }).fill("这是由管理后台保存的客户试用内容。");
  await articleForm.getByLabel("上传正文图片或附件").setInputFiles({
    name: "nose-care.png",
    mimeType: "image/png",
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52])
  });
  await expectText(adminPage.getByRole("status"), "正文素材已上传并插入");
  await articleForm.getByLabel("来源").fill("客户确认材料");
  await articleForm.getByRole("button", { name: "保存草稿" }).click();
  const articleRow = adminPage.locator("tbody tr", { hasText: "后台发布闭环测试文章" });
  await articleRow.waitFor({ state: "visible" });
  await adminPage.getByLabel("搜索文章").fill("后台发布闭环测试文章");
  assert.equal(await adminPage.locator("tbody tr").count(), 1, "文章搜索应只保留匹配内容");
  await adminPage.getByLabel("搜索文章").fill("");
  await adminPage.getByTestId("admin-nav-overview").click();
  await adminPage.getByRole("button", { name: /文章草稿/u }).waitFor({ state: "visible" });
  await adminPage.getByRole("button", { name: /处理文章/u }).click();
  await adminPage.getByTestId("admin-nav-article").waitFor({ state: "visible" });
  assert.equal(await adminPage.getByLabel("筛选文章状态").inputValue(), "draft", "文章待办应自动定位到草稿状态");
  await articleRow.getByRole("button", { name: "编辑" }).click();
  await articleForm.getByLabel("摘要").fill("编辑后用于确认管理后台发布和下架真实生效");
  const articleBodyMedia = await articleForm.getByLabel("正文", { exact: true }).inputValue();
  await articleForm.getByLabel("正文", { exact: true }).fill("这是由管理后台编辑并保存的客户试用内容。\n\n" + articleBodyMedia);
  await articleForm.getByRole("button", { name: "保存草稿" }).click();
  await expectText(adminPage.getByRole("status"), "文章草稿已保存");
  await expectText(articleRow, "编辑后用于确认");
  await articleRow.getByRole("button", { name: "校验" }).click();
  await expectText(adminPage.locator(".admin-toast"), "患者端预览已打开");
  const articlePreview = adminPage.getByRole("dialog", { name: "患者端预览" });
  await articlePreview.waitFor({ state: "visible" });
  await expectText(articlePreview, "这是由管理后台编辑并保存的客户试用内容。");
  assert.equal(await articlePreview.locator("img").count(), 1, "患者端预览应显示正文图片");
  await articlePreview.getByRole("button", { name: "关闭患者端预览" }).click();
  await articleRow.getByRole("button", { name: "发布" }).click();
  await expectText(adminPage.getByRole("status"), "用户端现在可见");

  const patientCheckPage = await context.newPage();
  await patientCheckPage.goto(origin);
  await patientCheckPage.locator(".bottom-nav button", { hasText: "首页" }).click();
  await patientCheckPage.locator(".learn-module").click();
  await patientCheckPage.getByTestId("discover-view").waitFor({ state: "visible" });
  await patientCheckPage.locator(".discover-tabs button", { hasText: "科普文章" }).click();
  const editedArticleCard = patientCheckPage.locator(".discover-grid article", { hasText: "后台发布闭环测试文章" });
  await editedArticleCard.waitFor({ state: "visible" });
  await editedArticleCard.click();
  await expectText(patientCheckPage.getByTestId("discover-detail"), "管理后台编辑并保存");

  await adminPage.bringToFront();
  const publishedRow = adminPage.locator("tbody tr", { hasText: "后台发布闭环测试文章" });
  await publishedRow.getByRole("button", { name: "下架" }).click();
  await expectText(adminPage.getByRole("status"), "用户端已不可见");
  await patientCheckPage.reload();
  await patientCheckPage.locator(".bottom-nav button", { hasText: "首页" }).click();
  await patientCheckPage.locator(".learn-module").click();
  await patientCheckPage.getByTestId("discover-view").waitFor({ state: "visible" });
  await patientCheckPage.locator(".discover-tabs button", { hasText: "科普文章" }).click();
  assert.equal(await patientCheckPage.locator(".discover-grid article", { hasText: "后台发布闭环测试文章" }).count(), 0);
  await patientCheckPage.close();

  await adminPage.getByTestId("admin-nav-message").click();
  await adminPage.getByText("消息与素材 / 应用内推送", { exact: true }).waitFor({ state: "visible" });
  await adminPage.getByRole("button", { name: "新建消息" }).click();
  const messageForm = adminPage.locator(".content-form");
  await messageForm.getByLabel("标题").fill("换季鼻健康提醒");
  await messageForm.getByLabel("摘要").fill("后台到患者端站内消息闭环");
  await messageForm.getByLabel("正文", { exact: true }).fill("请按需查看已发布的鼻健康科普内容。");
  await messageForm.getByRole("button", { name: "保存草稿" }).click();
  const messageRow = adminPage.locator("tbody tr", { hasText: "换季鼻健康提醒" });
  await messageRow.waitFor({ state: "visible" });
  await messageRow.getByRole("button", { name: "编辑" }).click();
  await messageForm.getByLabel("摘要").fill("编辑后的后台到患者端站内消息闭环");
  await messageForm.getByRole("button", { name: "保存草稿" }).click();
  await expectText(adminPage.getByRole("status"), "站内消息已保存");
  await expectText(messageRow, "编辑后的后台到患者端");
  await messageRow.getByRole("button", { name: "发布" }).click();
  await expectText(adminPage.getByRole("status"), "登录用户现在可见");

  const messageCheckPage = await context.newPage();
  await messageCheckPage.goto(origin);
  await messageCheckPage.locator(".bottom-nav button", { hasText: "我的" }).click();
  await messageCheckPage.getByRole("button", { name: /消息中心/u }).click();
  const patientMessage = messageCheckPage.locator(".message-list button", { hasText: "换季鼻健康提醒" });
  await patientMessage.waitFor({ state: "visible" });
  await patientMessage.click();
  await expectText(messageCheckPage.locator(".message-detail"), "请按需查看已发布的鼻健康科普内容");
  await messageCheckPage.getByRole("button", { name: "返回消息列表" }).click();
  assert.equal(await messageCheckPage.locator(".message-dot.read").count(), 1, "打开消息后应保存患者级已读状态");

  await adminPage.bringToFront();
  await adminPage.locator("tbody tr", { hasText: "换季鼻健康提醒" }).getByRole("button", { name: "下架" }).click();
  await expectText(adminPage.getByRole("status"), "消息已下架");
  await messageCheckPage.reload();
  await messageCheckPage.locator(".bottom-nav button", { hasText: "我的" }).click();
  await messageCheckPage.getByRole("button", { name: /消息中心/u }).click();
  assert.equal(await messageCheckPage.locator(".message-list button", { hasText: "换季鼻健康提醒" }).count(), 0);
  await messageCheckPage.close();

  await adminPage.getByTestId("admin-nav-media").click();
  await adminPage.getByLabel("选择素材").setInputFiles({
    name: "nasal-care.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])
  });
  await adminPage.getByRole("button", { name: "上传素材" }).click();
  await adminPage.locator(".media-grid article", { hasText: "nasal-care.mp4" }).waitFor({ state: "visible" });

  await adminPage.getByTestId("admin-nav-video").click();
  await adminPage.getByText("内容运营 / 视频内容", { exact: true }).waitFor({ state: "visible" });
  await adminPage.getByRole("button", { name: "新增视频" }).click();
  await adminPage.getByPlaceholder("没有合适分类？输入新分类").fill("成人快速通窍");
  await adminPage.getByRole("button", { name: "创建分类" }).click();
  const videoForm = adminPage.locator(".content-form");
  await expectText(adminPage.getByRole("status"), "分类已创建");
  assert.equal(await videoForm.getByLabel("分类").inputValue(), "成人快速通窍");
  await videoForm.getByLabel("标题").fill("抗敏要穴之迎香穴（指腹擦迎香）");
  await videoForm.getByLabel("摘要").fill("客户试用版视频发布闭环");
  await videoForm.getByLabel("视频说明").fill("演示日常鼻腔护理步骤，实际操作请遵循专业人员指导。");
  await videoForm.getByLabel("来源").fill("客户确认材料");
  await videoForm.getByLabel("直接上传视频文件").setInputFiles({
    name: "nasal-care.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])
  });
  await expectText(adminPage.getByRole("status"), "视频文件已上传并已选中");
  await videoForm.getByLabel("操作提示").fill("操作前确认环境安全，并按视频步骤进行。");
  await videoForm.getByLabel("注意事项").fill("出现不适立即停止，并咨询专业人员。");
  await videoForm.getByLabel("免责声明").fill("仅供健康科普，不替代门诊诊断或治疗建议。");
  await videoForm.getByRole("button", { name: "保存草稿" }).click();
  const videoRow = adminPage.locator("tbody tr", { hasText: "抗敏要穴之迎香穴" });
  await videoRow.waitFor({ state: "visible" });
  await videoRow.getByRole("button", { name: "编辑" }).click();
  await videoForm.getByLabel("摘要").fill("编辑后的客户试用版视频发布闭环");
  await videoForm.getByLabel("视频说明").fill("这是编辑后的日常鼻腔护理步骤，实际操作请遵循专业人员指导。");
  await videoForm.getByRole("button", { name: "保存草稿" }).click();
  await expectText(adminPage.getByRole("status"), "视频草稿已保存");
  await expectText(videoRow, "编辑后的客户试用版");
  await videoRow.getByRole("button", { name: "校验" }).click();
  await expectText(adminPage.locator(".admin-toast"), "患者端预览已打开");
  const videoPreview = adminPage.getByRole("dialog", { name: "患者端预览" });
  await videoPreview.waitFor({ state: "visible" });
  await expectText(videoPreview, "操作前确认环境安全，并按视频步骤进行。");
  await expectText(videoPreview, "出现不适立即停止，并咨询专业人员。");
  assert.equal(await videoPreview.locator("video").count(), 1, "患者端预览应显示视频");
  await videoPreview.getByRole("button", { name: "关闭患者端预览" }).click();
  await videoRow.getByRole("button", { name: "发布" }).click();
  await expectText(adminPage.getByRole("status"), "用户端现在可见");
  const videoCheckPage = await context.newPage();
  await videoCheckPage.goto(origin);
  await videoCheckPage.locator(".bottom-nav button", { hasText: "首页" }).click();
  await videoCheckPage.locator(".learn-module").click();
  const publishedVideoCard = videoCheckPage.locator(".discover-video-list article", { hasText: "抗敏要穴之迎香穴" });
  await publishedVideoCard.waitFor({ state: "visible" });
  await publishedVideoCard.click();
  await expectText(videoCheckPage.getByTestId("discover-detail"), "这是编辑后的日常鼻腔护理步骤");
  await expectText(videoCheckPage.getByTestId("discover-detail"), "操作前确认环境安全，并按视频步骤进行。");
  await expectText(videoCheckPage.getByTestId("discover-detail"), "出现不适立即停止，并咨询专业人员。");
  assert.equal(await videoCheckPage.locator(".discover-detail-video").count(), 1);
  await videoCheckPage.close();
  await adminPage.locator("tbody tr", { hasText: "抗敏要穴之迎香穴" }).getByRole("button", { name: "下架" }).click();

  await adminPage.getByTestId("admin-nav-knowledge").click();
  await adminPage.getByText("内容运营 / 受控知识生效", { exact: true }).waitFor({ state: "visible" });
  await adminPage.getByLabel("知识来源").fill("客户试用资料");
  await adminPage.getByLabel("选择知识文件").setInputFiles({
    name: "browser-guide.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 鼻健康清洁指南\n\n换季时保持室内清洁并按医嘱处理症状。")
  });
  await adminPage.getByRole("button", { name: "上传知识" }).click();
  const knowledgeRow = adminPage.locator("tbody tr", { hasText: "browser-guide.md" });
  await knowledgeRow.waitFor({ state: "visible" });
  await expectText(knowledgeRow, "待建索引");
  await knowledgeRow.getByRole("button", { name: "编辑" }).click();
  const knowledgeEditForm = adminPage.getByTestId("knowledge-edit-form");
  await knowledgeEditForm.waitFor({ state: "visible" });
  assert.equal(await knowledgeEditForm.getByLabel("知识名称").inputValue(), "browser-guide.md");
  await knowledgeEditForm.getByLabel("知识名称").fill("不应保存的名称");
  await knowledgeEditForm.getByRole("button", { name: "取消编辑" }).click();
  assert.equal(await adminPage.getByTestId("knowledge-edit-form").count(), 0);
  await expectText(knowledgeRow, "browser-guide.md");
  assert.doesNotMatch(await knowledgeRow.innerText(), /不应保存的名称/u);
  await knowledgeRow.getByRole("button", { name: "编辑" }).click();
  const reopenedKnowledgeEditForm = adminPage.getByTestId("knowledge-edit-form");
  await reopenedKnowledgeEditForm.getByLabel("知识名称").fill("   ");
  await reopenedKnowledgeEditForm.getByRole("button", { name: "保存修改" }).click();
  await expectText(reopenedKnowledgeEditForm.getByRole("alert"), "知识名称不能为空");
  await reopenedKnowledgeEditForm.getByLabel("知识名称").fill("鼻健康清洁指南");
  await reopenedKnowledgeEditForm.getByLabel("知识分类（可留空）").fill("日常防护");
  await reopenedKnowledgeEditForm.getByLabel("来源说明（可留空）").fill("客户试用资料·已复核");
  await reopenedKnowledgeEditForm.getByRole("button", { name: "保存修改" }).click();
  await expectText(adminPage.getByRole("status"), "知识资料已更新");
  assert.equal(await adminPage.getByTestId("knowledge-edit-form").count(), 0);
  const updatedKnowledgeRow = adminPage.locator("tbody tr", { hasText: "鼻健康清洁指南" });
  await expectText(updatedKnowledgeRow, "日常防护");
  await expectText(updatedKnowledgeRow, "客户试用资料·已复核");
  await updatedKnowledgeRow.getByRole("button", { name: "建立索引" }).click();
  await expectText(adminPage.getByRole("status"), "索引已建立");
  await expectText(updatedKnowledgeRow, "已建索引");
  await adminPage.getByTestId("admin-nav-overview").click();
  await expectText(adminPage.getByRole("button", { name: /知识索引/u }), "索引已完成，启用后参与检索");
  assert.equal(await adminPage.locator(".queue-card .queue-count").innerText(), "1", "已建索引任务应计入首页待办总数");
  await adminPage.getByRole("button", { name: /知识索引/u }).click();
  await updatedKnowledgeRow.waitFor({ state: "visible" });
  assert.equal(await adminPage.getByLabel("筛选知识状态").inputValue(), "indexed", "知识待办应自动定位到已建索引状态");
  await updatedKnowledgeRow.getByRole("button", { name: "启用" }).click();
  await expectText(adminPage.getByRole("status"), "知识已启用");
  await expectText(updatedKnowledgeRow, "已启用");
  await adminPage.getByPlaceholder("输入客户可能询问的问题").fill("保持室内清洁");
  await adminPage.getByRole("button", { name: "测试检索" }).click();
  await expectText(adminPage.locator(".search-results"), "保持室内清洁");
  await updatedKnowledgeRow.getByRole("button", { name: "停用" }).click();
  await expectText(adminPage.getByRole("status"), "知识已停用");
  await expectText(updatedKnowledgeRow, "已停用");
  adminPage.once("dialog", (dialog) => void dialog.accept());
  await updatedKnowledgeRow.getByRole("button", { name: "删除" }).click();
  await expectText(adminPage.getByRole("status"), "知识资料已删除");
  assert.equal(await adminPage.locator("tbody tr", { hasText: "鼻健康清洁指南" }).count(), 0);
  await adminPage.reload();
  await adminPage.getByTestId("admin-nav-overview").waitFor({ state: "visible" });
  await adminPage.close();
  process.stdout.write(
    "web-browser-e2e: PASS fresh-consent isolation save reflect-update health-profile exposure medication calendar-trend reload restart discover overview-stats chat-exec plan-dialogue-follow-up admin-cookie article-edit-publish-unpublish message-edit-publish-read-unpublish video-upload-edit-publish-unpublish knowledge-upload-update-index-search-disable-delete\n"
  );
} finally {
  if (isolatedContext !== undefined) {
    await isolatedContext.close();
  }
  await context.close();
  await browser.close();
  if (server.listening) {
    await close(server);
  }
  application.close();
  adminOps.application.close();
}
