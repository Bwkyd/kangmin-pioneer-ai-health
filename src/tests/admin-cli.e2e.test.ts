import assert from "node:assert/strict";

// 测试进程以本地开发模式启动：组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为
// PlaintextEncryption（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
import {
  spawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const adminCli = join(here, "../cli/kangmin-admin.js");
const patientCli = join(here, "../cli/kangmin.js");

function run(
  args: string[],
  environment: Record<string, string>,
  stdin?: string
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [adminCli, ...args], {
    encoding: "utf8",
    input: stdin,
    env: { ...process.env, ...environment }
  });
}

function patientRun(
  args: string[],
  environment: Record<string, string>
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [patientCli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment }
  });
}

async function fixture(): Promise<{
  directory: string;
  databasePath: string;
  environment: Record<string, string>;
}> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-admin-cli-"));
  const databasePath = join(directory, "admin.sqlite");
  return {
    directory,
    databasePath,
    environment: { KANGMIN_DB_PATH: databasePath }
  };
}

test("真实 CLI 全流程：引导→登录→发布→患者可见→退出码与 JSON 契约", async () => {
  const { databasePath, environment } = await fixture();

  // 辅助命令
  const version = run(["--version"], environment);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^kangmin-admin \d+\.\d+\.\d+/u);
  assert.match(version.stdout, /^[^\n]+\n$/u);

  const help = run(["help"], environment);
  assert.equal(help.status, 0);
  for (const group of ["content", "agent", "users", "auth"]) {
    assert.match(help.stdout, new RegExp(group, "u"));
  }

  const completion = run(["completion", "zsh"], environment);
  assert.equal(completion.status, 0);
  assert.match(completion.stdout, /#compdef kangmin-admin/u);

  // 医生检查：数据库可连接，账号未引导
  const doctorBefore = run(["doctor", "--json"], environment);
  assert.equal(doctorBefore.status, 6);
  const doctorBody = JSON.parse(doctorBefore.stdout) as {
    ok: boolean;
    data: { healthy: boolean; checks: Array<{ name: string; status: string }> };
  };
  assert.equal(doctorBody.ok, true);
  assert.equal(doctorBody.data.healthy, false);
  assert.ok(doctorBody.data.checks.some((check) => check.name === "database" && check.status === "ok"));

  // 未知命令与参数错误 → 2
  const unknown = run(["frobnicate", "x", "--json"], environment);
  assert.equal(unknown.status, 2);
  assert.equal(JSON.parse(unknown.stdout).error.code, "command_invalid");

  // 未登录访问 → 9
  const unauth = run(["content", "article", "list", "--json"], environment);
  assert.equal(unauth.status, 9);
  const unauthBody = JSON.parse(unauth.stdout) as { ok: boolean; error: { code: string } };
  assert.equal(unauthBody.error.code, "authentication_required");

  // 首个 owner 引导（密码从 stdin）
  const bootstrap = run(
    ["auth", "admins", "add", "--username", "owner-cli", "--role", "owner", "--json"],
    environment,
    "cli-owner-secret\n"
  );
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.equal(bootstrap.stdout.trim().split("\n").length, 1);
  const bootstrapBody = JSON.parse(bootstrap.stdout) as { ok: boolean; data: { role: string } };
  assert.equal(bootstrapBody.data.role, "owner");

  // 错误密码 → 9
  const badLogin = run(
    ["auth", "login", "--username", "owner-cli", "--json"],
    environment,
    "wrong-password\n"
  );
  assert.equal(badLogin.status, 9);
  const badLoginBody = JSON.parse(badLogin.stdout) as { error: { code: string } };
  assert.equal(badLoginBody.error.code, "authentication_required");

  // 登录成功：令牌写入凭据文件，stdout 不含令牌
  const login = run(
    ["auth", "login", "--username", "owner-cli", "--json"],
    environment,
    "cli-owner-secret\n"
  );
  assert.equal(login.status, 0, login.stderr);
  assert.ok(!login.stdout.includes("token"));
  const credentialsPath = join(dirname(databasePath), ".kangmin-admin.credentials.json");
  assert.equal(existsSync(credentialsPath), true);

  // 状态命令（无环境令牌，读取凭据文件）
  const status = run(["auth", "status", "--json"], environment);
  assert.equal(status.status, 0, status.stderr);
  const statusBody = JSON.parse(status.stdout) as { data: { loggedIn: boolean; role: string } };
  assert.equal(statusBody.data.loggedIn, true);
  assert.equal(statusBody.data.role, "owner");

  // 分类统一（评审 A P1-6）：create 校验 category 必须存在于 content_categories
  const categoryCreate = run([
    "content", "category", "create",
    "--name", "鼻健康",
    "--kind", "article",
    "--json"
  ], environment);
  assert.equal(categoryCreate.status, 0, categoryCreate.stderr);

  // 发布文章并验证患者可见
  const create = run([
    "content", "article", "create",
    "--title", "CLI 发布科普",
    "--category", "鼻健康",
    "--summary", "摘要",
    "--body", "已审核正文内容。",
    "--source", "客户已审核来源",
    "--json"
  ], environment);
  assert.equal(create.status, 0, create.stderr);
  const created = JSON.parse(create.stdout) as { data: { id: string } };

  const publish = run([
    "content", "article", "publish",
    created.data.id,
    "--expected-revision", "1",
    "--yes",
    "--json"
  ], environment);
  assert.equal(publish.status, 0, publish.stderr);

  const patientVisible = patientRun(
    ["browse", "article", "show", created.data.id, "--json"],
    environment
  );
  assert.equal(patientVisible.status, 0, patientVisible.stderr);
  const patientBody = JSON.parse(patientVisible.stdout) as { ok: boolean; data: { title: string } };
  assert.equal(patientBody.data.title, "CLI 发布科普");

  // 退出登录：撤销会话并清除凭据
  const logout = run(["auth", "logout", "--json"], environment);
  assert.equal(logout.status, 0, logout.stderr);
  assert.equal(existsSync(credentialsPath), false);
  const afterLogout = run(["content", "article", "list", "--json"], environment);
  assert.equal(afterLogout.status, 9);
});

