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
