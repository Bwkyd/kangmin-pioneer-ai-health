import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";

import { createApplication } from "../packages/kangmin-runtime/dist/composition-root.js";
import { createAdminApplicationWithOps } from "../packages/kangmin-runtime/dist/admin-composition-root.js";
import { createKangminHttpServer } from "../apps/kangmin-api/dist/server.js";

process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    assert.fail("后台浏览器 E2E 未获得 TCP 地址");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

const directory = mkdtempSync(join(tmpdir(), "kangmin-admin-browser-"));
const databasePath = join(directory, "records.sqlite");
const mediaDirectory = join(directory, "admin-media");
mkdirSync(mediaDirectory, { recursive: true });

const application = createApplication(databasePath);
const adminOps = createAdminApplicationWithOps(databasePath, { mediaDirectory });
const owner = await adminOps.application.execute({
  command: "auth admins add",
  input: {
    username: "browser-owner",
    password: "browser-owner-password",
    role: "owner"
  }
});
assert.equal(owner.ok, true, "后台 E2E 应通过真实命令创建管理员");

const server = createKangminHttpServer(application, {
  appEnvironment: "integration",
  allowDevelopmentSession: true,
  adminApplication: adminOps.application,
  adminObjectStorage: adminOps.objectStorage,
  rateLimits: {
    strictPerWindow: 1_000,
    commandsPerWindow: 1_000,
    uploadPerWindow: 1_000
  }
});
const origin = await listen(server);
const browserExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
const browser = await chromium.launch({
  headless: true,
  ...(browserExecutablePath ? { executablePath: browserExecutablePath } : {})
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const browserErrors = [];
const failedAdminResponses = [];

page.on("console", (message) => {
  if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
page.on("response", (response) => {
  if (response.url().startsWith(`${origin}/v1/admin/`) && response.status() >= 400) {
    failedAdminResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  }
});

try {
  const compatibleRoute = await context.request.get(`${origin}/admin`);
  assert.equal(compatibleRoute.status(), 200, "现有 /admin 网址必须继续提供同一后台");
  assert.match(await compatibleRoute.text(), /admin-root/u);

  await page.goto(origin);
  await page.getByTestId("admin-username").fill("browser-owner");
  await page.getByTestId("admin-password").fill("browser-owner-password");
  await page.getByTestId("admin-login").click();
  await page.getByTestId("admin-nav-overview").waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-testid^="admin-nav-"]').count(), 5, "后台应保持五个侧栏主入口");
  await page.getByRole("heading", { name: "今日待办" }).waitFor({ state: "visible" });
  await page.getByRole("heading", { name: "快捷新建" }).waitFor({ state: "visible" });
  await page.getByRole("heading", { name: "内容概览" }).waitFor({ state: "visible" });

  const browserStorage = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    cookie: document.cookie
  }));
  assert.deepEqual(browserStorage.local.filter((key) => /admin|token/iu.test(key)), []);
  assert.deepEqual(browserStorage.session.filter((key) => /admin|token/iu.test(key)), []);
  assert.doesNotMatch(browserStorage.cookie, /kangmin_admin_session/u, "HttpOnly 会话不能被页面脚本读取");

  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    "390px 工作台不应横向溢出"
  );
  await page.getByTestId("admin-nav-article").click();
  await page.getByLabel("搜索文章").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "新增文章" }).click();
  const articleForm = page.locator(".content-form");
  await articleForm.getByLabel("文章分类").selectOption("article-general");
  await articleForm.getByLabel("标题").fill("后台独立壳端到端文章");
  await articleForm.getByLabel("摘要").fill("验证管理后台独立后仍能保存和发布内容");
  await articleForm.getByLabel("正文", { exact: true }).fill("这是管理后台独立壳的真实浏览器端到端内容。");
  await articleForm.getByText("更多设置（来源、封面）", { exact: true }).click();
  await articleForm.getByLabel("来源").fill("端到端测试");
  await articleForm.getByRole("button", { name: "保存草稿" }).click();
  const articleRow = page.locator("tbody tr", { hasText: "后台独立壳端到端文章" });
  await articleRow.waitFor({ state: "visible" });
  await articleRow.getByRole("button", { name: "发布" }).click();
  await page.getByRole("status").filter({ hasText: "用户端现在可见" }).waitFor({ state: "visible" });
  await page.getByTestId("admin-nav-video").click();
  await page.getByLabel("搜索视频").waitFor({ state: "visible" });
  await page.getByTestId("admin-nav-message").click();
  await page.getByRole("heading", { name: "站内消息", exact: true, level: 2 }).waitFor({ state: "visible" });
  await page.getByLabel("搜索站内消息").waitFor({ state: "visible" });
  await page.getByTestId("admin-nav-knowledge").click();
  await page.getByLabel("搜索知识资料").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "文件管理", exact: true }).click();
  await page.getByRole("heading", { name: "文件管理", exact: true, level: 2 }).waitFor({ state: "visible" });
  await page.getByLabel("文件用途筛选").waitFor({ state: "visible" });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("admin-nav-overview").click();
  const desktopSections = await page.locator(".workbench-section").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, height: box.height };
    })
  );
  assert.equal(desktopSections.length, 3, "桌面工作台应保持三个主区块");
  assert.ok(
    desktopSections.every((box) => box.top >= 0 && box.bottom <= 900 && box.height > 40),
    "1440×900 应完整看到三个工作台区块"
  );

  // 模拟另一个管理端撤销当前会话：真实页面回到前台时必须重新校验，
  // 清空已加载列表并回到登录页，不能继续展示旧的管理数据。
  const adminCookie = (await context.cookies(origin)).find(
    (item) => item.name === "kangmin_admin_session"
  );
  assert.ok(adminCookie !== undefined, "浏览器上下文应持有 HttpOnly 管理会话");
  const revoked = await adminOps.application.execute({
    command: "auth logout",
    adminToken: decodeURIComponent(adminCookie.value),
    requestId: "browser-session-revoked"
  });
  assert.equal(revoked.ok, true, "撤销当前管理会话的操作应成功");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByTestId("admin-login").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("admin-nav-overview").count(), 0, "会话失效后不得继续显示旧导航");

  assert.deepEqual(browserErrors, [], "后台真实浏览器路径不应产生控制台或页面错误");
  assert.deepEqual(failedAdminResponses, [], "后台真实浏览器路径不应产生失败的管理接口请求");

  process.stdout.write("web-browser-e2e: PASS admin-root compatible-admin-route cookie publish five-primary-one-support mobile desktop navigation\n");
} finally {
  await context.close();
  await browser.close();
  if (server.listening) await close(server);
  application.close();
  adminOps.application.close();
}
