import assert from "node:assert/strict";

// 测试进程以本地开发模式启动：组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为
// PlaintextEncryption（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
import {
  spawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { KangminDatabase } from "../infrastructure/database.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../cli/kangmin.js");

const PASSWORD = "s3cret-pass-1";

function run(
  args: string[],
  environment: Record<string, string>,
  input?: string
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
    input
  });
}

interface CliBody {
  ok: boolean;
  command?: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

function bodyOf(processRun: SpawnSyncReturns<string>): CliBody {
  return JSON.parse(processRun.stdout) as CliBody;
}

function fixture(): { databasePath: string; environment: Record<string, string> } {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-account-cli-"));
  const databasePath = join(directory, "records.sqlite");
  return { databasePath, environment: { KANGMIN_DB_PATH: databasePath } };
}

test("CLI 端到端：注册→登录→status→logout，密码只经 stdin 不落 argv/日志", async () => {
  const { databasePath, environment } = fixture();

  // 密码只通过 stdin（spawnSync input）传入，argv 中绝不含密码。
  const register = run([
    "account", "register",
    "--username", "cli_user",
    "--nickname", "小克",
    "--json"
  ], environment, `${PASSWORD}\n`);
  assert.equal(register.status, 0, register.stderr);
  assert.equal(register.stderr, "");
  assert.equal(register.stdout.trim().split("\n").length, 1);
  assert.ok(!register.stdout.includes(PASSWORD), "stdout 不得包含密码");
  const registered = bodyOf(register);
  assert.equal(registered.ok, true);
  assert.equal(registered.data?.usernameMasked, "cl***er");

  const login = run([
    "account", "login",
    "--username", "cli_user",
    "--json"
  ], environment, `${PASSWORD}\n`);
  assert.equal(login.status, 0, login.stderr);
  assert.ok(!login.stdout.includes(PASSWORD), "stdout 不得包含密码");
  const loggedIn = bodyOf(login);
  assert.equal(loggedIn.ok, true);
  const token = String(loggedIn.data?.token ?? "");
  assert.ok(token.length >= 32);

  const status = run(["account", "status", "--json"], {
    ...environment,
    KANGMIN_SESSION_TOKEN: token
  });
  assert.equal(status.status, 0, status.stderr);
  const statusBody = bodyOf(status);
  assert.equal(statusBody.data?.loggedIn, true);
  assert.equal(statusBody.data?.usernameMasked, "cl***er");
  assert.equal(statusBody.data?.accountStatus, "active");
  assert.ok(
    typeof statusBody.data?.sessionExpiresAt === "string",
    "status 应返回会话有效期"
  );

  const logout = run(["account", "logout", "--json"], {
    ...environment,
    KANGMIN_SESSION_TOKEN: token
  });
  assert.equal(logout.status, 0, logout.stderr);
  assert.equal(bodyOf(logout).data?.revoked, true);

  const afterLogout = run(["account", "status", "--json"], {
    ...environment,
    KANGMIN_SESSION_TOKEN: token
  });
  assert.equal(afterLogout.status, 0, afterLogout.stderr);
  assert.equal(bodyOf(afterLogout).data?.loggedIn, false);

  // 数据库只存哈希：明文密码与明文用户名不得出现。
  const database = new KangminDatabase(databasePath);
  try {
    const row = database.connection
      .prepare(`
        SELECT username_hash, password_hash
        FROM patient_accounts
      `)
      .get() as unknown as { username_hash: string; password_hash: string };
    assert.notEqual(row.password_hash, PASSWORD);
    assert.notEqual(row.username_hash, "cli_user");
    assert.ok(row.password_hash.startsWith("scrypt:"));
  } finally {
    database.close();
  }
});

test("CLI 非交互空 stdin：register→confirmation_required，login→authentication_required，不阻塞", async () => {
  const { environment } = fixture();

  const register = run([
    "account", "register",
    "--username", "empty_stdin",
    "--json"
  ], environment);
  assert.equal(register.status, 5, register.stderr);
  assert.equal(bodyOf(register).error?.code, "confirmation_required");

  const login = run([
    "account", "login",
    "--username", "empty_stdin",
    "--json"
  ], environment);
  assert.equal(login.status, 9, login.stderr);
  assert.equal(bodyOf(login).error?.code, "authentication_required");
});

test("CLI 未登录各命令返回 9；status 返回 loggedIn false（exit 0）", async () => {
  const { environment } = fixture();

  const commands = [
    ["account", "logout", "--json"],
    ["account", "profile", "show", "--json"],
    ["account", "profile", "update", "--nickname", "x", "--json"],
    ["account", "consent", "show", "--json"]
  ];
  for (const args of commands) {
    const result = run(args, environment);
    assert.equal(result.status, 9, args.join(" "));
    assert.equal(
      bodyOf(result).error?.code,
      "authentication_required",
      args.join(" ")
    );
  }

  const status = run(["account", "status", "--json"], environment);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(bodyOf(status).data?.loggedIn, false);
});

test("CLI 防枚举：密码错误与用户不存在返回相同 exit 9 与相同消息", async () => {
  const { environment } = fixture();
  const register = run([
    "account", "register",
    "--username", "enum_cli",
    "--json"
  ], environment, `${PASSWORD}\n`);
  assert.equal(register.status, 0, register.stderr);

  const wrongPassword = run([
    "account", "login",
    "--username", "enum_cli",
    "--json"
  ], environment, "wrong-password-1\n");
  const unknownUser = run([
    "account", "login",
    "--username", "absent_cli",
    "--json"
  ], environment, `${PASSWORD}\n`);
  assert.equal(wrongPassword.status, 9);
  assert.equal(unknownUser.status, 9);
  assert.equal(
    bodyOf(wrongPassword).error?.message,
    bodyOf(unknownUser).error?.message
  );
  assert.equal(bodyOf(wrongPassword).error?.code, "authentication_required");
  assert.equal(bodyOf(unknownUser).error?.code, "authentication_required");
});

test("CLI consent：更新按 sequence 追加，撤回后 show 反映最新决策", async () => {
  const { environment } = fixture();
  const register = run([
    "account", "register",
    "--username", "consent_cli",
    "--json"
  ], environment, `${PASSWORD}\n`);
  assert.equal(register.status, 0, register.stderr);
  const login = run([
    "account", "login",
    "--username", "consent_cli",
    "--json"
  ], environment, `${PASSWORD}\n`);
  const token = String(bodyOf(login).data?.token ?? "");
  const session = { ...environment, KANGMIN_SESSION_TOKEN: token };

  const grant = run([
    "account", "consent", "update",
    "--type", "privacy",
    "--decision", "granted",
    "--policy-version", "2026-08-01.1",
    "--request-id", "req-cli-1",
    "--json"
  ], session);
  assert.equal(grant.status, 0, grant.stderr);
  assert.equal((bodyOf(grant).data?.item as { sequence: number } | undefined)?.sequence, 1);

  const reGrant = run([
    "account", "consent", "update",
    "--type", "privacy",
    "--decision", "granted",
    "--policy-version", "2026-08-02.1",
    "--request-id", "req-cli-2",
    "--json"
  ], session);
  assert.equal(reGrant.status, 0, reGrant.stderr);
  assert.equal((bodyOf(reGrant).data?.item as { sequence: number } | undefined)?.sequence, 2);

  const withdraw = run([
    "account", "consent", "update",
    "--type", "privacy",
    "--decision", "withdrawn",
    "--policy-version", "2026-08-03.1",
    "--request-id", "req-cli-3",
    "--json"
  ], session);
  assert.equal(withdraw.status, 0, withdraw.stderr);
  assert.equal((bodyOf(withdraw).data?.item as { sequence: number } | undefined)?.sequence, 3);

  const shown = run(["account", "consent", "show", "--json"], session);
  assert.equal(shown.status, 0, shown.stderr);
  const shownBody = bodyOf(shown);
  const items = shownBody.data?.items as Array<{
    consentType: string;
    decision: string;
    sequence: number;
  }>;
  const privacy = items.find((item) => item.consentType === "privacy");
  assert.equal(privacy?.decision, "withdrawn");
  assert.equal(privacy?.sequence, 3);
});

test("CLI 数据权利与未实现命令返回 capability_unavailable（exit 6），绝不伪造已删除", async () => {
  const { environment } = fixture();
  const commands = [
    ["account", "data", "export", "--json"],
    ["account", "data", "deletion-request", "--yes", "--json"],
    ["account", "deactivate", "--yes", "--json"],
    ["account", "reminder", "show", "--json"]
  ];
  for (const args of commands) {
    const result = run(args, environment);
    assert.equal(result.status, 6, args.join(" "));
    assert.equal(
      bodyOf(result).error?.code,
      "capability_unavailable",
      args.join(" ")
    );
  }
});

test("CLI human 模式登录：令牌只进 stderr，stdout 不含令牌（P2-12c）", async () => {
  const { databasePath, environment } = fixture();

  const register = run([
    "account", "register",
    "--username", "human_user",
    "--nickname", "人机",
    "--json"
  ], environment, `${PASSWORD}\n`);
  assert.equal(register.status, 0, register.stderr);

  // human 模式（无 --json）：令牌绝不进入 stdout，只写 stderr 提示
  const login = run([
    "account", "login",
    "--username", "human_user"
  ], environment, `${PASSWORD}\n`);
  assert.equal(login.status, 0, login.stderr);
  assert.ok(!login.stdout.includes("token"), "stdout 不得包含会话令牌");
  assert.match(login.stderr, /KANGMIN_SESSION_TOKEN/u);
});
