/**
 * 应用级 PostgreSQL 端到端契约测试（issue-139 任务 2）。
 *
 * 组合根以 databaseUrl 走 PostgreSQL 存储，全部用例只通过应用服务的
 * execute 命令分发（或公开服务方法）走完整链路，不直接戳仓储。
 * 断言逐条对齐 SQLite 版既有测试的行为：
 * - application.test.ts / account.test.ts：患者注册登录、症状记录幂等
 *   重放、CAS version_conflict、删除确认、consent sequence 追加；
 * - agent.application.test.ts / agent-conversation.test.ts：agent start
 *   安全会话、无模型 key 时 exec 降级结构化问答、sessions/conversations
 *   列表可见；
 * - admin-auth.test.ts / admin.application.test.ts / admin-users.test.ts：
 *   owner 引导、分类/文章创建与发布（yes:true 确认语义）、患者 browse
 *   门禁、users list、doctor healthy；
 * - admin.application.test.ts 重启恢复用例：关闭后同一 url 重建应用，
 *   数据仍在。
 *
 * 运行：KANGMIN_TEST_DATABASE_URL=postgres://... node --test dist/tests/pg-application.contract.test.js
 * 连接串指向 PostgreSQL 服务器（如维护库 postgres），本文件据此创建一次性
 * 隔离库，结束后删除；未配置连接串时全部用例 skip。
 */

import assert from "node:assert/strict";

// 测试进程以本地开发模式启动：未配置 KANGMIN_ENCRYPTION_KEYS 时，
// 组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为 PlaintextEncryption
//（keyVersion=plaintext-dev）。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
// 固定走无模型 key 的降级路径（provider_unavailable → 结构化问答），
// 不受开发机环境变量影响。
delete process.env.KANGMIN_DEEPSEEK_API_KEY;

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdminApplication } from "@kangmin/runtime/admin-composition-root";
import { createApplication } from "@kangmin/runtime/composition-root";
import type { CommandResult } from "@kangmin/core/kernel/result";
import type {
  AdminAccountView,
  LoginResult
} from "@kangmin/core/operations/admin/admin-auth-service";
import type { AdminArticle } from "@kangmin/core/operations/admin/content-admin-repository";
import type { AgentSession } from "@kangmin/core/intelligence/agent/contracts";
import type {
  ConversationSession,
  ConversationTurnResult
} from "@kangmin/core/intelligence/agent/conversation-contracts";
import type { PublicContent } from "@kangmin/core/content/browse/contracts";
import type { SymptomRecord } from "@kangmin/core/patient/record/contracts";
import type { UserSummary } from "@kangmin/core/operations/user-admin/contracts";
import {
  createPgTestDatabase,
  type PgTestDatabase
} from "./pg-test-database.js";

const USERNAME = "pg_contract_patient";
const PASSWORD = "s3cret-pass-1";
const ADMIN_USERNAME = "pg_contract_owner";
const ADMIN_PASSWORD = "owner-secret-1";

interface DoctorReportData {
  healthy: boolean;
  checks: Array<{ name: string; status: string }>;
}

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

let testDatabase: PgTestDatabase | null = null;

interface SharedApps {
  application: ReturnType<typeof createApplication>;
  admin: ReturnType<typeof createAdminApplication>;
  mediaDirectory: string;
}

let shared: SharedApps | undefined;

/** 惰性装配两个应用（同一隔离库，患者端 + 管理端共享存储，与 SQLite 版一致）。 */
function apps(): SharedApps {
  if (shared === undefined) {
    assert.ok(testDatabase !== null, "隔离库未初始化");
    const mediaDirectory = mkdtempSync(join(tmpdir(), "kangmin-pg-media-"));
    shared = {
      application: createApplication("pg-contract-patient", {
        databaseUrl: testDatabase.url
      }),
      admin: createAdminApplication("pg-contract-admin", {
        databaseUrl: testDatabase.url,
        mediaDirectory
      }),
      mediaDirectory
    };
  }
  return shared;
}

