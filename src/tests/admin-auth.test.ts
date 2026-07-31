import assert from "node:assert/strict";

// 测试进程以本地开发模式启动：组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为
// PlaintextEncryption（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdminApplication } from "../app/admin-composition-root.js";
import { createApplication } from "../app/composition-root.js";
import type { CommandResult } from "../kernel/result.js";
import type { AdminAccountView, LoginResult } from "../modules/admin/admin-auth-service.js";

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

async function fixture(): Promise<{
  app: ReturnType<typeof createAdminApplication>;
  databasePath: string;
  mediaDirectory: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-admin-auth-"));
  const databasePath = join(directory, "auth.sqlite");
  const mediaDirectory = join(directory, "admin-media");
  const app = createAdminApplication(databasePath, { mediaDirectory });
  return { app, databasePath, mediaDirectory };
}

const OWNER = { username: "owner1", password: "owner-secret-1", role: "owner" };

test("首个 owner 引导、登录、状态、退出与令牌撤销闭环", async () => {
  const { app } = await fixture();
  try {
    // 无任何管理员时允许创建首个 owner（无需登录）
    const created = dataOf<AdminAccountView>(
      await app.execute({ command: "auth admins add", input: { ...OWNER } })
    );
    assert.equal(created.role, "owner");
    assert.equal(created.status, "active");

    // 引导完成后不能再次创建 owner
    const secondOwner = await app.execute({
      command: "auth admins add",
      input: { username: "owner2", password: "owner-secret-2", role: "owner" }
    });
    assert.equal(secondOwner.ok, false);
    if (!secondOwner.ok) assert.equal(secondOwner.error.code, "permission_denied");

    // 密码错误与不存在账号统一 authentication_required
    for (const password of ["wrong-password", "owner-secret-1"]) {
      const bad = await app.execute({
        command: "auth login",
        input: { username: password === "owner-secret-1" ? "nobody" : "owner1", password }
      });
      assert.equal(bad.ok, false);
      if (!bad.ok) assert.equal(bad.error.code, "authentication_required");
    }

    const login = dataOf<LoginResult>(
      await app.execute({
        command: "auth login",
        input: { username: OWNER.username, password: OWNER.password }
      })
    );
    assert.equal(login.role, "owner");
    assert.ok(login.token.length >= 32);

    const status = dataOf<{
      loggedIn: boolean;
      adminId: string | null;
      role: string | null;
      username: string | null;
      expiresAt: string | null;
    }>(await app.execute({ command: "auth status", adminToken: login.token }));
    assert.equal(status.loggedIn, true);
    assert.equal(status.role, "owner");
    assert.equal(status.username, OWNER.username);
    assert.equal(status.adminId, login.adminId);

    const whoami = dataOf<{ loggedIn: boolean }>(
      await app.execute({ command: "auth whoami", adminToken: login.token })
    );
    assert.equal(whoami.loggedIn, true);

    // 未登录状态命令返回 loggedIn:false 而非报错
    const loggedOut = dataOf<{ loggedIn: boolean }>(
      await app.execute({ command: "auth status" })
    );
    assert.equal(loggedOut.loggedIn, false);

    // 登录后命令可用
    const list = await app.execute({ command: "content article list", adminToken: login.token });
    assert.equal(list.ok, true);

    // 退出撤销会话
    dataOf(await app.execute({ command: "auth logout", adminToken: login.token }));
    const afterLogout = dataOf<{ loggedIn: boolean }>(
      await app.execute({ command: "auth status", adminToken: login.token })
    );
    assert.equal(afterLogout.loggedIn, false);

    const denied = await app.execute({ command: "content article list", adminToken: login.token });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "authentication_required");
  } finally {
    app.close();
  }
});

