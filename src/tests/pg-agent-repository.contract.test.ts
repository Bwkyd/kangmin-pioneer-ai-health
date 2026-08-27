/**
 * 切片 C PostgreSQL 仓储契约测试：
 * PgConversationRepository / PgAgentRepository / PgPlanRegistry。
 *
 * 逐条对齐 SQLite 原版语义：患者隔离、CAS revision（乐观并发）、
 * commitTurn 单事务原子性（无部分写入）、确认答案 upsert 幂等重放、
 * 加密字段（密文 JSON + encryption_key_version 列）、方案注册表
 * enabled 门禁与 method 属性键确定性映射。
 *
 * 运行：KANGMIN_TEST_DATABASE_URL=postgres://... node --test dist-c/tests/pg-agent-repository.contract.test.js
 * 连接串指向 PostgreSQL 服务器（如维护库 postgres），本文件据此创建一次性
 * 隔离库，结束后删除；未配置连接串时全部用例 skip。
 */

import test from "node:test";
import assert from "node:assert/strict";

import type {
  AgentSession
} from "@kangmin/core/intelligence/agent/contracts";
import type {
  CandidateRow,
  ConfirmedAnswerRow,
  ConversationMessage,
  ConversationSession,
  DecisionRow,
  FeedbackRow
} from "@kangmin/core/intelligence/agent/conversation-contracts";
import type { CommitTurnInput } from "@kangmin/core/intelligence/agent/conversation-repository";
import { PlaintextEncryption } from "../infrastructure/aes-gcm-encryption.js";
import {
  isUniqueViolation,
  KangminPgDatabase
} from "@kangmin/database/postgres/database";
import { PgAgentRepository } from "@kangmin/database/postgres/agent-repository";
import { PgConversationRepository } from "@kangmin/database/postgres/conversation-repository";
import { PgPlanRegistry } from "@kangmin/database/postgres/plan-registry";
import {
  createPgTestDatabase,
  type PgTestDatabase
} from "./pg-test-database.js";

const databaseUrl = process.env.KANGMIN_TEST_DATABASE_URL;
const TIMESTAMP = "2026-08-01T00:00:00.000Z";
// 远未来保留期：findAnonymousSession 带 retention_until > now 过滤
//（issue-155），fixture 默认值必须始终落在保留期内。
const RETENTION = "2099-01-01T00:00:00.000Z";

const encryption = new PlaintextEncryption();

let testDatabase: PgTestDatabase | null = null;

if (databaseUrl !== undefined) {
  test.before(async () => {
    testDatabase = await createPgTestDatabase("pg_agent");
  });
  test.after(async () => {
    const created = testDatabase;
    if (created !== null) {
      await created.close();
    }
  });
}

function contractTest(
  name: string,
  fn: (database: KangminPgDatabase) => Promise<void>
): void {
  if (databaseUrl === undefined) {
    test(name, { skip: "未配置 KANGMIN_TEST_DATABASE_URL" }, () => {});
    return;
  }
  void test(name, async () => {
    const url = testDatabase?.url;
    assert.ok(url !== undefined, "隔离测试库未初始化");
    const database = new KangminPgDatabase(url);
    try {
      await fn(database);
    } finally {
      await database.close();
    }
  });
}

async function insertPatient(
  database: KangminPgDatabase,
  id: string
): Promise<void> {
  await database.query(
    "INSERT INTO patients(id, created_at) VALUES ($1, $2)",
    [id, TIMESTAMP]
  );
}

function sessionFixture(
  id: string,
  overrides: Partial<ConversationSession> = {}
): ConversationSession {
  return {
    id,
    patientId: null,
    state: "active",
    saveConsentId: null,
    assessmentId: null,
    rulePackageVersion: "draft-2026-07",
    rulePackageHash: "rule-hash",
    revision: 1,
    lastSequence: 0,
    closedAt: null,
    retentionUntil: RETENTION,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides
  };
}