/** application.close() 不等待连接池排空，留短暂窗口让 pool.end() 完成。 */
async function drainPools(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

// 跨用例共享的链路状态（node:test 默认串行执行）。
let patientId = "";
let patientToken = "";
let adminToken = "";
let articleId = "";

function contractTest(name: string, fn: () => Promise<void>): void {
  if (process.env.KANGMIN_TEST_DATABASE_URL === undefined) {
    test(name, { skip: "未配置 KANGMIN_TEST_DATABASE_URL" }, () => {});
    return;
  }
  test(name, fn);
}

if (process.env.KANGMIN_TEST_DATABASE_URL !== undefined) {
  test.before(async () => {
    testDatabase = await createPgTestDatabase("pg_application");
  });
  test.after(async () => {
    if (shared !== undefined) {
      shared.application.close();
      shared.admin.close();
      shared = undefined;
      await drainPools();
    }
    if (testDatabase !== null) {
      await testDatabase.close();
    }
  });
}

contractTest("患者全流程：注册→登录→症状记录幂等/CAS/删除闭环", async () => {
  const { application } = apps();

  const registered = dataOf<{ patientId: string }>(
    await application.execute({
      command: "account register",
      input: { username: USERNAME, nickname: "PG患者", password: PASSWORD },
      requestId: "req-pg-register"
    })
  );
  patientId = registered.patientId;
  assert.ok(patientId.length > 0);

  const login = dataOf<{ token: string; usernameMasked: string }>(
    await application.execute({
      command: "account login",
      input: { username: USERNAME, password: PASSWORD },
      requestId: "req-pg-login"
    })
  );
  patientToken = login.token;
  assert.ok(patientToken.length > 0);

  // record 写入需 health_data 授权（issue-155 fail-closed）：正式账号经
  // account consent update 授权。
  dataOf(
    await application.execute({
      command: "account consent update",
      input: {
        consentType: "health_data",
        decision: "granted",
        policyVersion: "2026-08-01.1",
        requestId: "req-pg-consent-health"
      },
      sessionToken: patientToken
    })
  );

  const symptomInput = {
    localDate: "2026-07-31",
    nasalCongestion: 2,
    nasalItching: 1,
    sneezing: 3,
    runnyNose: 2,
    notes: "换季后加重",
    idempotencyKey: "pg-symptom-1"
  };
  const created = dataOf<SymptomRecord>(
    await application.execute({
      command: "record symptom add",
      input: symptomInput,
      sessionToken: patientToken,
      requestId: "req-pg-symptom-1"
    })
  );
  assert.equal(created.tnssTotal, 8);
  assert.equal(created.revision, 1);

  // 同键同请求重放 → 返回相同结果（对齐 application.test.ts 幂等用例）。
  const replay = dataOf<SymptomRecord>(
    await application.execute({
      command: "record symptom add",
      input: symptomInput,
      sessionToken: patientToken,
      requestId: "req-pg-symptom-2"
    })
  );
  assert.equal(replay.id, created.id);

  // CAS：过期 expectedRevision → version_conflict。
  const conflict = await application.execute({
    command: "record symptom update",
    input: { id: created.id, expectedRevision: 99, sneezing: 1 },
    sessionToken: patientToken
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.error.code, "version_conflict");
  }

  const listed = dataOf<{ items: SymptomRecord[] }>(
    await application.execute({
      command: "record symptom list",
      sessionToken: patientToken
    })
  );
  assert.deepEqual(
    listed.items.map((item) => item.id),
    [created.id]
  );

  const deleted = await application.execute({
    command: "record symptom delete",
    input: { id: created.id, expectedRevision: 1, yes: true },
    sessionToken: patientToken
  });
  assert.equal(deleted.ok, true);

  const empty = dataOf<{ items: SymptomRecord[] }>(
    await application.execute({
      command: "record symptom list",
      sessionToken: patientToken
    })
  );
  assert.deepEqual(empty.items, []);
});

contractTest("consent：授权后 show 可见，撤回产生新 sequence", async () => {
  const { application } = apps();

  const grant = dataOf<{
    item: { consentType: string; sequence: number; decision: string };
  }>(
    await application.execute({
      command: "account consent update",
      input: {
        consentType: "privacy",
        decision: "granted",
        policyVersion: "2026-08-01.1",
        requestId: "req-pg-consent-1"
      },
      sessionToken: patientToken
    })
  );
  assert.equal(grant.item.consentType, "privacy");
  assert.equal(grant.item.sequence, 1);
  assert.equal(grant.item.decision, "granted");

  const shown = dataOf<{
    items: Array<{ consentType: string; decision: string; sequence: number }>;
  }>(
    await application.execute({
      command: "account consent show",
      sessionToken: patientToken
    })
  );
  const grantedPrivacy = shown.items.find(
    (item) => item.consentType === "privacy"
  );
  assert.equal(grantedPrivacy?.decision, "granted");
  assert.equal(grantedPrivacy?.sequence, 1);

  const withdrawn = dataOf<{ item: { sequence: number; decision: string } }>(
    await application.execute({
      command: "account consent update",
      input: {
        consentType: "privacy",
        decision: "withdrawn",
        policyVersion: "2026-08-02.1",
        requestId: "req-pg-consent-2"
      },
      sessionToken: patientToken
    })
  );
  assert.equal(withdrawn.item.sequence, 2);
  assert.equal(withdrawn.item.decision, "withdrawn");

  const after = dataOf<{
    items: Array<{ consentType: string; decision: string; sequence: number }>;
  }>(
    await application.execute({
      command: "account consent show",
      sessionToken: patientToken
    })
  );
  const withdrawnPrivacy = after.items.find(
    (item) => item.consentType === "privacy"
  );
  assert.equal(withdrawnPrivacy?.decision, "withdrawn");
  assert.equal(withdrawnPrivacy?.sequence, 2);
});

contractTest("agent：start 安全会话 + exec 降级结构化问答，list/status 可见", async () => {
  const { application } = apps();

  const started = dataOf<AgentSession>(
    await application.execute({
      command: "agent start",
      sessionToken: patientToken
    })
  );
  assert.equal(started.status, "awaiting_answer");
  assert.equal(started.nextQuestion?.key, "urgentHelp");

  // 无模型 key：提取端口抛 provider_unavailable 被吞掉，对话降级为
  // 结构化问答，轮次照常提交（对齐 agent-conversation.test.ts 替身语义）。
  const turn = dataOf<ConversationTurnResult>(
    await application.execute({
      command: "agent exec",
      input: { message: "我最近鼻塞，想咨询一下" },
      sessionToken: patientToken
    })
  );
  assert.equal(turn.state, "active");
  assert.ok(turn.message !== null);

  const sessions = dataOf<{ items: AgentSession[] }>(
    await application.execute({
      command: "agent sessions list",
      sessionToken: patientToken
    })
  );
  assert.ok(sessions.items.some((item) => item.id === started.id));

  const conversations = dataOf<{ items: ConversationSession[] }>(
    await application.execute({
      command: "agent conversations list",
      sessionToken: patientToken
    })
  );
  assert.ok(
    conversations.items.some((item) => item.id === turn.conversationId)
  );

  const shown = dataOf<AgentSession>(
    await application.execute({
      command: "agent sessions show",
      input: { id: started.id },
      sessionToken: patientToken
    })
  );
  assert.equal(shown.status, "awaiting_answer");
});

contractTest("管理端：owner 引导→分类/文章发布→患者可见→users→doctor", async () => {
  const { application, admin } = apps();

  const owner = dataOf<AdminAccountView>(
    await admin.execute({
      command: "auth admins add",
      input: {
        username: ADMIN_USERNAME,
        password: ADMIN_PASSWORD,
        role: "owner"
      }
    })
  );
  assert.equal(owner.role, "owner");
  assert.equal(owner.status, "active");

  const login = dataOf<LoginResult>(
    await admin.execute({
      command: "auth login",
      input: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }
    })
  );
  adminToken = login.token;
  assert.ok(adminToken.length >= 32);

  // 分类统一（评审 A P1-6）：article create 校验 category 必须存在。
  dataOf(
    await admin.execute({
      command: "content category create",
      adminToken,
      input: { name: "鼻健康", kind: "article" }
    })
  );

  const draft = dataOf<AdminArticle>(
    await admin.execute({
      command: "content article create",
      adminToken,
      input: {
        title: "换季鼻健康",
        categoryIds: ["article-general"],
        idempotencyKey: "pg-article-1"
      }
    })
  );
  assert.equal(draft.status, "draft");
  articleId = draft.id;

  const updated = dataOf<AdminArticle>(
    await admin.execute({
      command: "content article update",
      adminToken,
      input: {
        id: draft.id,
        expectedRevision: 1,
        summary: "科普摘要",
        body: "已审核科普正文",
        source: "客户已审核来源"
      }
    })
  );
  assert.equal(updated.revision, 2);

  // --yes 语义：通过应用 execute 的 input 传 yes:true。
  const published = dataOf<AdminArticle>(
    await admin.execute({
      command: "content article publish",
      adminToken,
      input: { id: draft.id, expectedRevision: 2, yes: true }
    })
  );
  assert.equal(published.status, "published");

  // 患者端 browse 门禁：已发布文章在 list/show 可见。
  const listed = dataOf<{ items: PublicContent[] }>(
    await application.execute({ command: "browse article list" })
  );
  assert.ok(listed.items.some((item) => item.id === articleId));
  const shown = dataOf<PublicContent>(
    await application.execute({
      command: "browse article show",
      input: { id: articleId }
    })
  );
  assert.equal(shown.title, "换季鼻健康");

  // users list 能看到本文件注册的患者。
  const users = dataOf<{ items: UserSummary[]; count: number }>(
    await admin.execute({
      command: "users list",
      adminToken,
      input: { limit: 100 }
    })
  );
  assert.ok(users.items.some((item) => item.userId === patientId));

  // doctor：数据库迁移已应用 + 素材目录可读写 → healthy。
  const adminDoctor = dataOf<DoctorReportData>(
    await admin.execute({ command: "doctor" })
  );
  assert.equal(adminDoctor.healthy, true);
  const patientDoctor = dataOf<DoctorReportData>(
    await application.execute({ command: "doctor" })
  );
  assert.equal(patientDoctor.healthy, true);
});