test("owner 创建/停用普通管理员，停用立即撤销会话，普通管理员不能管理 owner", async () => {
  const { app } = await fixture();
  try {
    dataOf(await app.execute({ command: "auth admins add", input: { ...OWNER } }));
    const ownerLogin = dataOf<LoginResult>(
      await app.execute({
        command: "auth login",
        input: { username: OWNER.username, password: OWNER.password }
      })
    );

    const created = dataOf<AdminAccountView>(
      await app.execute({
        command: "auth admins add",
        adminToken: ownerLogin.token,
        input: { username: "admin1", password: "admin-secret-1", role: "admin" }
      })
    );
    assert.equal(created.role, "admin");

    const adminLogin = dataOf<LoginResult>(
      await app.execute({
        command: "auth login",
        input: { username: "admin1", password: "admin-secret-1" }
      })
    );
    assert.equal(adminLogin.role, "admin");

    // 普通管理员不能创建或停用其他管理员，不能停用 owner
    const adminAdd = await app.execute({
      command: "auth admins add",
      adminToken: adminLogin.token,
      input: { username: "admin2", password: "admin-secret-2", role: "admin" }
    });
    assert.equal(adminAdd.ok, false);
    if (!adminAdd.ok) assert.equal(adminAdd.error.code, "permission_denied");

    const adminDisableOwner = await app.execute({
      command: "auth admins disable",
      adminToken: adminLogin.token,
      input: { id: ownerLogin.adminId, yes: true }
    });
    assert.equal(adminDisableOwner.ok, false);
    if (!adminDisableOwner.ok) assert.equal(adminDisableOwner.error.code, "permission_denied");

    // 普通管理员可以查看账号列表
    const adminsList = dataOf<{ items: AdminAccountView[] }>(
      await app.execute({ command: "auth admins list", adminToken: adminLogin.token })
    );
    assert.equal(adminsList.items.length, 2);

    // 停用需要 --yes
    const noConfirm = await app.execute({
      command: "auth admins disable",
      adminToken: ownerLogin.token,
      input: { id: created.id }
    });
    assert.equal(noConfirm.ok, false);
    if (!noConfirm.ok) assert.equal(noConfirm.error.code, "confirmation_required");

    // owner 停用 admin：同事务撤销会话
    dataOf(
      await app.execute({
        command: "auth admins disable",
        adminToken: ownerLogin.token,
        input: { id: created.id, yes: true }
      })
    );
    const adminAfterDisable = await app.execute({
      command: "auth status",
      adminToken: adminLogin.token
    });
    const statusBody = dataOf<{ loggedIn: boolean }>(adminAfterDisable);
    assert.equal(statusBody.loggedIn, false);

    // 停用账号不能重新登录
    const relogin = await app.execute({
      command: "auth login",
      input: { username: "admin1", password: "admin-secret-1" }
    });
    assert.equal(relogin.ok, false);
    if (!relogin.ok) assert.equal(relogin.error.code, "authentication_required");

    // 最后一个活跃 owner 不能被停用
    const disableOwner = await app.execute({
      command: "auth admins disable",
      adminToken: ownerLogin.token,
      input: { id: ownerLogin.adminId, yes: true }
    });
    assert.equal(disableOwner.ok, false);
    if (!disableOwner.ok) assert.equal(disableOwner.error.code, "validation_failed");
  } finally {
    app.close();
  }
});

test("患者会话不能进入管理后台，开发占位密码不可登录", async () => {
  const { app, databasePath } = await fixture();
  try {
    // 患者身份空间：患者会话令牌在管理端一律不解析
    const patientApp = createApplication(databasePath);
    let patientToken = "";
    try {
      patientToken =
        (await patientApp.sessions.createDevelopmentSession("patient-x")).token;
    } finally {
      patientApp.close();
    }
    const statusWithPatientToken = dataOf<{ loggedIn: boolean }>(
      await app.execute({ command: "auth status", adminToken: patientToken })
    );
    assert.equal(statusWithPatientToken.loggedIn, false);
    const denied = await app.execute({ command: "content article list", adminToken: patientToken });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "authentication_required");

    // 管理会话令牌也不能解析为患者身份
    dataOf(await app.execute({ command: "auth admins add", input: { ...OWNER } }));
    const login = dataOf<LoginResult>(
      await app.execute({
        command: "auth login",
        input: { username: OWNER.username, password: OWNER.password }
      })
    );
    const patientSide = createApplication(databasePath);
    try {
      const asPatient = await patientSide.execute({
        command: "record symptom list",
        sessionToken: login.token
      });
      assert.equal(asPatient.ok, false);
      if (!asPatient.ok) assert.equal(asPatient.error.code, "authentication_required");
    } finally {
      patientSide.close();
    }

    // 开发会话占位密码（!dev-session-only）不能登录
    const devAdmin = await app.sessions.createDevelopmentSession("dev-owner");
    assert.ok(devAdmin.token);
    const devLogin = await app.execute({
      command: "auth login",
      input: { username: "dev-owner", password: "anything" }
    });
    assert.equal(devLogin.ok, false);
    if (!devLogin.ok) assert.equal(devLogin.error.code, "authentication_required");
  } finally {
    app.close();
  }
});
