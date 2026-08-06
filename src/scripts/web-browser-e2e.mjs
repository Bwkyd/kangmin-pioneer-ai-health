import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createApplication } from "../dist/app/composition-root.js";
import { createAdminApplicationWithOps } from "../dist/app/admin-composition-root.js";
import { createKangminHttpServer } from "../dist/http/server.js";
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
const mediaDirectory = join(directory, "admin-media");
let application = createApplication(databasePath);
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
  adminObjectStorage: adminOps.objectStorage
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
  // 截图中的仿小程序胶囊和重复悬空“+”已移除，
  // 底部只保留四个有明确去向的导航项。
  assert.equal(await page.locator(".mini-program-menu").count(), 0);
  assert.equal(await page.locator(".nav-add").count(), 0);
  assert.equal(await page.locator(".bottom-nav button").count(), 4);
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
  application = createApplication(databasePath);
  adminOps = createAdminApplicationWithOps(databasePath, { mediaDirectory });
  server = createKangminHttpServer(application, {
    appEnvironment: "integration",
    allowDevelopmentSession: true,
    adminApplication: adminOps.application,
    adminObjectStorage: adminOps.objectStorage
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

  // ---- 管理 Web：真实账号、HttpOnly 会话、文章发布闭环、知识上传 ----
  const adminPage = await context.newPage();
  await adminPage.goto(`${origin}/admin`);
  await adminPage.getByTestId("admin-username").fill("browser-owner");
  await adminPage.getByTestId("admin-password").fill("browser-owner-password");
  await adminPage.getByTestId("admin-login").click();
  await adminPage.getByTestId("admin-nav-overview").waitFor({ state: "visible" });
  assert.deepEqual(await adminPage.evaluate(() => ({
    local: Object.keys(localStorage).filter((key) => /admin|token/iu.test(key)),
    session: Object.keys(sessionStorage).filter((key) => /admin|token/iu.test(key))
  })), { local: [], session: [] });

  await adminPage.getByTestId("admin-nav-article").click();
  await adminPage.getByRole("button", { name: "新增文章" }).click();
  await adminPage.getByPlaceholder("没有合适分类？输入新分类").fill("客户试用");
  await adminPage.getByRole("button", { name: "创建分类" }).click();
  await expectText(adminPage.getByRole("status"), "分类已创建");
  const articleForm = adminPage.locator(".content-form");
  await articleForm.getByLabel("标题").fill("后台发布闭环测试文章");
  await articleForm.getByLabel("摘要").fill("用于确认管理后台发布和下架真实生效");
  await articleForm.getByLabel("正文").fill("这是由管理后台保存的客户试用内容。");
  await articleForm.getByLabel("来源").fill("客户确认材料");
  await articleForm.getByRole("button", { name: "保存草稿" }).click();
  const articleRow = adminPage.locator("tbody tr", { hasText: "后台发布闭环测试文章" });
  await articleRow.waitFor({ state: "visible" });
  await articleRow.getByRole("button", { name: "校验" }).click();
  await expectText(adminPage.getByRole("status"), "校验通过");
  await articleRow.getByRole("button", { name: "发布" }).click();
  await expectText(adminPage.getByRole("status"), "用户端现在可见");

  const patientCheckPage = await context.newPage();
  await patientCheckPage.goto(origin);
  await patientCheckPage.locator(".bottom-nav button", { hasText: "首页" }).click();
  await patientCheckPage.locator(".learn-module").click();
  await patientCheckPage.getByTestId("discover-view").waitFor({ state: "visible" });
  await patientCheckPage.locator(".discover-grid article", { hasText: "后台发布闭环测试文章" }).waitFor({ state: "visible" });

  await adminPage.bringToFront();
  const publishedRow = adminPage.locator("tbody tr", { hasText: "后台发布闭环测试文章" });
  await publishedRow.getByRole("button", { name: "下架" }).click();
  await expectText(adminPage.getByRole("status"), "用户端已不可见");
  await patientCheckPage.reload();
  await patientCheckPage.locator(".bottom-nav button", { hasText: "首页" }).click();
  await patientCheckPage.locator(".learn-module").click();
  await patientCheckPage.getByTestId("discover-view").waitFor({ state: "visible" });
  assert.equal(await patientCheckPage.locator(".discover-grid article", { hasText: "后台发布闭环测试文章" }).count(), 0);
  await patientCheckPage.close();

  await adminPage.getByTestId("admin-nav-media").click();
  await adminPage.getByLabel("选择素材").setInputFiles({
    name: "nasal-care.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])
  });
  await adminPage.getByRole("button", { name: "上传素材" }).click();
  await adminPage.locator(".media-grid article", { hasText: "nasal-care.mp4" }).waitFor({ state: "visible" });

  await adminPage.getByTestId("admin-nav-video").click();
  await adminPage.getByRole("button", { name: "新增视频" }).click();
  await adminPage.getByPlaceholder("没有合适分类？输入新分类").fill("健康视频");
  await adminPage.getByRole("button", { name: "创建分类" }).click();
  const videoForm = adminPage.locator(".content-form");
  await expectText(adminPage.getByRole("status"), "分类已创建");
  assert.equal(await videoForm.getByLabel("分类").inputValue(), "健康视频");
  await videoForm.getByLabel("标题").fill("鼻腔护理演示视频");
  await videoForm.getByLabel("摘要").fill("客户试用版视频发布闭环");
  await videoForm.getByLabel("视频说明").fill("演示日常鼻腔护理步骤，实际操作请遵循专业人员指导。");
  await videoForm.getByLabel("来源").fill("客户确认材料");
  await videoForm.getByLabel("视频文件").selectOption({ label: "nasal-care.mp4" });
  await videoForm.getByLabel("免责声明").fill("仅供健康科普，不替代门诊诊断或治疗建议。");
  await videoForm.getByRole("button", { name: "保存草稿" }).click();
  const videoRow = adminPage.locator("tbody tr", { hasText: "鼻腔护理演示视频" });
  await videoRow.waitFor({ state: "visible" });
  await videoRow.getByRole("button", { name: "校验" }).click();
  await expectText(adminPage.getByRole("status"), "校验通过");
  await videoRow.getByRole("button", { name: "发布" }).click();
  await expectText(adminPage.getByRole("status"), "用户端现在可见");
  await adminPage.locator("tbody tr", { hasText: "鼻腔护理演示视频" }).getByRole("button", { name: "下架" }).click();

  await adminPage.getByTestId("admin-nav-knowledge").click();
  await adminPage.getByLabel("知识来源").fill("客户试用资料");
  await adminPage.getByLabel("选择知识文件").setInputFiles({
    name: "browser-guide.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 鼻健康清洁指南\n\n换季时保持室内清洁并按医嘱处理症状。")
  });
  await adminPage.getByRole("button", { name: "上传知识" }).click();
  const knowledgeRow = adminPage.locator("tbody tr", { hasText: "browser-guide.md" });
  await knowledgeRow.waitFor({ state: "visible" });
  await knowledgeRow.getByRole("button", { name: "建立索引" }).click();
  await adminPage.locator("tbody tr", { hasText: "browser-guide.md" }).getByRole("button", { name: "启用" }).click();
  await adminPage.getByPlaceholder("输入客户可能询问的问题").fill("换季如何清洁");
  await adminPage.getByRole("button", { name: "测试检索" }).click();
  await expectText(adminPage.locator(".search-results"), "保持室内清洁");
  await adminPage.reload();
  await adminPage.getByTestId("admin-nav-overview").waitFor({ state: "visible" });
  await adminPage.close();
  process.stdout.write(
    "web-browser-e2e: PASS fresh-consent isolation save reflect-update health-profile exposure medication reload restart discover overview-stats chat-exec admin-cookie article-publish-unpublish video-upload-publish-unpublish knowledge-upload-index-search\n"
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
