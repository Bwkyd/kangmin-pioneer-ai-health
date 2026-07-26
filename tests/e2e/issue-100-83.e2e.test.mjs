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
const ADMIN_USERNAME = "codex-issue-100-83";
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
  try { body = text ? JSON.parse(text) : null; } catch { /* HTML or binary response. */ }
  return { response, body, text };
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie") ?? "";
  return value.split(";", 1)[0];
}

function tinyPng() {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
}

test("Issue #100/#83 HTTP 端到端跑通入口、管理员媒体、草稿保护与公开文章图片", async () => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const cloudflareEnv = `codex-e2e-${process.pid}`;
  const devVarsPath = path.join(PROJECT_DIR, `.dev.vars.${cloudflareEnv}`);
  await writeFile(devVarsPath, [
    `ADMIN_USERNAME='${ADMIN_USERNAME}'`,
    `ADMIN_PASSWORD_HASH='${ADMIN_PASSWORD_HASH}'`,
    "ADMIN_SESSION_SECRET='codex-issue-100-83-session'",
    `CLINICAL_APPROVER_USERS='${ADMIN_USERNAME}'`,
    "APP_ENV='local'",
    "HEALTH_IDENTITY_MODE='synthetic'",
    "HEALTH_SYNTHETIC_USER_ID='usr_issue_100_83'",
  ].join("\n") + "\n", { flag: "wx" });
  const child = spawn(process.execPath, [VINEXT_CLI, "dev", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      CLOUDFLARE_ENV: cloudflareEnv,
      ADMIN_USERNAME,
      ADMIN_PASSWORD_HASH,
      ADMIN_SESSION_SECRET: "codex-issue-100-83-session",
      CLINICAL_APPROVER_USERS: ADMIN_USERNAME,
      APP_ENV: "local",
      HEALTH_IDENTITY_MODE: "synthetic",
      HEALTH_SYNTHETIC_USER_ID: "usr_issue_100_83",
      DEEPSEEK_API_KEY: "",
      WRANGLER_LOG_PATH: ".wrangler/issue-100-83-e2e.log",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  try {
    await waitForServer(baseUrl, child, output);

    const home = await request(baseUrl, "/");
    assert.match(home.text, /data-navigation-purpose="allergen-record"/u);
    assert.match(home.text, /data-navigation-purpose="symptom-calendar"/u);
    assert.doesNotMatch(home.text, /花粉监测/u);

    const anonymousUpload = await request(baseUrl, "/api/admin/uploads", { method: "POST" });
    assert.equal(anonymousUpload.response.status, 401);

    const login = await request(baseUrl, "/api/admin/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: "issue-100-83-local" }),
    });
    assert.equal(login.response.status, 200, `${login.text}\n${output.join("")}`);
    const cookie = cookieFrom(login.response);
    assert.match(cookie, /kangmin_admin_session=/u);

    const fakeImage = new FormData();
    fakeImage.append("file", new Blob(["not a png"], { type: "image/png" }), "fake.png");
    const fakeUpload = await request(baseUrl, "/api/admin/uploads", { method: "POST", body: fakeImage }, cookie);
    assert.equal(fakeUpload.response.status, 415);

    const imageForm = new FormData();
    imageForm.append("file", new Blob([tinyPng()], { type: "image/png" }), "issue-83.png");
    const uploaded = await request(baseUrl, "/api/admin/uploads", { method: "POST", body: imageForm }, cookie);
    assert.equal(uploaded.response.status, 201);
    assert.equal(uploaded.body.kind, "image");

    const mediaId = uploaded.body.id;
    const preview = await request(baseUrl, `/api/admin/uploads/${encodeURIComponent(mediaId)}`, {}, cookie);
    assert.equal(preview.response.status, 200);
    assert.equal(preview.response.headers.get("cache-control"), "private, no-store");
    const anonymousPreview = await request(baseUrl, `/api/admin/uploads/${encodeURIComponent(mediaId)}`);
    assert.equal(anonymousPreview.response.status, 401);
    const notPublicYet = await request(baseUrl, `/api/media/${encodeURIComponent(mediaId)}`);
    assert.equal(notPublicYet.response.status, 404);

    const idempotencyKey = `issue-83-${crypto.randomUUID()}`;
    const articlePayload = {
      type: "article",
      title: "Issue 83 E2E article",
      category: "鼻部护理",
      summary: "Issue 83 E2E summary",
      body: "Issue 83 E2E body must survive every save boundary.",
      source: "synthetic local E2E",
      mediaId,
      metadata: {},
    };
    const created = await request(baseUrl, "/api/admin/content", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(articlePayload),
    }, cookie);
    assert.equal(created.response.status, 201);
    const replay = await request(baseUrl, "/api/admin/content", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(articlePayload),
    }, cookie);
    assert.equal(replay.response.status, 201);
    assert.equal(replay.body.id, created.body.id);

    const crossTypeUpdate = await request(baseUrl, "/api/admin/content", {
      method: "PATCH",
      headers: { "content-type": "application/json", "If-Match": '"1"' },
      body: JSON.stringify({ id: created.body.id, action: "update", type: "video", body: null, mediaId: "" }),
    }, cookie);
    assert.equal(crossTypeUpdate.response.status, 409);
    const unchanged = await request(baseUrl, `/api/admin/content?type=article`, {}, cookie);
    const current = unchanged.body.items.find((item) => item.id === created.body.id);
    assert.equal(current.body, articlePayload.body);
    assert.equal(current.mediaId, mediaId);

    const approval = await request(baseUrl, "/api/admin/clinical-approvals", {
      method: "POST",
      headers: { "content-type": "application/json", "If-Match": '"1"' },
      body: JSON.stringify({ contentId: created.body.id }),
    }, cookie);
    assert.equal(approval.response.status, 201);
    const published = await request(baseUrl, "/api/admin/content", {
      method: "PATCH",
      headers: { "content-type": "application/json", "If-Match": '"1"' },
      body: JSON.stringify({ id: created.body.id, action: "publish", type: "article" }),
    }, cookie);
    assert.equal(published.response.status, 200);
    const publicMedia = await request(baseUrl, `/api/media/${encodeURIComponent(mediaId)}`);
    assert.equal(publicMedia.response.status, 200);
    assert.equal(publicMedia.response.headers.get("content-type"), "image/png");
    const publicArticle = await request(baseUrl, "/api/content?type=article");
    assert.equal(publicArticle.response.status, 200);
    assert.equal(publicArticle.body.items.find((item) => item.id === created.body.id).mediaId, mediaId);
  } finally {
    await stopServer(child);
    await unlink(devVarsPath).catch(() => {});
  }
});
