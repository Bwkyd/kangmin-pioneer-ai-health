import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(TEST_DIR, "../..");
const VINEXT_CLI = path.join(PROJECT_DIR, "node_modules/vinext/dist/cli.js");
const ADMIN_USERNAME = "codex-issue-98-99";
const ADMIN_PASSWORD_HASH = "210000.TmOqCeBFFm8aA5jC02Zhvw==.ZtRn0gaf/EkpWN5NamVIOv+IUm5H/+IJPU10bWLDOlU=";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务提前退出：${output.join("")}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待服务启动超时：${output.join("")}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000)),
  ]);
}

async function request(baseUrl, pathname, init = {}, cookie = "") {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* 只在需要时读取 JSON。 */ }
  return { response, body, text };
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie") ?? "";
  return value.split(";", 1)[0];
}

test("Issue #98/#99 临床候选按版本审核并阻断未审核发布", async () => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const cloudflareEnv = `codex-issue-98-99-${process.pid}`;
  const devVarsPath = path.join(PROJECT_DIR, `.dev.vars.${cloudflareEnv}`);
  await writeFile(devVarsPath, [
    `ADMIN_USERNAME='${ADMIN_USERNAME}'`,
    `ADMIN_PASSWORD_HASH='${ADMIN_PASSWORD_HASH}'`,
    "ADMIN_SESSION_SECRET='codex-issue-98-99-session'",
    `CLINICAL_APPROVER_USERS='${ADMIN_USERNAME}'`,
    "APP_ENV='local'",
    "HEALTH_IDENTITY_MODE='synthetic'",
    "HEALTH_SYNTHETIC_USER_ID='usr_issue_98_99'",
  ].join("\n") + "\n", { flag: "wx" });
  const child = spawn(process.execPath, [VINEXT_CLI, "dev", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      CLOUDFLARE_ENV: cloudflareEnv,
      ADMIN_USERNAME,
      ADMIN_PASSWORD_HASH,
      ADMIN_SESSION_SECRET: "codex-issue-98-99-session",
      CLINICAL_APPROVER_USERS: ADMIN_USERNAME,
      APP_ENV: "local",
      HEALTH_IDENTITY_MODE: "synthetic",
      HEALTH_SYNTHETIC_USER_ID: "usr_issue_98_99",
      DEEPSEEK_API_KEY: "",
      WRANGLER_LOG_PATH: ".wrangler/issue-98-99-e2e.log",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  try {
    await waitForServer(baseUrl, child, output);
    const login = await request(baseUrl, "/api/admin/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: "issue-100-83-local" }),
    });
    assert.equal(login.response.status, 200, `${login.text}\n${output.join("")}`);
    const cookie = cookieFrom(login.response);

    const created = await request(baseUrl, "/api/admin/content", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": `issue-98-99-candidate-${process.pid}-${crypto.randomUUID()}` },
      body: JSON.stringify({
        type: "article",
        title: "背十区兼症候选资料",
        category: "临床候选",
        summary: "待临床确认的候选内容",
        body: "该内容只作为临床候选登记，不构成用户指导。",
        source: "客户资料 v2",
        candidateKind: "back_ten_zone_comorbidity",
        changeDiff: "新增背十区兼症候选条目，待临床负责人确认。",
        metadata: {},
      }),
    }, cookie);
    assert.equal(created.response.status, 201, `${created.text}\n${output.join("")}`);
    assert.equal(created.body.clinicalReviewStatus, "pending_review");

    const blocked = await request(baseUrl, "/api/admin/content", {
      method: "PATCH",
      headers: { "content-type": "application/json", "If-Match": '"1"' },
      body: JSON.stringify({ id: created.body.id, type: "article", action: "publish" }),
    }, cookie);
    assert.equal(blocked.response.status, 422);
    assert.match(blocked.body.error, /临床审核/u);

    const audit = await request(baseUrl, "/api/admin/audit", {}, cookie);
    const blockedAudit = audit.body.items.find((item) => item.action === "publish_blocked" && item.entity_id === created.body.id);
    assert.ok(blockedAudit);
    assert.equal(JSON.parse(blockedAudit.details).reason, "clinical_review_required");
    assert.equal(JSON.parse(blockedAudit.details).contentVersion, 1);

    const approval = await request(baseUrl, "/api/admin/clinical-approvals", {
      method: "POST",
      headers: { "content-type": "application/json", "If-Match": '"1"' },
      body: JSON.stringify({ contentId: created.body.id }),
    }, cookie);
    assert.equal(approval.response.status, 201, approval.text);
    assert.equal(approval.body.reviewStatus, "approved");

    const published = await request(baseUrl, "/api/admin/content", {
      method: "PATCH",
      headers: { "content-type": "application/json", "If-Match": '"1"' },
      body: JSON.stringify({ id: created.body.id, type: "article", action: "publish" }),
    }, cookie);
    assert.equal(published.response.status, 200, published.text);

    const publicItems = await request(baseUrl, "/api/content?type=article");
    assert.ok(publicItems.body.items.some((item) => item.id === created.body.id));

    const offline = await request(baseUrl, "/api/admin/content", {
      method: "PATCH",
      headers: { "content-type": "application/json", "If-Match": '"1"' },
      body: JSON.stringify({ id: created.body.id, type: "article", action: "offline" }),
    }, cookie);
    assert.equal(offline.response.status, 200, offline.text);

    const updated = await request(baseUrl, "/api/admin/content", {
      method: "PATCH",
      headers: { "content-type": "application/json", "If-Match": '"2"' },
      body: JSON.stringify({
        id: created.body.id,
        type: "article",
        action: "update",
        title: "背十区兼症候选资料 v2",
        body: "该内容的新版本仍只作为临床候选登记。",
        source: "客户资料 v3",
        candidateKind: "back_ten_zone_comorbidity",
        changeDiff: "补充版本二的边界说明，重新等待临床确认。",
      }),
    }, cookie);
    assert.equal(updated.response.status, 200, updated.text);

    const current = await request(baseUrl, `/api/admin/content?type=article`, {}, cookie);
    const currentItem = current.body.items.find((item) => item.id === created.body.id);
    assert.equal(currentItem.version, 3);
    assert.equal(currentItem.clinicalReview.status, "pending_review");

    const blockedNewVersion = await request(baseUrl, "/api/admin/content", {
      method: "PATCH",
      headers: { "content-type": "application/json", "If-Match": '"3"' },
      body: JSON.stringify({ id: created.body.id, type: "article", action: "publish" }),
    }, cookie);
    assert.equal(blockedNewVersion.response.status, 422);
  } finally {
    await stopServer(child);
    await unlink(devVarsPath).catch(() => {});
  }
});