function decisionFixture(
  id: string,
  sessionId: string,
  sequence: number
): DecisionRow {
  return {
    id,
    sessionId,
    decisionSequence: sequence,
    sessionRevision: 1,
    inputSnapshotEncrypted: encryption.encrypt(`快照-${id}`),
    inputSnapshotHash: `snapshot-hash-${id}`,
    outcome: "need_more_information",
    stage: "safety",
    severityCode: null,
    syndromeCode: null,
    nextQuestionsJson: "[]",
    matchedRuleIdsJson: "[]",
    rulePackageVersion: "draft-2026-07",
    rulePackageHash: "rule-hash",
    phaseCode: null,
    audience: null,
    rulePackageStatus: null,
    planId: null,
    planRevision: null,
    createdAt: TIMESTAMP
  };
}

function messageFixture(
  id: string,
  sessionId: string,
  sequence: number,
  decisionId: string | null
): ConversationMessage {
  return {
    id,
    sessionId,
    sequence,
    role: decisionId === null ? "system_notice" : "assistant",
    decisionId,
    contentEncrypted: encryption.encrypt(`正文-${id}`),
    contentHash: `content-hash-${id}`,
    createdAt: TIMESTAMP
  };
}

function answerFixture(
  sessionId: string,
  fieldCode: string,
  revision: number
): ConfirmedAnswerRow {
  return {
    sessionId,
    fieldCode,
    value: "value",
    factValue: "yes",
    source: "patient",
    rulePackageVersion: "draft-2026-07",
    rulePackageHash: "rule-hash",
    revision,
    confirmedAt: TIMESTAMP
  };
}

function candidateFixture(id: string, sessionId: string): CandidateRow {
  return {
    id,
    sessionId,
    fieldCode: "nasal_congestion",
    proposedValueEncrypted: encryption.encrypt(`候选-${id}`),
    encryptionKeyVersion: encryption.keyVersion,
    sourceMessageId: null,
    state: "proposed",
    createdAt: TIMESTAMP,
    decidedAt: null
  };
}

function agentSessionFixture(
  id: string,
  revision: number,
  updatedAt: string
): AgentSession {
  return {
    id,
    status: "awaiting_answer",
    revision,
    answers: {},
    nextQuestion: {
      key: "urgentHelp",
      prompt: "是否需要紧急帮助？",
      answerType: "yes_no_unknown"
    },
    outcome: null,
    approvedPlanAvailable: false,
    recordSnapshot: {
      capturedAt: TIMESTAMP,
      recentSymptomDate: null,
      lastTnss: null,
      recentExposureDate: null,
      recentMedicationDate: null
    },
    decisionEvidence: null,
    createdAt: TIMESTAMP,
    updatedAt
  };
}

// ---------------------------------------------------------------------------
// PgConversationRepository：会话 CRUD 与患者/匿名隔离
// ---------------------------------------------------------------------------

contractTest("会话创建与查询：匿名会话仅 findAnonymousSession 可见", async (database) => {
  const repository = new PgConversationRepository(database);
  const anonymous = sessionFixture("c-conv-anon-1");
  await repository.createSession(anonymous);

  assert.deepEqual(await repository.findSession(anonymous.id), anonymous);
  assert.deepEqual(await repository.findAnonymousSession(anonymous.id), anonymous);
  // 匿名会话不属于任何患者：患者入口不可见（登录绑定的唯一入口是 findAnonymousSession）。
  assert.equal(await repository.findPatientSession("c-patient-x", anonymous.id), null);
  assert.equal(await repository.findSession("c-conv-missing"), null);
});

contractTest("患者隔离：findPatientSession/listPatientSessions 只认所属患者", async (database) => {
  const repository = new PgConversationRepository(database);
  await insertPatient(database, "c-patient-a");
  await insertPatient(database, "c-patient-b");
  const older = sessionFixture("c-conv-a-1", {
    patientId: "c-patient-a",
    updatedAt: "2026-08-01T01:00:00.000Z"
  });
  const newer = sessionFixture("c-conv-a-2", {
    patientId: "c-patient-a",
    updatedAt: "2026-08-01T02:00:00.000Z"
  });
  const other = sessionFixture("c-conv-b-1", { patientId: "c-patient-b" });
  await repository.createSession(older);
  await repository.createSession(newer);
  await repository.createSession(other);

  assert.equal(await repository.findPatientSession("c-patient-b", older.id), null);
  assert.deepEqual(await repository.findPatientSession("c-patient-a", older.id), older);
  // ORDER BY updated_at DESC：最新更新在前。
  const listed = await repository.listPatientSessions("c-patient-a");
  assert.deepEqual(listed.map((session) => session.id), [newer.id, older.id]);
  // 绑定患者的会话不再对匿名入口可见。
  assert.equal(await repository.findAnonymousSession(older.id), null);
});

