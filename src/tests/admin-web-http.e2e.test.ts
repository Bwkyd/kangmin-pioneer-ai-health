import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createAdminApplicationWithOps } from "@kangmin/runtime/admin-composition-root";
import { createApplication } from "@kangmin/runtime/composition-root";
import { createKangminHttpServer } from "@kangmin/api/server";

process.env.KANGMIN_APP_ENV = "integration";
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

const directory = mkdtempSync(join(tmpdir(), "kangmin-admin-web-"));
const databasePath = join(directory, "app.sqlite");
const patient = createApplication(databasePath, { appEnvironment: "integration" });
const adminOps = createAdminApplicationWithOps(databasePath, {
  mediaDirectory: join(directory, "media")
});
const server = createKangminHttpServer(patient, {
  appEnvironment: "integration",
  adminApplication: adminOps.application,
  adminObjectStorage: adminOps.objectStorage
});
let origin = "";

before(async () => {
  const bootstrap = await adminOps.application.execute({
    command: "auth admins add",
    input: { username: "web-owner", password: "safe-password-2026", role: "owner" }
  });
  assert.equal(bootstrap.ok, true);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  patient.close();
  adminOps.application.close();
});

function cookiePair(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert.ok(value);
  return value.split(";", 1)[0]!;
}

async function command(cookie: string, name: string, input: Record<string, unknown> = {}) {
  return fetch(`${origin}/v1/admin/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin
    },
    body: JSON.stringify({ schemaVersion: "1", command: name, input, requestId: crypto.randomUUID() })
  });
}

test("/ 提供管理后台首页，既有 /admin 复用同一入口", async () => {
  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /admin-root/u);

  const compatibleAdmin = await fetch(`${origin}/admin`);
  assert.equal(compatibleAdmin.status, 200);
  assert.match(await compatibleAdmin.text(), /admin-root/u);

  const anonymous = await fetch(`${origin}/v1/admin/session`);
  assert.equal(anonymous.status, 200);
  assert.equal((await anonymous.json() as { data: { loggedIn: boolean } }).data.loggedIn, false);

  const login = await fetch(`${origin}/v1/admin/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ username: "web-owner", password: "safe-password-2026" })
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /kangmin_admin_session=/u);
  assert.match(setCookie, /HttpOnly/u);
  assert.match(setCookie, /SameSite=Strict/u);
  const loginBody = await login.json() as { data: Record<string, unknown> };
  assert.equal(Object.hasOwn(loginBody.data, "token"), false);

  const cookie = setCookie.split(";", 1)[0]!;
  const deniedCsrf = await fetch(`${origin}/v1/admin/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ schemaVersion: "1", command: "content media list", input: {}, requestId: "csrf-denied" })
  });
  assert.equal(deniedCsrf.status, 403);

  const listed = await command(cookie, "content media list");
  assert.equal(listed.status, 200);
});

test("管理 Cookie 完成本地素材 init → PUT → confirm，退出后立即失效", async () => {
  const login = await fetch(`${origin}/v1/admin/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ username: "web-owner", password: "safe-password-2026" })
  });
  const cookie = cookiePair(login);
  const body = Buffer.from("# 鼻健康知识\n\n换季时注意环境清洁。\n");
  const sha256 = createHash("sha256").update(body).digest("hex");

  const initialized = await command(cookie, "content media upload-init", {
    filename: "trial-guide.md",
    sizeBytes: body.length,
    sha256
  });
  assert.equal(initialized.status, 200);
  const initializedBody = await initialized.json() as {
    data: { mediaId: string; ticket: { url: string; headers: Record<string, string> } }
  };
  assert.equal(initializedBody.data.ticket.url, "/v1/admin/upload");

  const uploaded = await fetch(`${origin}${initializedBody.data.ticket.url}`, {
    method: "PUT",
    headers: {
      ...initializedBody.data.ticket.headers,
      cookie,
      origin
    },
    body
  });
  const uploadError = uploaded.status === 204 ? "" : await uploaded.text();
  assert.equal(uploaded.status, 204, uploadError);

  const confirmed = await command(cookie, "content media upload-confirm", {
    mediaId: initializedBody.data.mediaId,
    sha256
  });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json() as { data: { media: { status: string } } }).data.media.status, "ready");

  const logout = await fetch(`${origin}/v1/admin/session`, {
    method: "DELETE",
    headers: { cookie, origin }
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/u);

  const denied = await command(cookie, "content media list");
  assert.equal(denied.status, 401);
});
