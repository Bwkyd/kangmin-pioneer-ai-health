import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../app/composition-root.js";
import type { CommandResult } from "../kernel/result.js";
import type { AgentSession } from "../modules/agent/contracts.js";

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
  const tokenA =
    (await application.sessions.createDevelopmentSession("agent-a")).token;
  const tokenB =
    (await application.sessions.createDevelopmentSession("agent-b")).token;
  return { application, databasePath, tokenA, tokenB };
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