contractTest("updateSession：not_found / version_conflict / updated 三分支", async (database) => {
  const repository = new PgConversationRepository(database);
  assert.deepEqual(
    await repository.updateSession(1, sessionFixture("c-conv-upd-missing")),
    { kind: "not_found" }
  );

  const session = sessionFixture("c-conv-upd-1");
  await repository.createSession(session);

  // CAS：期望版本落后 → version_conflict 并回传当前版本。
  assert.deepEqual(
    await repository.updateSession(99, { ...session, revision: 100 }),
    { kind: "version_conflict", currentRevision: 1 }
  );

  // 绑定匿名会话必须推进 revision：绑定只做所有权变更，CAS 生效。
  const bound: ConversationSession = {
    ...session,
    patientId: null,
    revision: 2,
    updatedAt: "2026-08-01T03:00:00.000Z"
  };
  assert.deepEqual(await repository.updateSession(1, bound), {
    kind: "updated",
    session: bound
  });
  assert.deepEqual(await repository.findSession(session.id), bound);
});

// ---------------------------------------------------------------------------
// PgConversationRepository：commitTurn 原子性与 CAS
// ---------------------------------------------------------------------------

contractTest("commitTurn：单事务写入答案/候选/决策/消息并推进会话版本", async (database) => {
  const repository = new PgConversationRepository(database);
  const session = sessionFixture("c-conv-turn-1");
  await repository.createSession(session);

  const next: ConversationSession = {
    ...session,
    revision: 2,
    lastSequence: 2,
    updatedAt: "2026-08-01T04:00:00.000Z"
  };
  const input: CommitTurnInput = {
    sessionId: session.id,
    expectedRevision: 1,
    answers: [answerFixture(session.id, "urgent_help", 2)],
    candidates: [candidateFixture("c-cand-turn-1", session.id)],
    decision: decisionFixture("c-dec-turn-1", session.id, 1),
    messages: [
      messageFixture("c-msg-turn-1", session.id, 1, null),
      messageFixture("c-msg-turn-2", session.id, 2, "c-dec-turn-1")
    ],
    next
  };
  assert.deepEqual(await repository.commitTurn(input), { kind: "committed" });

  const stored = await repository.findSession(session.id);
  assert.equal(stored?.revision, 2);
  assert.equal(stored?.lastSequence, 2);

  const answers = await repository.listConfirmedAnswers(session.id);
  assert.equal(answers.length, 1);
  assert.equal(answers[0]?.fieldCode, "urgent_help");

  const candidates = await repository.listCandidates(session.id);
  assert.equal(candidates.length, 1);
  // 候选密文 JSON 完整存库，可按 keyVersion 解密回原文。
  const proposed = candidates[0]?.proposedValueEncrypted;
  assert.ok(proposed !== null && proposed !== undefined);
  assert.equal(encryption.decrypt(proposed), "候选-c-cand-turn-1");

  const decisions = await repository.listDecisions(session.id);
  assert.equal(decisions.length, 1);
  assert.equal(
    encryption.decrypt(decisions[0]!.inputSnapshotEncrypted),
    "快照-c-dec-turn-1"
  );

  // 消息密文与 keyVersion 列一致（encryption_key_version 单独成列）。
  const { rows } = await database.query<{
    encryption_key_version: string;
    content_encrypted: string;
  }>(
    "SELECT encryption_key_version, content_encrypted FROM agent_messages WHERE session_id = $1 ORDER BY sequence",
    [session.id]
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.encryption_key_version, encryption.keyVersion);
});

