import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createApplication } from "../app/composition-root.js";
import type { CommandResult } from "../kernel/result.js";
import type { AgentSession } from "../modules/agent/contracts.js";
import { writeConsentForTest } from "./consent-fixture.js";

// 测试进程以本地开发模式启动：未配置 KANGMIN_ENCRYPTION_KEYS 时，
// 组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为 PlaintextEncryption
//（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";


function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-agent-"));
  const databasePath = join(directory, "agent.sqlite");
  const application = createApplication(databasePath);
  const sessionA =
    await application.sessions.createDevelopmentSession("agent-a");
  const sessionB =
    await application.sessions.createDevelopmentSession("agent-b");
  // record 写入需 health_data 授权（issue-155 fail-closed）：dev 会话患者
  // 无本地账号，授权经仓储层补记（见 consent-fixture）。
  await writeConsentForTest(databasePath, sessionA.patientId, "health_data");
  await writeConsentForTest(databasePath, sessionB.patientId, "health_data");
  return {
    application,
    databasePath,
    tokenA: sessionA.token,
    tokenB: sessionB.token
  };
}

test("Agent 安全会话使 unknown fail closed，不生成临床方案", async () => {
  const { application, tokenA } = await fixture();
  try {
    const started = dataOf<AgentSession>(await application.execute({
      command: "agent start",
      sessionToken: tokenA
    }));
    assert.equal(started.status, "awaiting_answer");
    assert.equal(started.nextQuestion?.key, "urgentHelp");

    const continued = dataOf<AgentSession>(await application.execute({
      command: "agent continue",
      sessionToken: tokenA,
      input: {
        id: started.id,
        expectedRevision: 1,
        question: "urgentHelp",
        answer: "unknown"
      }
    }));
    assert.equal(continued.status, "safety_blocked");
    assert.equal(continued.outcome, "cannot_confirm_safety");
    assert.equal(continued.approvedPlanAvailable, false);
    assert.equal(
      continued.decisionEvidence?.ruleId,
      "urgent_help_unknown_fail_closed"
    );
  } finally {
    application.close();
  }
});

test("Agent 会话隔离、版本冲突和服务重启恢复", async () => {
  const { application, databasePath, tokenA, tokenB } = await fixture();
  const symptom = await application.execute({
    command: "record symptom add",
    sessionToken: tokenA,
    input: {
      localDate: "2026-07-31",
      nasalCongestion: 2,
      nasalItching: 1,
      sneezing: 3,
      runnyNose: 2,
      idempotencyKey: "agent-snapshot"
    }
  });
  assert.equal(symptom.ok, true);
  const started = dataOf<AgentSession>(await application.execute({
    command: "agent start",
    sessionToken: tokenA
  }));

  const cross = await application.execute({
    command: "agent resume",
    sessionToken: tokenB,
    input: { id: started.id }
  });
  assert.equal(cross.ok, false);
  if (!cross.ok) {
    assert.equal(cross.error.code, "resource_not_found");
  }

  const completed = dataOf<AgentSession>(await application.execute({
    command: "agent continue",
    sessionToken: tokenA,
    input: {
      id: started.id,
      expectedRevision: 1,
      question: "urgentHelp",
      answer: "no"
    }
  }));
  assert.equal(completed.outcome, "clinical_content_unavailable");
  assert.equal(completed.recordSnapshot.lastTnss, 8);
  assert.equal(completed.recordSnapshot.recentSymptomDate, "2026-07-31");

  const stale = await application.execute({
    command: "agent continue",
    sessionToken: tokenA,
    input: {
      id: started.id,
      expectedRevision: 1,
      question: "urgentHelp",
      answer: "yes"
    }
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.error.code, "version_conflict");
  }
  application.close();

  const restarted = createApplication(databasePath);
  try {
    const restored = dataOf<AgentSession>(await restarted.execute({
      command: "agent resume",
      sessionToken: tokenA,
      input: { id: started.id }
    }));
    assert.equal(restored.revision, 2);
    assert.equal(restored.outcome, "clinical_content_unavailable");
  } finally {
    restarted.close();
  }
});

test("裸 agent continue 续接最近待答会话；无待答会话 resource_not_found", async () => {
  const { application, databasePath, tokenA, tokenB } = await fixture();
  try {
    // 无待答会话 → resource_not_found（消息明确"没有待回答的会话"）。
    const empty = await application.execute({
      command: "agent continue",
      sessionToken: tokenA,
      input: { expectedRevision: 1, question: "urgentHelp", answer: "no" }
    });
    assert.equal(empty.ok, false);
    if (!empty.ok) {
      assert.equal(empty.error.code, "resource_not_found");
      assert.match(empty.error.message, /没有待回答的会话/u);
    }

    // 两个待答会话：裸 continue 续接最近更新（updated_at DESC）的一个。
    const first = dataOf<AgentSession>(await application.execute({
      command: "agent start",
      sessionToken: tokenA
    }));
    const second = dataOf<AgentSession>(await application.execute({
      command: "agent start",
      sessionToken: tokenA
    }));
    // 直接调库拉开 updated_at，消除毫秒同值的排序歧义。
    const raw = new DatabaseSync(databasePath);
    try {
      raw
        .prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?")
        .run("2026-08-01T00:00:00.000Z", first.id);
      raw
        .prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?")
        .run("2026-08-02T00:00:00.000Z", second.id);
    } finally {
      raw.close();
    }

    const continued = dataOf<AgentSession>(await application.execute({
      command: "agent continue",
      sessionToken: tokenA,
      input: { expectedRevision: 1, question: "urgentHelp", answer: "no" }
    }));
    assert.equal(continued.id, second.id);
    assert.equal(continued.status, "completed");

    // 带 ID 续接原行为不变（含 expectedRevision CAS）。
    const firstContinued = dataOf<AgentSession>(await application.execute({
      command: "agent continue",
      sessionToken: tokenA,
      input: {
        id: first.id,
        expectedRevision: 1,
        question: "urgentHelp",
        answer: "yes"
      }
    }));
    assert.equal(firstContinued.status, "safety_blocked");

    // 患者隔离：tokenB 没有待答会话。
    const cross = await application.execute({
      command: "agent continue",
      sessionToken: tokenB,
      input: { expectedRevision: 1, question: "urgentHelp", answer: "no" }
    });
    assert.equal(cross.ok, false);
    if (!cross.ok) {
      assert.equal(cross.error.code, "resource_not_found");
    }

    // 匿名裸 continue → authentication_required（保持不变）。
    const anonymous = await application.execute({
      command: "agent continue",
      input: { expectedRevision: 1, question: "urgentHelp", answer: "no" }
    });
    assert.equal(anonymous.ok, false);
    if (!anonymous.ok) {
      assert.equal(anonymous.error.code, "authentication_required");
    }
  } finally {
    application.close();
  }
});
