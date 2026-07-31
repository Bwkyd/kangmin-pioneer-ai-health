import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../app/composition-root.js";
import { KangminDatabase } from "../infrastructure/database.js";
import type { CommandResult } from "../kernel/result.js";

const PASSWORD = "s3cret-pass-1";

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

function errorOf(
  result: CommandResult
): { code: string; message: string } {
  if (result.ok) {
    assert.fail("期望失败结果");
  }
  return { code: result.error.code, message: result.error.message };
}

async function fixture(): Promise<{
  application: ReturnType<typeof createApplication>;
  databasePath: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-account-"));
  const databasePath = join(directory, "records.sqlite");
  const application = createApplication(databasePath);
  return { application, databasePath };
}

interface LoginData {
  token: string;
  expiresAt: string;
  usernameMasked: string;
}

async function registerAndLogin(
  application: ReturnType<typeof createApplication>,
  username = "wangxiaoming",
  nickname: string | null | undefined = "小明"
): Promise<{ patientId: string; login: LoginData }> {
  const registered = await application.execute({
    command: "account register",
    input: {
      username,
      nickname,
      password: PASSWORD
    },
    requestId: "req-register"
  });
  assert.equal(registered.ok, true, errorMessageOf(registered));
  const registeredData = dataOf<{ patientId: string }>(registered);
  const loggedIn = await application.execute({
    command: "account login",
    input: { username, password: PASSWORD },
    requestId: "req-login"
  });
  assert.equal(loggedIn.ok, true, errorMessageOf(loggedIn));
  return {
    patientId: registeredData.patientId,
    login: dataOf<LoginData>(loggedIn)
  };
}

function errorMessageOf(result: CommandResult): string {
  return result.ok ? "ok" : `${result.error.code}: ${result.error.message}`;
}

test("注册→登录→status→logout 闭环，会话撤销后不可再用", async () => {
  const { application } = await fixture();
  try {
    const { login } = await registerAndLogin(application);
    assert.equal(login.usernameMasked, "wa***ng");

    const status = await application.execute({
      command: "account status",
      sessionToken: login.token
    });
    const statusData = dataOf<{
      loggedIn: boolean;
      usernameMasked: string;
      accountStatus: string;
      sessionExpiresAt: string;
    }>(status);
    assert.equal(statusData.loggedIn, true);
    assert.equal(statusData.usernameMasked, "wa***ng");
    assert.equal(statusData.accountStatus, "active");
    assert.equal(statusData.sessionExpiresAt, login.expiresAt);

    const loggedOut = await application.execute({
      command: "account logout",
      sessionToken: login.token
    });
    const loggedOutData = dataOf<{ loggedIn: boolean; revoked: boolean }>(
      loggedOut
    );
    assert.equal(loggedOutData.loggedIn, false);
    assert.equal(loggedOutData.revoked, true);

    const afterLogout = await application.execute({
      command: "account status",
      sessionToken: login.token
    });
    const afterData = dataOf<{ loggedIn: boolean }>(afterLogout);
    assert.equal(afterData.loggedIn, false);

    // 撤销后的会话不能再用于任何受保护命令。
    const record = await application.execute({
      command: "account profile show",
      sessionToken: login.token
    });
    assert.deepEqual(errorOf(record), {
      code: "authentication_required",
      message: "患者登录会话无效或已过期"
    });
  } finally {
    application.close();
  }
});

