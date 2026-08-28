import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdminApplication } from "@kangmin/runtime/admin-composition-root";
import { createApplication } from "@kangmin/runtime/composition-root";
import { createKangminHttpServer } from "@kangmin/api/server";

process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

async function listen(server: ReturnType<typeof createKangminHttpServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createKangminHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("管理登录限流同时按账号与客户端 IP 计数，默认不信任伪造转发头", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-ops-admin-login-rl-"));
  const databasePath = join(directory, "records.sqlite");
  const patient = createApplication(databasePath, { appEnvironment: "integration" });
  const admin = createAdminApplication(databasePath, {
    mediaDirectory: join(directory, "admin-media")
  });
  const bootstrap = await admin.execute({
    command: "auth admins add",
    input: { username: "login-limit-owner", password: "safe-password-2026", role: "owner" }
  });
  assert.equal(bootstrap.ok, true);

  const makeLoginServer = (trustProxy: boolean) => createKangminHttpServer(patient, {
    appEnvironment: "integration",
    adminApplication: admin,
    rateLimits: { strictPerWindow: 1, windowMs: 60_000, trustProxy }
  });
  const login = (origin: string, username: string, forwardedFor: string) =>
    fetch(`${origin}/v1/admin/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "x-forwarded-for": forwardedFor
      },
      body: JSON.stringify({ username, password: "wrong-password" })
    });

  const untrustedServer = makeLoginServer(false);
  const trustedServer = makeLoginServer(true);
  try {
    const untrustedOrigin = await listen(untrustedServer);
    // 两个不同的伪造 X-Forwarded-For 仍来自同一 TCP 对端：第二次被 IP 维度拦截。
    assert.equal((await login(untrustedOrigin, "untrusted-a", "198.51.100.10")).status, 401);
    const spoofed = await login(untrustedOrigin, "untrusted-b", "198.51.100.11");
    assert.equal(spoofed.status, 429);
    assert.notEqual(spoofed.headers.get("retry-after"), null);

    const trustedOrigin = await listen(trustedServer);
    // 受控代理模式下，不同真实转发 IP 可分别计数；同一账号换 IP 仍被账号维度拦截。
    assert.equal((await login(trustedOrigin, "trusted-a", "198.51.100.20")).status, 401);
    assert.equal((await login(trustedOrigin, "trusted-b", "198.51.100.21")).status, 401);
    const sameAccount = await login(trustedOrigin, "trusted-a", "198.51.100.22");
    assert.equal(sameAccount.status, 429);
    assert.notEqual(sameAccount.headers.get("retry-after"), null);
  } finally {
    await close(untrustedServer);
    await close(trustedServer);
    patient.close();
    admin.close();
  }
});
