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
  FeedbackRow
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
}

export type CommitTurnOutcome =
  | { kind: "committed" }
  | { kind: "version_conflict"; currentRevision: number };

export interface ConversationRepository {
  createSession(session: ConversationSession): Promise<void>;
  findSession(id: string): Promise<ConversationSession | null>;
  /** 仅查找匿名（patient_id IS NULL）会话：登录患者绑定前置会话的唯一入口。 */
  findAnonymousSession(id: string): Promise<ConversationSession | null>;
  findPatientSession(patientId: string, id: string): Promise<ConversationSession | null>;
  listPatientSessions(patientId: string): Promise<ConversationSession[]>;
  updateSession(
    expectedRevision: number,
    session: ConversationSession
  ): Promise<UpdateSessionOutcome>;
  /** 单事务提交一轮对话的全部写入（CAS 版本 + 答案/候选/决策/消息/会话状态）。 */
  commitTurn(input: CommitTurnInput): Promise<CommitTurnOutcome>;

  appendMessage(message: ConversationMessage): Promise<void>;

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