contractTest("commitTurn 并发 CAS：旧 revision 提交返回 version_conflict 且无部分写入", async (database) => {
  const repository = new PgConversationRepository(database);
  const session = sessionFixture("c-conv-cas-1");
  await repository.createSession(session);

  const commitInput = (
    expectedRevision: number,
    next: ConversationSession,
    suffix: string
  ): CommitTurnInput => ({
    sessionId: session.id,
    expectedRevision,
    answers: [],
    candidates: [],
    decision: decisionFixture(`c-dec-cas-${suffix}`, session.id, 1),
    messages: [
      messageFixture(`c-msg-cas-${suffix}`, session.id, 1, `c-dec-cas-${suffix}`)
    ],
    next
  });

  // 第一轮：读到的 revision=1 提交成功（revision 1→2）。
  assert.deepEqual(
    await repository.commitTurn(
      commitInput(1, { ...session, revision: 2, lastSequence: 1 }, "first")
    ),
    { kind: "committed" }
  );

  // 第二轮以旧 revision（1）提交：模拟并发窗口内另一轮已提交，
  // 整轮拒绝（CAS 乐观锁），不产生任何部分写入。
  assert.deepEqual(
    await repository.commitTurn(
      commitInput(1, { ...session, revision: 2, lastSequence: 3 }, "second")
    ),
    { kind: "version_conflict", currentRevision: 2 }
  );

  // COUNT 聚合在 pg 中是 int8（string），必须 ::int 强转。
  const { rows } = await database.query<{
    decisions: number;
    messages: number;
    revision: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM agent_decisions WHERE session_id = $1) AS decisions,
       (SELECT COUNT(*)::int FROM agent_messages WHERE session_id = $1) AS messages,
       (SELECT revision FROM agent_conversations WHERE id = $1) AS revision`,
    [session.id]
  );
  assert.equal(rows[0]?.decisions, 1);
  assert.equal(rows[0]?.messages, 1);
  assert.equal(rows[0]?.revision, 2);
});

contractTest("commitTurn：会话不存在返回 version_conflict currentRevision=0", async (database) => {
  const repository = new PgConversationRepository(database);
  const outcome = await repository.commitTurn({
    sessionId: "c-conv-cas-missing",
    expectedRevision: 1,
    answers: [],
    candidates: [],
    decision: decisionFixture("c-dec-cas-missing", "c-conv-cas-missing", 1),
    messages: [],
    next: sessionFixture("c-conv-cas-missing", { revision: 2 })
  });
  assert.deepEqual(outcome, { kind: "version_conflict", currentRevision: 0 });
});

// ---------------------------------------------------------------------------
// PgConversationRepository：消息/答案/候选/决策/反馈子表
// ---------------------------------------------------------------------------

contractTest("appendMessage：UNIQUE(session_id, sequence) 重复序号报唯一冲突", async (database) => {
  const repository = new PgConversationRepository(database);
  const session = sessionFixture("c-conv-msg-1");
  await repository.createSession(session);

  await repository.appendMessage(messageFixture("c-msg-dup-1", session.id, 1, null));
  await repository.appendMessage(messageFixture("c-msg-ordered-2", session.id, 2, null));
  const listed = await repository.listMessages(session.id);
  assert.deepEqual(listed.map((message) => message.sequence), [1, 2]);
  assert.equal(encryption.decrypt(listed[0]!.contentEncrypted), "正文-c-msg-dup-1");
  const duplicate = messageFixture("c-msg-dup-2", session.id, 1, null);
  await assert.rejects(
    repository.appendMessage(duplicate),
    (error: unknown) => isUniqueViolation(error)
  );
});

contractTest("setConfirmedAnswer：同字段重复写为 upsert（幂等重放覆盖旧值）", async (database) => {
  const repository = new PgConversationRepository(database);
  const session = sessionFixture("c-conv-ans-1");
  await repository.createSession(session);

  await repository.setConfirmedAnswer(answerFixture(session.id, "urgent_help", 1));
  // 幂等重放：同 (session_id, field_code) 再次写入覆盖而非冲突。
  const replayed: ConfirmedAnswerRow = {
    ...answerFixture(session.id, "urgent_help", 2),
    value: "no",
    factValue: null
  };
  await repository.setConfirmedAnswer(replayed);
  await repository.setConfirmedAnswer(answerFixture(session.id, "severity", 1));

  const answers = await repository.listConfirmedAnswers(session.id);
  assert.equal(answers.length, 2);
  const urgent = answers.find((answer) => answer.fieldCode === "urgent_help");
  assert.equal(urgent?.value, "no");
  assert.equal(urgent?.revision, 2);
});

contractTest("六步树节点答案：同题首次与二次确认可独立保存 A/B/C", async (database) => {
  const repository = new PgConversationRepository(database);
  const session = sessionFixture("c-conv-six-step");
  await repository.createSession(session);

  for (const [fieldCode, factValue] of [
    ["step1_q10", "B"],
    ["step2_q8", "C"],
    ["step5_q8_confirm", "B"],
    ["step6_q10_confirm", "A"]
  ] as const) {
    await repository.setConfirmedAnswer({
      ...answerFixture(session.id, fieldCode, 1),
      factValue,
      rulePackageVersion: "clinical-rules-v2"
    });
  }

  const answers = await repository.listConfirmedAnswers(session.id);
  assert.equal(answers.length, 4);
  assert.deepEqual(
    new Map(answers.map((answer) => [answer.fieldCode, answer.factValue])),
    new Map([
      ["step1_q10", "B"],
      ["step2_q8", "C"],
      ["step5_q8_confirm", "B"],
      ["step6_q10_confirm", "A"]
    ])
  );
});

contractTest("候选：listCandidates 按 created_at 升序，markCandidateDecided 落定状态", async (database) => {
  const repository = new PgConversationRepository(database);
  const session = sessionFixture("c-conv-cand-1");
  await repository.createSession(session);

  const later: CandidateRow = {
    ...candidateFixture("c-cand-ord-2", session.id),
    createdAt: "2026-08-01T02:00:00.000Z"
  };
  const earlier: CandidateRow = {
    ...candidateFixture("c-cand-ord-1", session.id),
    createdAt: "2026-08-01T01:00:00.000Z"
  };
  await repository.addCandidate(later);
  await repository.addCandidate(earlier);

  const listed = await repository.listCandidates(session.id);
  assert.deepEqual(listed.map((candidate) => candidate.id), [earlier.id, later.id]);

  await repository.markCandidateDecided(earlier.id, "adopted");
  const decided = (await repository.listCandidates(session.id)).find(
    (candidate) => candidate.id === earlier.id
  );
  assert.equal(decided?.state, "adopted");
  assert.ok(decided?.decidedAt !== null && decided?.decidedAt !== undefined);
});

contractTest("saveDecision/listDecisions：按 decision_sequence 升序，快照密文可解密", async (database) => {
  const repository = new PgConversationRepository(database);
  const session = sessionFixture("c-conv-dec-1");
  await repository.createSession(session);

  await repository.saveDecision(decisionFixture("c-dec-ord-2", session.id, 2));
  await repository.saveDecision(decisionFixture("c-dec-ord-1", session.id, 1));

  const decisions = await repository.listDecisions(session.id);
  assert.deepEqual(
    decisions.map((decision) => decision.decisionSequence),
    [1, 2]
  );
  assert.equal(
    encryption.decrypt(decisions[0]!.inputSnapshotEncrypted),
    "快照-c-dec-ord-1"
  );
});

contractTest("反馈：reason 为空时 keyVersion 落 'none'；findFeedback 校验会话归属", async (database) => {
  const repository = new PgConversationRepository(database);
  const session = sessionFixture("c-conv-fb-1");
  const other = sessionFixture("c-conv-fb-2");
  await repository.createSession(session);
  await repository.createSession(other);

  const withoutReason: FeedbackRow = {
    id: "c-fb-1",
    sessionId: session.id,
    decisionId: null,
    rating: "helpful",
    reasonEncrypted: null,
    createdAt: TIMESTAMP
  };
  await repository.addFeedback(withoutReason);

  const found = await repository.findFeedback(session.id, withoutReason.id);
  assert.deepEqual(found, withoutReason);
  // 会话归属不匹配 → null（患者隔离语义与 SQLite 一致）。
  assert.equal(await repository.findFeedback(other.id, withoutReason.id), null);

  const { rows } = await database.query<{ encryption_key_version: string }>(
    "SELECT encryption_key_version FROM agent_feedback WHERE id = $1",
    [withoutReason.id]
  );
  assert.equal(rows[0]?.encryption_key_version, "none");

  const withReason: FeedbackRow = {
    id: "c-fb-2",
    sessionId: session.id,
    decisionId: null,
    rating: "unhelpful",
    reasonEncrypted: encryption.encrypt("原因"),
    createdAt: TIMESTAMP
  };
  await repository.addFeedback(withReason);
  const foundReason = await repository.findFeedback(session.id, withReason.id);
  assert.ok(
    foundReason?.reasonEncrypted !== null &&
      foundReason?.reasonEncrypted !== undefined
  );
  assert.equal(encryption.decrypt(foundReason.reasonEncrypted), "原因");
});

// ---------------------------------------------------------------------------
// PgAgentRepository：确定性安全外壳会话
// ---------------------------------------------------------------------------

contractTest("agent 会话：create/find/list 与患者隔离、updated_at DESC 排序", async (database) => {
  const repository = new PgAgentRepository(database);
  await insertPatient(database, "c-agent-patient-a");
  await insertPatient(database, "c-agent-patient-b");

  const older = agentSessionFixture("c-agent-a-1", 1, "2026-08-01T01:00:00.000Z");
  const newer = agentSessionFixture("c-agent-a-2", 1, "2026-08-01T02:00:00.000Z");
  await repository.create("c-agent-patient-a", older);
  await repository.create("c-agent-patient-a", newer);
  await repository.create(
    "c-agent-patient-b",
    agentSessionFixture("c-agent-b-1", 1, TIMESTAMP)
  );

  // 患者隔离：错 patientId 查不到（与 SQLite 版 WHERE id AND patient_id 一致）。
  assert.equal(await repository.find("c-agent-patient-b", older.id), null);
  assert.deepEqual(await repository.find("c-agent-patient-a", older.id), older);

  const listed = await repository.list("c-agent-patient-a");
  assert.deepEqual(listed.map((session) => session.id), [newer.id, older.id]);

  // 主键重复 → 唯一约束冲突（对应 SQLite 的 UNIQUE constraint failed）。
  await assert.rejects(
    repository.create("c-agent-patient-a", older),
    (error: unknown) => isUniqueViolation(error)
  );
});

contractTest("agent 会话 update：CAS 三分支（not_found/version_conflict/updated）", async (database) => {
  const repository = new PgAgentRepository(database);
  await insertPatient(database, "c-agent-patient-c");
  const session = agentSessionFixture("c-agent-c-1", 1, TIMESTAMP);
  await repository.create("c-agent-patient-c", session);

  assert.deepEqual(
    await repository.update(
      "c-agent-patient-c",
      1,
      agentSessionFixture("c-agent-c-missing", 2, TIMESTAMP)
    ),
    { kind: "not_found" }
  );
  // 错患者同样是 not_found（不泄露他人会话存在性）。
  assert.deepEqual(
    await repository.update("c-agent-patient-b", 1, session),
    { kind: "not_found" }
  );

  assert.deepEqual(
    await repository.update("c-agent-patient-c", 7, {
      ...session,
      revision: 8
    }),
    { kind: "version_conflict", currentRevision: 1 }
  );

  const advanced: AgentSession = {
    ...session,
    status: "completed",
    revision: 2,
    updatedAt: "2026-08-01T05:00:00.000Z"
  };
  assert.deepEqual(await repository.update("c-agent-patient-c", 1, advanced), {
    kind: "updated",
    session: advanced
  });
  assert.deepEqual(
    await repository.find("c-agent-patient-c", session.id),
    advanced
  );
});

// ---------------------------------------------------------------------------
// PgPlanRegistry：enabled 门禁与 method 属性键映射
// ---------------------------------------------------------------------------

async function insertPlan(
  database: KangminPgDatabase,
  plan: {
    id: string;
    syndrome: string;
    method: string;
    status: "draft" | "enabled" | "disabled";
    displayOrder: number;
    revision: number;
    phaseCode?: string | null;
    audience?: string | null;
  }
): Promise<void> {
  await database.query(
    `INSERT INTO agent_plans(
      id, name, syndrome, method, steps_json, precautions, risks,
      contraindications, phase_code, audience, display_order, status,
      revision, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      plan.id,
      `方案-${plan.id}`,
      plan.syndrome,
      plan.method,
      "[]",
      "注意事项",
      "风险",
      "禁忌",
      plan.phaseCode ?? null,
      plan.audience ?? null,
      plan.displayOrder,
      plan.status,
      plan.revision,
      TIMESTAMP,
      TIMESTAMP
    ]
  );
}