test("密码不出现在 argv/日志：仅存 scrypt 哈希，错误不回声密码", async () => {
  const { application, databasePath } = await fixture();
  const result = await application.execute({
    command: "account register",
    input: { username: "security_check", password: PASSWORD }
  });
  assert.equal(result.ok, true, errorMessageOf(result));

  // 错误契约不回声密码：验证失败消息与 JSON 输出均不含密码。
  const failed = await application.execute({
    command: "account login",
    input: { username: "security_check", password: "totally-wrong-pass" }
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.error.message, "用户名或密码错误");
    assert.ok(!failed.error.message.includes("totally-wrong-pass"));
    assert.ok(!JSON.stringify(failed).includes("totally-wrong-pass"));
  }
  application.close();

  const database = new KangminDatabase(databasePath);
  try {
    const accountRow = database.connection
      .prepare(`
        SELECT username_hash, password_hash, username_masked
        FROM patient_accounts
      `)
      .get() as unknown as {
      username_hash: string;
      password_hash: string;
      username_masked: string;
    };

    // username 只存 SHA-256 哈希与脱敏形态，明文用户名不可被索引查询。
    assert.equal(
      accountRow.username_hash,
      createHash("sha256").update("security_check", "utf8").digest("hex")
    );
    assert.equal(accountRow.username_masked, "se***ck");

    // 密码只存 scrypt 参数化哈希，明文密码不得以任何形式出现。
    assert.equal(accountRow.password_hash.startsWith("scrypt:"), true);
    assert.notEqual(accountRow.password_hash, PASSWORD);
    assert.ok(
      !accountRow.password_hash.includes(PASSWORD),
      "密码明文不得出现在 password_hash 列"
    );
  } finally {
    database.close();
  }
});

test("防枚举：用户不存在与密码错误返回完全相同的错误", async () => {
  const { application } = await fixture();
  try {
    await application.execute({
      command: "account register",
      input: { username: "enum_user", password: PASSWORD }
    });
    const wrongPassword = await application.execute({
      command: "account login",
      input: { username: "enum_user", password: "wrong-password-1" }
    });
    const unknownUser = await application.execute({
      command: "account login",
      input: { username: "no_such_user", password: PASSWORD }
    });
    assert.deepEqual(errorOf(wrongPassword), errorOf(unknownUser));
    assert.equal(wrongPassword.ok, false);
    if (!wrongPassword.ok) {
      assert.equal(wrongPassword.error.code, "authentication_required");
    }
  } finally {
    application.close();
  }
});

test("同一用户名重复注册返回明确冲突错误", async () => {
  const { application } = await fixture();
  try {
    const first = await application.execute({
      command: "account register",
      input: { username: "duplicate_user", password: PASSWORD }
    });
    assert.equal(first.ok, true, errorMessageOf(first));
    const second = await application.execute({
      command: "account register",
      input: { username: "duplicate_user", password: PASSWORD }
    });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.error.code, "version_conflict");
      assert.equal(second.error.message, "该用户名已被注册，请直接登录");
    }
  } finally {
    application.close();
  }
});

test("密码缺失与格式错误：非交互空 stdin 不阻塞，短密码被拒绝", async () => {
  const { application } = await fixture();
  try {
    const registerNoPassword = await application.execute({
      command: "account register",
      input: { username: "no_password_user" }
    });
    assert.deepEqual(errorOf(registerNoPassword), {
      code: "confirmation_required",
      message: "非交互环境未提供密码，无法完成注册（请通过 stdin 提供密码）"
    });

    const loginNoPassword = await application.execute({
      command: "account login",
      input: { username: "no_password_user" }
    });
    assert.deepEqual(errorOf(loginNoPassword), {
      code: "authentication_required",
      message: "非交互环境未提供密码，无法完成登录"
    });

    const shortPassword = await application.execute({
      command: "account register",
      input: { username: "short_pass_user", password: "short" }
    });
    assert.equal(shortPassword.ok, false);
    if (!shortPassword.ok) {
      assert.equal(shortPassword.error.code, "validation_failed");
    }
  } finally {
    application.close();
  }
});

