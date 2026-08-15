/**
 * 对话持久化端口：agent_conversations + 五个 §4.5 子表。
 * 领域层只依赖本端口；会话正文与输入快照以密文+哈希形式存储，
 * 普通日志不包含任何明文正文。
 */

import type {
  CandidateRow,
  ConfirmedAnswerRow,
  ConversationMessage,
  ConversationSession,
  DecisionRow,
  FeedbackRow,
  PatientAssessmentRow
} from "./conversation-contracts.js";

export type UpdateSessionOutcome =
  | { kind: "updated"; session: ConversationSession }
  | { kind: "not_found" }
  | { kind: "version_conflict"; currentRevision: number };

/** 一轮对话的全部写入，单事务提交（评审 B P1-2：轮次原子化）。 */
export interface CommitTurnInput {
  sessionId: string;
  /** 期望会话版本（CAS 乐观锁）：不匹配时整轮拒绝，避免并发部分写入。 */
  expectedRevision: number;
  answers: ConfirmedAnswerRow[];
  candidates: CandidateRow[];
  decision: DecisionRow;
  messages: ConversationMessage[];
  /** 提交后的会话状态（revision=expected+1、lastSequence、state、closedAt）。 */
  next: ConversationSession;
  /** classified 问卷完成时与本轮消息、决策同事务写入。 */
  completedAssessment?: PatientAssessmentRow | undefined;
}

export type CommitTurnOutcome =
  | { kind: "committed" }
  | { kind: "version_conflict"; currentRevision: number };

export interface ConversationRepository {
  createSession(session: ConversationSession): Promise<void>;
  findSession(id: string): Promise<ConversationSession | null>;
  /**
   * 仅查找匿名（patient_id IS NULL）会话：登录患者绑定前置会话的唯一入口。
   * 过期匿名会话（retention_until <= now）视为不存在（issue-155：
   * 24h 保留期执行；过期不可续聊、不可认领绑定、不可反馈）。
   */
  findAnonymousSession(id: string): Promise<ConversationSession | null>;
  findPatientSession(patientId: string, id: string): Promise<ConversationSession | null>;
  listPatientSessions(patientId: string): Promise<ConversationSession[]>;
  findCurrentAssessment(patientId: string): Promise<PatientAssessmentRow | null>;
  findAssessment(patientId: string, id: string): Promise<PatientAssessmentRow | null>;
  /** 旧已完成问卷的幂等患者级提升；不改写聊天正文或规则事实。 */
  saveAssessment(assessment: PatientAssessmentRow): Promise<void>;
  /**
   * 清理过期匿名会话（issue-155）：单事务按序删除 5 张子表
   * （schema 无 ON DELETE CASCADE）再删主表，返回删除的主表行数。
   * 绑定会话（patient_id 非空）不受匿名清理影响。
   */
  deleteExpiredAnonymousSessions(now: string): Promise<number>;
  updateSession(
    expectedRevision: number,
    session: ConversationSession
  ): Promise<UpdateSessionOutcome>;
  /** 单事务提交一轮对话的全部写入（CAS 版本 + 答案/候选/决策/消息/会话状态）。 */
  commitTurn(input: CommitTurnInput): Promise<CommitTurnOutcome>;

  appendMessage(message: ConversationMessage): Promise<void>;
  /** 按消息序号读取完整对话流水；正文仍为密文，由应用服务解密并校验。 */
  listMessages(sessionId: string): Promise<ConversationMessage[]>;

  setConfirmedAnswer(answer: ConfirmedAnswerRow): Promise<void>;
  listConfirmedAnswers(sessionId: string): Promise<ConfirmedAnswerRow[]>;

  addCandidate(candidate: CandidateRow): Promise<void>;
  listCandidates(sessionId: string): Promise<CandidateRow[]>;
  markCandidateDecided(id: string, state: CandidateRow["state"]): Promise<void>;

  saveDecision(decision: DecisionRow): Promise<void>;
  listDecisions(sessionId: string): Promise<DecisionRow[]>;

  addFeedback(feedback: FeedbackRow): Promise<void>;
  findFeedback(sessionId: string, id: string): Promise<FeedbackRow | null>;
}