contractTest("方案注册表：仅 enabled 可见，display_order 优先，method 确定性映射", async (database) => {
  const registry = new PgPlanRegistry(database);
  const syndrome = "C_TEST_SYNDROME";

  // draft/disabled 不参与 Agent 匹配（enabled 门禁）。
  await insertPlan(database, {
    id: "c-plan-draft",
    syndrome,
    method: "艾灸",
    status: "draft",
    displayOrder: 0,
    revision: 1
  });
  const draftBundle = await registry.findApprovedPlanBundle({
    syndromeCode: syndrome,
    phaseCode: "acute",
    audience: "adult"
  });
  assert.equal(draftBundle.acute, null);
  assert.equal(draftBundle.constitution, null);

  // display_order 小者优先；同序按 id ASC（LIMIT 1 确定性）。
  await insertPlan(database, {
    id: "c-plan-b",
    syndrome,
    method: "刮痧拔罐",
    status: "enabled",
    displayOrder: 2,
    revision: 3,
    phaseCode: null,
    audience: "adult"
  });
  await insertPlan(database, {
    id: "c-plan-a",
    syndrome,
    method: "艾灸加刮痧",
    status: "enabled",
    displayOrder: 1,
    revision: 5,
    phaseCode: null,
    audience: "adult"
  });

  const bundle = await registry.findApprovedPlanBundle({
    syndromeCode: syndrome,
    phaseCode: "acute",
    audience: "adult"
  });
  assert.equal(bundle.constitution?.planId, "c-plan-a");
  assert.equal(bundle.constitution?.planRevision, 5);
  // 含“灸”→moxibustion，含“刮”→guasha_cupping。
  assert.deepEqual(bundle.constitution?.attributes, {
    moxibustion: "yes",
    guasha_cupping: "yes"
  });
});