test("consent 按 sequence 追加，撤回后 status 反映最新决策，类型间序列独立", async () => {
  const { application } = await fixture();
  try {
    const { login } = await registerAndLogin(application);
    const token = login.token;

    const empty = await application.execute({
      command: "account consent show",
      sessionToken: token
    });
    const emptyData = dataOf<{ items: unknown[] }>(empty);
    assert.deepEqual(emptyData.items, []);

    const grant = await application.execute({
      command: "account consent update",
      input: {
        consentType: "privacy",
        decision: "granted",
        policyVersion: "2026-08-01.1",
        requestId: "req-consent-1"
      },
      sessionToken: token
    });
    const grantData = dataOf<{
      item: { consentType: string; sequence: number; decision: string };
    }>(grant);
    assert.equal(grantData.item.consentType, "privacy");
    assert.equal(grantData.item.sequence, 1);
    assert.equal(grantData.item.decision, "granted");

    const reGrant = await application.execute({
      command: "account consent update",
      input: {
        consentType: "privacy",
        decision: "granted",
        policyVersion: "2026-08-02.1",
        requestId: "req-consent-2"
      },
      sessionToken: token
    });
    const reGrantData = dataOf<{
      item: { sequence: number };
      items: Array<{ consentType: string; sequence: number }>;
    }>(reGrant);
    assert.equal(reGrantData.item.sequence, 2);
    // 追加后最新状态仍是 privacy，且 sequence 已推进到 2。
    assert.equal(reGrantData.items.length, 1);
    assert.equal(reGrantData.items[0]?.consentType, "privacy");
    assert.equal(reGrantData.items[0]?.sequence, 2);

    const boundary = await application.execute({
      command: "account consent update",
      input: {
        consentType: "medical_boundary",
        decision: "withdrawn",
        policyVersion: "2026-08-01.1",
        requestId: "req-consent-3"
      },
      sessionToken: token
    });
    const boundaryData = dataOf<{
      item: { sequence: number };
    }>(boundary);
    // 类型间序列独立：medical_boundary 从 1 开始。
    assert.equal(boundaryData.item.sequence, 1);

    const withdrawn = await application.execute({
      command: "account consent update",
      input: {
        consentType: "privacy",
        decision: "withdrawn",
        policyVersion: "2026-08-03.1",
        requestId: "req-consent-4"
      },
      sessionToken: token
    });
    assert.equal(
      dataOf<{ item: { sequence: number } }>(withdrawn).item.sequence,
      3
    );

    // 撤回后 status：show 必须反映最新决策为 withdrawn。
    const shown = await application.execute({
      command: "account consent show",
      sessionToken: token
    });
    const shownData = dataOf<{
      items: Array<{
        consentType: string;
        decision: string;
        sequence: number;
      }>;
      history: unknown[];
    }>(shown);
    const privacy = shownData.items.find(
      (item) => item.consentType === "privacy"
    );
    const boundaryShown = shownData.items.find(
      (item) => item.consentType === "medical_boundary"
    );
    assert.equal(privacy?.decision, "withdrawn");
    assert.equal(privacy?.sequence, 3);
    assert.equal(boundaryShown?.decision, "withdrawn");
    assert.equal(boundaryShown?.sequence, 1);
    assert.equal(shownData.history.length, 4);

    // 非法类型与非法决策被拒绝。
    const badType = await application.execute({
      command: "account consent update",
      input: {
        consentType: "location",
        decision: "granted",
        policyVersion: "v1",
        requestId: "req-bad"
      },
      sessionToken: token
    });
    assert.deepEqual(errorOf(badType).code, "validation_failed");
  } finally {
    application.close();
  }
});

test("未登录时受保护命令统一返回 authentication_required；status 返回 loggedIn false", async () => {
  const { application } = await fixture();
  try {
    const protectedCommands = [
      { command: "account logout" },
      { command: "account profile show" },
      { command: "account profile update", input: { nickname: "x" } },
      { command: "account consent show" },
      {
        command: "account consent update",
        input: {
          consentType: "privacy",
          decision: "granted",
          policyVersion: "v1",
          requestId: "req"
        }
      }
    ];
    for (const request of protectedCommands) {
      const result = await application.execute(request);
      assert.equal(result.ok, false, `${request.command} 应失败`);
      if (!result.ok) {
        assert.equal(
          result.error.code,
          "authentication_required",
          request.command
        );
      }
    }

    const status = await application.execute({ command: "account status" });
    const statusData = dataOf<{ loggedIn: boolean }>(status);
    assert.equal(statusData.loggedIn, false);

    const expiredToken = await application.execute({
      command: "account status",
      sessionToken: "bogus-token"
    });
    assert.deepEqual(dataOf<{ loggedIn: boolean }>(expiredToken), {
      loggedIn: false
    });
  } finally {
    application.close();
  }
});