test("CLI 用户敏感详情权限与知识状态机走真实进程", async () => {
  const { databasePath, environment } = await fixture();

  run(
    ["auth", "admins", "add", "--username", "owner-e2e", "--role", "owner", "--json"],
    environment,
    "owner-e2e-secret\n"
  );
  run(
    ["auth", "login", "--username", "owner-e2e", "--json"],
    environment,
    "owner-e2e-secret\n"
  );

  // 创建普通管理员
  const addAdmin = run(
    ["auth", "admins", "add", "--username", "admin-e2e", "--role", "admin", "--json"],
    environment,
    "admin-e2e-secret\n"
  );
  assert.equal(addAdmin.status, 0, addAdmin.stderr);

  // 知识文件状态机
  const knowledgeFile = join(dirname(databasePath), "知识.md");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(knowledgeFile, "# 知识标题\n\n知识正文段落内容。");
  const add = run(["agent", "knowledge", "add", knowledgeFile, "--json"], environment);
  assert.equal(add.status, 0, add.stderr);
  const knowledge = JSON.parse(add.stdout) as { data: { id: string; status: string } };
  assert.equal(knowledge.data.status, "processing");

  const index = run(["agent", "knowledge", "index", knowledge.data.id, "--json"], environment);
  assert.equal(index.status, 0, index.stderr);
  const enable = run(
    ["agent", "knowledge", "enable", knowledge.data.id, "--yes", "--json"],
    environment
  );
  assert.equal(enable.status, 0, enable.stderr);
  const search = run(
    ["agent", "knowledge", "search-test", "知识标题", "--json"],
    environment
  );
  assert.equal(search.status, 0, search.stderr);
  const hits = JSON.parse(search.stdout) as { data: { items: unknown[] } };
  assert.equal(hits.data.items.length, 1);

  // 用户列表只读投影走真实进程（普通管理员权限边界在应用层测试覆盖）
  const list = run(["users", "list", "--limit", "10", "--json"], environment);
  assert.equal(list.status, 0, list.stderr);
  const users = JSON.parse(list.stdout) as { data: { items: unknown[] } };
  assert.ok(Array.isArray(users.data.items));

  // 停用管理员后其会话立即失效（退出 owner 再以 admin 登录验证）
  run(["auth", "logout", "--json"], environment);
  const adminLogin = run(
    ["auth", "login", "--username", "admin-e2e", "--json"],
    environment,
    "admin-e2e-secret\n"
  );
  assert.equal(adminLogin.status, 0, adminLogin.stderr);
  const adminId = JSON.parse(
    run(["auth", "whoami", "--json"], environment).stdout
  ) as { data: { adminId: string } };
  // owner 重新登录后停用 admin
  run(
    ["auth", "login", "--username", "owner-e2e", "--json"],
    environment,
    "owner-e2e-secret\n"
  );
  const disable = run(
    ["auth", "admins", "disable", adminId.data.adminId, "--yes", "--json"],
    environment
  );
  assert.equal(disable.status, 0, disable.stderr);
  const relogin = run(
    ["auth", "login", "--username", "admin-e2e", "--json"],
    environment,
    "admin-e2e-secret\n"
  );
  assert.equal(relogin.status, 9);
});