contractTest("方案注册表：method 无法映射时不输出属性键（unmatched 安全语义）", async (database) => {
  const registry = new PgPlanRegistry(database);
  await insertPlan(database, {
    id: "c-plan-plain",
    syndrome: "C_TEST_PLAIN",
    method: "鼻腔冲洗",
    status: "enabled",
    displayOrder: 0,
    revision: 2,
    phaseCode: null,
    audience: "adult"
  });

  const bundle = await registry.findApprovedPlanBundle({
    syndromeCode: "C_TEST_PLAIN",
    phaseCode: "acute",
    audience: "adult"
  });
  // 未知方法绝不猜测：不输出 moxibustion/guasha_cupping 键。
  assert.deepEqual(bundle.constitution?.attributes, {});
  const missing = await registry.findApprovedPlanBundle({
    syndromeCode: "C_TEST_NO_SUCH",
    phaseCode: "acute",
    audience: "adult"
  });
  assert.equal(missing.acute, null);
  assert.equal(missing.constitution, null);
});

contractTest("匿名保留期：findAnonymousSession 过滤过期会话（issue-155）", async (database) => {
  const repository = new PgConversationRepository(database);
  // 保留期内（远未来）可查；过期（过去时间）视为不存在。
  const fresh = sessionFixture("c-conv-ret-fresh", {
    retentionUntil: "2099-01-01T00:00:00.000Z"
  });
  const expired = sessionFixture("c-conv-ret-expired", {
    retentionUntil: "2020-01-01T00:00:00.000Z"
  });
  await repository.createSession(fresh);
  await repository.createSession(expired);

  assert.deepEqual(await repository.findAnonymousSession(fresh.id), fresh);
  assert.equal(await repository.findAnonymousSession(expired.id), null);
  // 不带保留期语义的 findSession 仍可读（清理前的管理面可见性）。
  assert.deepEqual(await repository.findSession(expired.id), expired);
});

