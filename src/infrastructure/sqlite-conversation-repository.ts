/**
 * agent_conversations 与 §4.5 五个子表的 SQLite 实现。
 * 会话正文/候选值/输入快照以密文 JSON 存储，普通日志不含明文。
 */

import { KangminDatabase } from "./database.js";
import type {
  CandidateRow,
  ConfirmedAnswerRow,
  ConversationMessage,
  ConversationSession,
  DecisionRow,
  EncryptedContent,
  FeedbackRow
} from "../modules/agent/conversation-contracts.js";
import type {
  CommitTurnInput,
  CommitTurnOutcome,
  ConversationRepository,
  UpdateSessionOutcome
} from "../modules/agent/conversation-repository.js";

function parseEncrypted(value: string): EncryptedContent {
  return JSON.parse(value) as EncryptedContent;
}

function serializeEncrypted(value: EncryptedContent | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

interface ConversationRow {
  id: string;
  patient_id: string | null;
  state: string;
  save_consent_id: string | null;
  rule_package_version: string;
  rule_package_hash: string;
  revision: number;
  last_sequence: number;
  closed_at: string | null;
  retention_until: string;
  created_at: string;
  updated_at: string;
}

function parseSession(row: ConversationRow): ConversationSession {
  return {
    id: row.id,
    patientId: row.patient_id,
    state: row.state as ConversationSession["state"],
    saveConsentId: row.save_consent_id,
    rulePackageVersion: row.rule_package_version,
    rulePackageHash: row.rule_package_hash,
    revision: row.revision,
    lastSequence: row.last_sequence,
    closedAt: row.closed_at,
    retentionUntil: row.retention_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly database: KangminDatabase) {}

  async createSession(session: ConversationSession): Promise<void> {
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO agent_conversations(
            id, patient_id, state, save_consent_id, rule_package_version,
            rule_package_hash, revision, last_sequence, closed_at,
            retention_until, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          session.id,
          session.patientId,
          session.state,
          session.saveConsentId,
          session.rulePackageVersion,
          session.rulePackageHash,
          session.revision,
          session.lastSequence,
          session.closedAt,
          session.retentionUntil,
          session.createdAt,
          session.updatedAt
        );
    });
  }

  async findSession(id: string): Promise<ConversationSession | null> {
    const row = this.database.connection
      .prepare("SELECT * FROM agent_conversations WHERE id = ?")
      .get(id) as unknown as ConversationRow | undefined;
    return row === undefined ? null : parseSession(row);
  }

  async findAnonymousSession(id: string): Promise<ConversationSession | null> {
    // 过期匿名会话（retention_until <= now）视为不存在（issue-155：
    // 24h 保留期执行，service 层自然得到 resource_not_found）。
    const row = this.database.connection
      .prepare(
        `SELECT * FROM agent_conversations
         WHERE id = ? AND patient_id IS NULL AND retention_until > ?`
      )
      .get(id, new Date().toISOString()) as unknown as ConversationRow | undefined;
    return row === undefined ? null : parseSession(row);
  }

  async deleteExpiredAnonymousSessions(now: string): Promise<number> {
    return this.database.transaction(() => {
      // 级联删除 5 张子表（schema 无 ON DELETE CASCADE），再删主表；
      // 绑定会话（patient_id 非空）不受匿名清理影响。
      const expired =
        "SELECT id FROM agent_conversations WHERE patient_id IS NULL AND retention_until <= ?";
      for (const child of [
        "agent_messages",
        "agent_confirmed_answers",
        "agent_candidates",
        "agent_decisions",
        "agent_feedback"
      ]) {
        this.database.connection
          .prepare(`DELETE FROM ${child} WHERE session_id IN (${expired})`)
          .run(now);
      }
      const result = this.database.connection
        .prepare(
          "DELETE FROM agent_conversations WHERE patient_id IS NULL AND retention_until <= ?"
        )
        .run(now);
      return Number(result.changes);
    });
  }

  async findPatientSession(
    patientId: string,
    id: string
  ): Promise<ConversationSession | null> {
    const row = this.database.connection
      .prepare(
        "SELECT * FROM agent_conversations WHERE id = ? AND patient_id = ?"
      )
      .get(id, patientId) as unknown as ConversationRow | undefined;
    return row === undefined ? null : parseSession(row);
  }

  async listPatientSessions(patientId: string): Promise<ConversationSession[]> {
    const rows = this.database.connection
      .prepare(
        `SELECT * FROM agent_conversations
         WHERE patient_id = ? ORDER BY updated_at DESC`
      )
      .all(patientId) as unknown as ConversationRow[];
    return rows.map(parseSession);
  }

  async updateSession(
    expectedRevision: number,
    session: ConversationSession
  ): Promise<UpdateSessionOutcome> {
    return this.database.transaction(() => {
      const current = this.database.connection
        .prepare("SELECT revision FROM agent_conversations WHERE id = ?")
        .get(session.id) as unknown as { revision: number } | undefined;
      if (current === undefined) {
        return { kind: "not_found" };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict", currentRevision: current.revision };
      }
      const result = this.database.connection
        .prepare(`
          UPDATE agent_conversations
          SET patient_id = ?, state = ?, save_consent_id = ?,
              revision = ?, last_sequence = ?, closed_at = ?,
              retention_until = ?, updated_at = ?
          WHERE id = ? AND revision = ?
        `)
        .run(
          session.patientId,
          session.state,
          session.saveConsentId,
          session.revision,
          session.lastSequence,
          session.closedAt,
          session.retentionUntil,
          session.updatedAt,
          session.id,
          expectedRevision
        );
      if (result.changes !== 1) {
        return { kind: "version_conflict", currentRevision: current.revision };
      }
      return { kind: "updated", session };
    });
  }

  /**
   * 单事务提交一轮对话的全部写入（评审 B P1-2）：
   * CAS 会话版本 → 答案 → 候选 → 决策 → 消息 → 会话状态。
   * 任何一步失败整轮回滚；并发轮次因 CAS 不匹配被拒绝，
   * 不会产生部分写入或 UNIQUE(session_id, sequence) 冲突。
   */
  async commitTurn(input: CommitTurnInput): Promise<CommitTurnOutcome> {
    return this.database.transaction(() => {
      const current = this.database.connection
        .prepare("SELECT revision FROM agent_conversations WHERE id = ?")
        .get(input.sessionId) as unknown as { revision: number } | undefined;
      if (current === undefined) {
        return { kind: "version_conflict", currentRevision: 0 };
      }
      if (current.revision !== input.expectedRevision) {
        return {
          kind: "version_conflict",
          currentRevision: current.revision
        };
      }

      const session = input.next;
      const sessionResult = this.database.connection
        .prepare(`
          UPDATE agent_conversations
          SET patient_id = ?, state = ?, save_consent_id = ?,
              revision = ?, last_sequence = ?, closed_at = ?,
              retention_until = ?, updated_at = ?
          WHERE id = ? AND revision = ?
        `)
        .run(
          session.patientId,
          session.state,
          session.saveConsentId,
          session.revision,
          session.lastSequence,
          session.closedAt,
          session.retentionUntil,
          session.updatedAt,
          input.sessionId,
          input.expectedRevision
        );
      if (sessionResult.changes !== 1) {
        return {
          kind: "version_conflict",
          currentRevision: current.revision
        };
      }

      const upsertAnswer = this.database.connection.prepare(`
        INSERT INTO agent_confirmed_answers(
          session_id, field_code, value, fact_value, source,
          rule_package_version, rule_package_hash, revision, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, field_code) DO UPDATE SET
          value = excluded.value,
          fact_value = excluded.fact_value,
          source = excluded.source,
          rule_package_version = excluded.rule_package_version,
          rule_package_hash = excluded.rule_package_hash,
          revision = excluded.revision,
          confirmed_at = excluded.confirmed_at
      `);
      for (const answer of input.answers) {
        upsertAnswer.run(
          answer.sessionId,
          answer.fieldCode,
          answer.value,
          answer.factValue,
          answer.source,
          answer.rulePackageVersion,
          answer.rulePackageHash,
          answer.revision,
          answer.confirmedAt
        );
      }

      const insertCandidate = this.database.connection.prepare(`
        INSERT INTO agent_candidates(
          id, session_id, field_code, proposed_value_encrypted,
          encryption_key_version, source_message_id, state,
          created_at, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const candidate of input.candidates) {
        insertCandidate.run(
          candidate.id,
          candidate.sessionId,
          candidate.fieldCode,
          serializeEncrypted(candidate.proposedValueEncrypted),
          candidate.encryptionKeyVersion,
          candidate.sourceMessageId,
          candidate.state,
          candidate.createdAt,
          candidate.decidedAt
        );
      }

      const decision = input.decision;
      this.database.connection
        .prepare(`
          INSERT INTO agent_decisions(
            id, session_id, decision_sequence, session_revision,
            input_snapshot_encrypted, input_snapshot_hash,
            outcome, stage, severity_code, syndrome_code,
            phase_code, audience, rule_package_status,
            next_questions_json, matched_rule_ids_json,
            rule_package_version, rule_package_hash,
            plan_id, plan_revision, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          decision.id,
          decision.sessionId,
          decision.decisionSequence,
          decision.sessionRevision,
          serializeEncrypted(decision.inputSnapshotEncrypted),
          decision.inputSnapshotHash,
          decision.outcome,
          decision.stage,
          decision.severityCode,
          decision.syndromeCode,
          decision.phaseCode,
          decision.audience,
          decision.rulePackageStatus,
          decision.nextQuestionsJson,
          decision.matchedRuleIdsJson,
          decision.rulePackageVersion,
          decision.rulePackageHash,
          decision.planId,
          decision.planRevision,
          decision.createdAt
        );

      const insertMessage = this.database.connection.prepare(`
        INSERT INTO agent_messages(
          id, session_id, sequence, role, decision_id,
          content_encrypted, content_hash, encryption_key_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const message of input.messages) {
        insertMessage.run(
          message.id,
          message.sessionId,
          message.sequence,
          message.role,
          message.decisionId,
          serializeEncrypted(message.contentEncrypted),
          message.contentHash,
          message.contentEncrypted.keyVersion,
          message.createdAt
        );
      }

      return { kind: "committed" };
    });
  }

  async appendMessage(message: ConversationMessage): Promise<void> {
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO agent_messages(
            id, session_id, sequence, role, decision_id,
            content_encrypted, content_hash, encryption_key_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          message.id,
          message.sessionId,
          message.sequence,
          message.role,
          message.decisionId,
          serializeEncrypted(message.contentEncrypted),
          message.contentHash,
          message.contentEncrypted.keyVersion,
          message.createdAt
        );
    });
  }

  async setConfirmedAnswer(answer: ConfirmedAnswerRow): Promise<void> {
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO agent_confirmed_answers(
            session_id, field_code, value, fact_value, source,
            rule_package_version, rule_package_hash, revision, confirmed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, field_code) DO UPDATE SET
            value = excluded.value,
            fact_value = excluded.fact_value,
            source = excluded.source,
            rule_package_version = excluded.rule_package_version,
            rule_package_hash = excluded.rule_package_hash,
            revision = excluded.revision,
            confirmed_at = excluded.confirmed_at
        `)
        .run(
          answer.sessionId,
          answer.fieldCode,
          answer.value,
          answer.factValue,
          answer.source,
          answer.rulePackageVersion,
          answer.rulePackageHash,
          answer.revision,
          answer.confirmedAt
        );
    });
  }

  async listConfirmedAnswers(sessionId: string): Promise<ConfirmedAnswerRow[]> {
    const rows = this.database.connection
      .prepare(
        `SELECT session_id, field_code, value, fact_value, source,
                rule_package_version, rule_package_hash, revision, confirmed_at
         FROM agent_confirmed_answers WHERE session_id = ?`
      )
      .all(sessionId) as unknown as Array<{
      session_id: string;
      field_code: string;
      value: string;
      fact_value: string | null;
      source: string;
      rule_package_version: string;
      rule_package_hash: string;
      revision: number;
      confirmed_at: string;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      fieldCode: row.field_code,
      value: row.value,
      factValue: row.fact_value,
      source: row.source,
      rulePackageVersion: row.rule_package_version,
      rulePackageHash: row.rule_package_hash,
      revision: row.revision,
      confirmedAt: row.confirmed_at
    }));
  }

  async addCandidate(candidate: CandidateRow): Promise<void> {
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO agent_candidates(
            id, session_id, field_code, proposed_value_encrypted,
            encryption_key_version, source_message_id, state, created_at, decided_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          candidate.id,
          candidate.sessionId,
          candidate.fieldCode,
          serializeEncrypted(candidate.proposedValueEncrypted),
          candidate.encryptionKeyVersion,
          candidate.sourceMessageId,
          candidate.state,
          candidate.createdAt,
          candidate.decidedAt
        );
    });
  }

  async listCandidates(sessionId: string): Promise<CandidateRow[]> {
    const rows = this.database.connection
      .prepare(
        `SELECT * FROM agent_candidates WHERE session_id = ? ORDER BY created_at ASC`
      )
      .all(sessionId) as unknown as Array<{
      id: string;
      session_id: string;
      field_code: string;
      proposed_value_encrypted: string | null;
      encryption_key_version: string;
      source_message_id: string | null;
      state: string;
      created_at: string;
      decided_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      fieldCode: row.field_code,
      proposedValueEncrypted:
        row.proposed_value_encrypted === null
          ? null
          : parseEncrypted(row.proposed_value_encrypted),
      encryptionKeyVersion: row.encryption_key_version,
      sourceMessageId: row.source_message_id,
      state: row.state as CandidateRow["state"],
      createdAt: row.created_at,
      decidedAt: row.decided_at
    }));
  }

  async markCandidateDecided(id: string, state: CandidateRow["state"]): Promise<void> {
    this.database.transaction(() => {
      this.database.connection
        .prepare(
          "UPDATE agent_candidates SET state = ?, decided_at = ? WHERE id = ?"
        )
        .run(state, new Date().toISOString(), id);
    });
  }

  async saveDecision(decision: DecisionRow): Promise<void> {
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO agent_decisions(
            id, session_id, decision_sequence, session_revision,
            input_snapshot_encrypted, input_snapshot_hash, outcome, stage,
            severity_code, syndrome_code, phase_code, audience,
            rule_package_status, next_questions_json,
            matched_rule_ids_json, rule_package_version, rule_package_hash,
            plan_id, plan_revision, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          decision.id,
          decision.sessionId,
          decision.decisionSequence,
          decision.sessionRevision,
          serializeEncrypted(decision.inputSnapshotEncrypted),
          decision.inputSnapshotHash,
          decision.outcome,
          decision.stage,
          decision.severityCode,
          decision.syndromeCode,
          decision.phaseCode,
          decision.audience,
          decision.rulePackageStatus,
          decision.nextQuestionsJson,
          decision.matchedRuleIdsJson,
          decision.rulePackageVersion,
          decision.rulePackageHash,
          decision.planId,
          decision.planRevision,
          decision.createdAt
        );
    });
  }

  async listDecisions(sessionId: string): Promise<DecisionRow[]> {
    const rows = this.database.connection
      .prepare(
        `SELECT * FROM agent_decisions
         WHERE session_id = ? ORDER BY decision_sequence ASC`
      )
      .all(sessionId) as unknown as Array<{
      id: string;
      session_id: string;
      decision_sequence: number;
      session_revision: number;
      input_snapshot_encrypted: string;
      input_snapshot_hash: string;
      outcome: string;
      stage: string;
      severity_code: string | null;
      syndrome_code: string | null;
      phase_code: string | null;
      audience: string | null;
      rule_package_status: string | null;
      next_questions_json: string;
      matched_rule_ids_json: string;
      rule_package_version: string;
      rule_package_hash: string;
      plan_id: string | null;
      plan_revision: number | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      decisionSequence: row.decision_sequence,
      sessionRevision: row.session_revision,
      inputSnapshotEncrypted: parseEncrypted(row.input_snapshot_encrypted),
      inputSnapshotHash: row.input_snapshot_hash,
      outcome: row.outcome as DecisionRow["outcome"],
      stage: row.stage,
      severityCode: row.severity_code,
      syndromeCode: row.syndrome_code,
      phaseCode: (row.phase_code as "acute" | "remission" | null) ?? null,
      audience: (row.audience as "child" | "adult" | null) ?? null,
      rulePackageStatus:
        (row.rule_package_status as "candidate" | "approved" | null) ?? null,
      nextQuestionsJson: row.next_questions_json,
      matchedRuleIdsJson: row.matched_rule_ids_json,
      rulePackageVersion: row.rule_package_version,
      rulePackageHash: row.rule_package_hash,
      planId: row.plan_id,
      planRevision: row.plan_revision,
      createdAt: row.created_at
    }));
  }

  async addFeedback(feedback: FeedbackRow): Promise<void> {
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO agent_feedback(
            id, session_id, decision_id, rating,
            reason_encrypted, encryption_key_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          feedback.id,
          feedback.sessionId,
          feedback.decisionId,
          feedback.rating,
          serializeEncrypted(feedback.reasonEncrypted),
          feedback.reasonEncrypted?.keyVersion ?? "none",
          feedback.createdAt
        );
    });
  }

  async findFeedback(
    sessionId: string,
    id: string
  ): Promise<FeedbackRow | null> {
    const row = this.database.connection
      .prepare(
        `SELECT * FROM agent_feedback WHERE id = ? AND session_id = ?`
      )
      .get(id, sessionId) as unknown as
      | {
          id: string;
          session_id: string;
          decision_id: string | null;
          rating: string;
          reason_encrypted: string | null;
          encryption_key_version: string;
          created_at: string;
        }
      | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      decisionId: row.decision_id,
      rating: row.rating as FeedbackRow["rating"],
      reasonEncrypted:
        row.reason_encrypted === null
          ? null
          : parseEncrypted(row.reason_encrypted),
      createdAt: row.created_at
    };
  }
}