contractTest("持久化：关闭两个应用后同一 url 重建，数据仍在", async () => {
  const current = apps();
  current.application.close();
  current.admin.close();
  shared = undefined;
  await drainPools();

  assert.ok(testDatabase !== null, "隔离库未初始化");
  const application = createApplication("pg-contract-patient", {
    databaseUrl: testDatabase.url
  });
  const admin = createAdminApplication("pg-contract-admin", {
    databaseUrl: testDatabase.url,
    mediaDirectory: current.mediaDirectory
  });
  shared = { application, admin, mediaDirectory: current.mediaDirectory };
  try {
    // 账号仍在：可重新登录（对齐 admin.application.test.ts 重启恢复用例）。
    const login = dataOf<{ token: string }>(
      await application.execute({
        command: "account login",
        input: { username: USERNAME, password: PASSWORD },
        requestId: "req-pg-relogin"
      })
    );
    patientToken = login.token;

    const consent = dataOf<{
      items: Array<{ consentType: string; decision: string; sequence: number }>;
    }>(
      await application.execute({
        command: "account consent show",
        sessionToken: patientToken
      })
    );
    const privacy = consent.items.find(
      (item) => item.consentType === "privacy"
    );
    assert.equal(privacy?.decision, "withdrawn");
    assert.equal(privacy?.sequence, 2);

    // 已删除的记录不会因重建应用复活。
    const symptoms = dataOf<{ items: SymptomRecord[] }>(
      await application.execute({
        command: "record symptom list",
        sessionToken: patientToken
      })
    );
    assert.deepEqual(symptoms.items, []);

    // 已发布文章仍对患者可见。
    const article = dataOf<PublicContent>(
      await application.execute({
        command: "browse article show",
        input: { id: articleId }
      })
    );
    assert.equal(article.id, articleId);

    // 管理端会话令牌持久化：重启后仍可用于 users list。
    const users = dataOf<{ items: UserSummary[] }>(
      await admin.execute({
        command: "users list",
        adminToken,
        input: { limit: 100 }
      })
    );
    assert.ok(users.items.some((item) => item.userId === patientId));
  } finally {
    application.close();
    admin.close();
    shared = undefined;
    await drainPools();
  }
});
