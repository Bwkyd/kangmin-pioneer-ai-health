import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdminApplication } from "../app/admin-composition-root.js";
import { createApplication } from "../app/composition-root.js";
import type { CommandResult } from "../kernel/result.js";
import type { LoginResult } from "../modules/admin/admin-auth-service.js";
import type { UserSummary } from "../modules/user-admin/contracts.js";

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

async function fixture(): Promise<{
  app: ReturnType<typeof createAdminApplication>;
  ownerToken: string;
  adminToken: string;
  patientIds: string[];
}> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-admin-users-"));
  const databasePath = join(directory, "users.sqlite");
  const mediaDirectory = join(directory, "admin-media");

  // 通过患者应用播种用户与健康记录
  const patientApp = createApplication(databasePath);
  const patientIds: string[] = [];
  try {
    for (const subject of ["patient-a", "patient-b"]) {
      const session = await patientApp.sessions.createDevelopmentSession(subject);
      patientIds.push(session.patientId);
      await patientApp.execute({
        command: "record symptom add",
        sessionToken: session.token,
        input: {
          localDate: "2026-07-20",
          nasalCongestion: 2,
          nasalItching: 1,
          sneezing: 3,
          runnyNose: 2,
          notes: "换季加重（不应出现在管理端输出）",
          idempotencyKey: `seed-symptom-${subject}`
        }
      });
      await patientApp.execute({
        command: "record exposure add",
        sessionToken: session.token,
        input: {
          localDate: "2026-07-21",
          factors: ["pollen"],
          idempotencyKey: `seed-exposure-${subject}`
        }
      });
    }
  } finally {
    patientApp.close();
  }

  const app = createAdminApplication(databasePath, { mediaDirectory });
  dataOf(await app.execute({
    command: "auth admins add",
    input: { username: "owner-u", password: "owner-secret-u", role: "owner" }
  }));
  const ownerLogin = dataOf<LoginResult>(await app.execute({
    command: "auth login",
    input: { username: "owner-u", password: "owner-secret-u" }
  }));
  dataOf(await app.execute({
    command: "auth admins add",
    adminToken: ownerLogin.token,
    input: { username: "admin-u", password: "admin-secret-u", role: "admin" }
  }));
  const adminLogin = dataOf<LoginResult>(await app.execute({
    command: "auth login",
    input: { username: "admin-u", password: "admin-secret-u" }
  }));
  return {
    app,
    ownerToken: ownerLogin.token,
    adminToken: adminLogin.token,
    patientIds
  };
}

test("用户列表默认脱敏：不返回完整开发标识或健康正文", async () => {
  const { app, adminToken } = await fixture();
  try {
    const listed = dataOf<{ items: UserSummary[]; count: number }>(
      await app.execute({ command: "users list", adminToken, input: { limit: 100 } })
    );
    assert.equal(listed.count, 2);
    for (const item of listed.items) {
      assert.ok(!item.maskedIdentifier.includes("patient-a"));
      assert.ok(item.maskedIdentifier.includes("****"));
      assert.ok(item.sessionCount >= 1);
      assert.ok(item.recordCount >= 2);
    }

    const detail = dataOf<UserSummary & { accountStatus: string }>(
      await app.execute({ command: "users show", adminToken, input: { id: listed.items[0]?.userId } })
    );
    assert.ok(detail.maskedIdentifier.includes("****"));

    const activity = dataOf<{ totalUsers: number; recordCount: number; contentPublishedCount: number }>(
      await app.execute({ command: "users activity", adminToken })
    );
    assert.equal(activity.totalUsers, 2);
    assert.equal(activity.recordCount, 4);
    assert.equal(activity.contentPublishedCount, 0);
  } finally {
    app.close();
  }
});

test("users 敏感详情仅 owner 可读，且输出不含备注正文", async () => {
  const { app, ownerToken, adminToken, patientIds } = await fixture();
  try {
    const target = patientIds[0] as string;

    // 普通管理员不能读取会话与健康记录
    for (const command of ["users sessions", "users records"]) {
      const denied = await app.execute({
        command,
        adminToken: adminToken,
        input: command === "users records" ? { id: target, type: "symptom" } : { id: target }
      });
      assert.equal(denied.ok, false, command);
      if (!denied.ok) assert.equal(denied.error.code, "permission_denied", command);
    }

    // owner 可以读取，但输出不含备注/正文等自由文本
    const sessions = dataOf<{ items: Array<{ sessionId: string; active: boolean }> }>(
      await app.execute({ command: "users sessions", adminToken: ownerToken, input: { id: target } })
    );
    assert.equal(sessions.items.length, 1);
    assert.match(sessions.items[0]?.sessionId ?? "", /^\w{8}\*\*\*\*$/u);

    const records = dataOf<{ items: Array<{ localDate: string; tnssTotal: number }> }>(
      await app.execute({ command: "users records", adminToken: ownerToken, input: { id: target, type: "symptom" } })
    );
    assert.equal(records.items.length, 1);
    assert.equal(records.items[0]?.tnssTotal, 8);
    assert.ok(!JSON.stringify(records).includes("换季加重"));

    const exposures = dataOf<{ items: Array<{ factors: string[] }> }>(
      await app.execute({ command: "users records", adminToken: ownerToken, input: { id: target, type: "exposure" } })
    );
    assert.deepEqual(exposures.items[0]?.factors, ["pollen"]);

    // 无效类型与不存在的用户
    const badType = await app.execute({
      command: "users records",
      adminToken: ownerToken,
      input: { id: target, type: "profile" }
    });
    assert.equal(badType.ok, false);
    if (!badType.ok) assert.equal(badType.error.code, "validation_failed");

    const missing = await app.execute({
      command: "users show",
      adminToken: adminToken,
      input: { id: "patient_missing" }
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "resource_not_found");
  } finally {
    app.close();
  }
});

test("users 命令只读：不存在任何写入口", async () => {
  const { app, ownerToken } = await fixture();
  try {
    // 客户端不能通过 users 提交任何写操作输入
    for (const input of [
      { add: true },
      { delete: true },
      { update: true }
    ]) {
      const result = await app.execute({
        command: "users list",
        adminToken: ownerToken,
        input: input as Record<string, unknown>
      });
      // 未知字段被忽略，列表仍成功返回（users 无写命令）
      assert.equal(result.ok, true);
    }
    // 命令注册表不包含 users 写命令
    const write = await app.execute({
      command: "users delete",
      adminToken: ownerToken,
      input: { id: "x" }
    });
    assert.equal(write.ok, false);
    if (!write.ok) assert.equal(write.error.code, "command_invalid");
  } finally {
    app.close();
  }
});