contractTest("匿名保留期清理：级联删除 5 子表 + 主表，绑定会话不受影响", async (database) => {
  const repository = new PgConversationRepository(database);
  // 契约测试共享库：上方过滤用例残留了过期匿名会话，
  // 先预清一次保证下方删除计数确定。
  await repository.deleteExpiredAnonymousSessions(new Date().toISOString());
  await insertPatient(database, "c-patient-retention");
  const expiredAnonymous = sessionFixture("c-conv-clean-expired", {
    retentionUntil: "2020-01-01T00:00:00.000Z"
  });
  const freshAnonymous = sessionFixture("c-conv-clean-fresh", {
    retentionUntil: "2099-01-01T00:00:00.000Z"
  });
  // 绑定会话（patient_id 非空）即使 retention_until 已过也不受匿名清理影响。
  const expiredBound = sessionFixture("c-conv-clean-bound", {
    patientId: "c-patient-retention",
    retentionUntil: "2020-01-01T00:00:00.000Z"
  });
  await repository.createSession(expiredAnonymous);
  await repository.createSession(freshAnonymous);
  await repository.createSession(expiredBound);

  // 过期匿名会话的 5 子表行。
  await repository.setConfirmedAnswer(answerFixture("c-conv-clean-expired", "urgent_help", 1));
  await repository.addCandidate(candidateFixture("c-cand-clean", "c-conv-clean-expired"));
  await repository.saveDecision(decisionFixture("c-dec-clean", "c-conv-clean-expired", 1));
  await repository.appendMessage(messageFixture("c-msg-clean", "c-conv-clean-expired", 1, "c-dec-clean"));
  await repository.addFeedback({
    id: "c-fb-clean",
    sessionId: "c-conv-clean-expired",
    decisionId: "c-dec-clean",
    rating: "helpful",
    reasonEncrypted: null,
    createdAt: TIMESTAMP
  });

  const deleted = await repository.deleteExpiredAnonymousSessions(
    new Date().toISOString()
  );
  assert.equal(deleted, 1);

  assert.equal(await repository.findSession("c-conv-clean-expired"), null);
  assert.deepEqual(await repository.findSession("c-conv-clean-fresh"), freshAnonymous);
  assert.deepEqual(await repository.findSession("c-conv-clean-bound"), expiredBound);
  for (const child of [
    "agent_messages",
    "agent_confirmed_answers",
    "agent_candidates",
    "agent_decisions",
    "agent_feedback"
  ]) {
    const { rows } = await database.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${child} WHERE session_id = $1`,
      ["c-conv-clean-expired"]
    );
    assert.equal(Number(rows[0]?.count ?? -1), 0, child);
  }
});

contractTest("findLatestAwaiting：最近待答会话，排除已终止与他患者（裸 continue）", async (database) => {
  const repository = new PgAgentRepository(database);
  await insertPatient(database, "c-agent-patient-d");
  // 无会话 → null。
  assert.equal(await repository.findLatestAwaiting("c-agent-patient-d"), null);

  const older = agentSessionFixture("c-agent-d-1", 1, "2026-08-01T01:00:00.000Z");
  const newer = agentSessionFixture("c-agent-d-2", 1, "2026-08-01T02:00:00.000Z");
  await repository.create("c-agent-patient-d", older);
  await repository.create("c-agent-patient-d", newer);
  // 已终止会话不参与待答解析。
  await repository.create("c-agent-patient-d", {
    ...agentSessionFixture("c-agent-d-3", 1, "2026-08-01T03:00:00.000Z"),
    status: "completed"
  });
  await repository.create(
    "c-agent-patient-b",
    agentSessionFixture("c-agent-b-9", 1, "2026-08-01T04:00:00.000Z")
  );

  const latest = await repository.findLatestAwaiting("c-agent-patient-d");
  assert.deepEqual(latest, newer);
});