test("profile show/update 只读写昵称，健康档案字段不受影响", async () => {
  const { application } = await fixture();
  try {
    const { login } = await registerAndLogin(application, "profile_user");
    const shown = await application.execute({
      command: "account profile show",
      sessionToken: login.token
    });
    const shownData = dataOf<{
      nickname: string | null;
      usernameMasked: string;
      accountStatus: string;
      patientId: string;
    }>(shown);
    assert.equal(shownData.nickname, "小明");
    assert.equal(shownData.usernameMasked, "pr***er");
    assert.equal(shownData.accountStatus, "active");
    assert.ok(shownData.patientId.length > 0);

    const updated = await application.execute({
      command: "account profile update",
      input: { nickname: "小敏" },
      sessionToken: login.token
    });
    assert.equal(
      dataOf<{ nickname: string; revision: number }>(updated).nickname,
      "小敏"
    );
    assert.equal(dataOf<{ revision: number }>(updated).revision, 2);

    const after = await application.execute({
      command: "account profile show",
      sessionToken: login.token
    });
    assert.equal(dataOf<{ nickname: string }>(after).nickname, "小敏");

    // 空串/显式清空 → null（清空语义，与 record 的 null 清空一致）。
    const cleared = await application.execute({
      command: "account profile update",
      input: { nickname: "" },
      sessionToken: login.token
    });
    assert.equal(dataOf<{ nickname: string | null }>(cleared).nickname, null);

    // 无字段更新被拒绝。
    const emptyUpdate = await application.execute({
      command: "account profile update",
      input: {},
      sessionToken: login.token
    });
    assert.equal(emptyUpdate.ok, false);
    if (!emptyUpdate.ok) {
      assert.equal(emptyUpdate.error.code, "validation_failed");
    }
  } finally {
    application.close();
  }
});

test("开发会话与本地账号会话并存：assurance 区分，开发会话无账号资料", async () => {
  const { application } = await fixture();
  try {
    const devToken =
      (await application.sessions.createDevelopmentSession("dev-account-test"))
        .token;
    const devIdentity = await application.sessions.resolveIdentity(devToken);
    assert.equal(devIdentity.assurance, "development");

    const { patientId, login } = await registerAndLogin(
      application,
      "assurance_user"
    );
    const accountIdentity = await application.sessions.resolveIdentity(
      login.token
    );
    assert.equal(accountIdentity.patientId, patientId);
    assert.equal(accountIdentity.assurance, "local_account");

    const devProfile = await application.execute({
      command: "account profile show",
      sessionToken: devToken
    });
    assert.equal(devProfile.ok, false);
    if (!devProfile.ok) {
      assert.equal(devProfile.error.code, "resource_not_found");
    }
  } finally {
    application.close();
  }
});

test("privacy 返回静态说明；数据权利命令明确 capability_unavailable", async () => {
  const { application } = await fixture();
  try {
    const privacy = await application.execute({ command: "account privacy" });
    const privacyData = dataOf<{ policyVersion: string; statement: string }>(
      privacy
    );
    assert.equal(privacyData.policyVersion, "2026-08-01.1");
    assert.ok(privacyData.statement.includes("医疗边界"));
    assert.ok(privacyData.statement.includes("数据用途"));

    const unavailableCommands = [
      "account data export",
      "account data deletion-request",
      "account data request-status",
      "account deactivate",
      "account reminder show",
      "account notification list"
    ];
    for (const command of unavailableCommands) {
      const result = await application.execute({ command });
      assert.equal(result.ok, false, `${command} 应失败`);
      if (!result.ok) {
        assert.equal(result.error.code, "capability_unavailable", command);
      }
    }

    const bare = await application.execute({ command: "account" });
    assert.deepEqual(errorOf(bare).code, "command_invalid");
  } finally {
    application.close();
  }
});
