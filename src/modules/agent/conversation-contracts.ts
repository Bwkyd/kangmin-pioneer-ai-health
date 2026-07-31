/**
 * 消息驱动 Agent 对话会话契约（数据库设计 §4.5 简化）。
 *
 * 说明：agent_sessions 表名已被 #131 确定性安全循环（结构化提问外壳）
 * 占用；本模块的消息驱动完整对话使用 agent_conversations 表（见
 * infrastructure/database.ts 0005 迁移）与 §4.5 的五个子表
 * （agent_messages/agent_confirmed_answers/agent_candidates/
 * agent_decisions/agent_feedback）。
 *
 * 临床红线：正式输出路径在规则包临床冻结（status=approved）前必须硬阻断；
 * draft（candidate）规则包只允许出现在 `agent test run` 模拟链路。
 */

import type {
  ClinicalVerdict,
  ConfirmedFact,
  NextQuestion
} from "../clinical-rules/contracts.js";

export type ConversationState = "active" | "completed" | "abandoned";

export interface ConversationSession {
  id: string;
  /** null 表示匿名一次性体验；绑定患者后为患者 ID。 */
  patientId: string | null;
  state: ConversationState;
  /** 患者确认保存会话的凭证 ID；未保存为 null。 */
  saveConsentId: string | null;
  rulePackageVersion: string;
  rulePackageHash: string;
  revision: number;
  lastSequence: number;
  closedAt: string | null;
  /** 匿名会话短保留；绑定会话保留至书面确认的期限（占位常量）。 */
  retentionUntil: string;
  createdAt: string;
  updatedAt: string;
}

export type MessageRole = "user" | "assistant" | "system_notice";

export interface EncryptedContent {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
}

export interface ConversationMessage {
  id: string;
  sessionId: string;
  sequence: number;
  role: MessageRole;
  /** assistant 消息必须绑定已完成的 decision；system_notice 为 null。 */
  decisionId: string | null;
  contentEncrypted: EncryptedContent;
  /** 已校验输出的 sha256（与决策绑定，防止事后篡改）。 */
  contentHash: string;
  createdAt: string;
}

export interface ConfirmedAnswerRow {
  sessionId: string;
  fieldCode: string;
  /** 序列化状态：missing|unknown|yes|no|value。 */
  value: string;
  /** 事实值（state 为 value 时）。 */
  factValue: string | null;
  source: string;
  rulePackageVersion: string;
  rulePackageHash: string;
  revision: number;
  confirmedAt: string;
}

export type CandidateState = "proposed" | "adopted" | "ignored" | "expired";

export interface CandidateRow {
  id: string;
  sessionId: string;
  fieldCode: string;
  /** 候选的 proposed 值（模型输出，未确认前绝不进入规则输入）。 */
  proposedValueEncrypted: EncryptedContent | null;
  encryptionKeyVersion: string;
  sourceMessageId: string | null;
  state: CandidateState;
  createdAt: string;
  decidedAt: string | null;
}

export type DecisionOutcome =
  | "blocked"
  | "need_more_information"
  | "non_applicable"
  | "conflict"
  | "no_match"
  | "classified";

export interface DecisionRow {
  id: string;
  sessionId: string;
  decisionSequence: number;
  sessionRevision: number;
  /** 规则输入快照（已确认事实）的认证加密与哈希。 */
  inputSnapshotEncrypted: EncryptedContent;
  inputSnapshotHash: string;
  outcome: DecisionOutcome;
  stage: string;
  severityCode: string | null;
  syndromeCode: string | null;
  nextQuestionsJson: string;
  matchedRuleIdsJson: string;
  rulePackageVersion: string;
  rulePackageHash: string;
  planId: string | null;
  planRevision: number | null;
  createdAt: string;
}

export interface FeedbackRow {
  id: string;
  sessionId: string;
  decisionId: string | null;
  rating: "helpful" | "unhelpful";
  reasonEncrypted: EncryptedContent | null;
  createdAt: string;
}

export interface ConversationTurnInput {
  /** null 表示匿名（一次性体验，不绑定）。 */
  patientId: string | null;
  /** 续接既有对话；缺省创建新对话。 */
  conversationId?: string | undefined;
  message: string;
  /** 匿名会话在登录后再次确认是否保存/绑定；true 才绑定，绝不自动绑定。 */
  saveConsent?: boolean | undefined;
}

export interface ProposedCandidateView {
  id: string;
  fieldCode: string;
  state: string;
  value?: string | number | undefined;
  justification: string | null;
}

export interface ConversationTurnResult {
  conversationId: string;
  state: ConversationState;
  /** 本轮的助手输出；绑定已完成 decision。 */
  message: {
    role: MessageRole;
    content: string;
    contentHash: string;
    decisionId: string | null;
  } | null;
  /** 代码生成的固定 system_notice（不绑定决策，如模型降级提示）。 */
  notices: Array<{ content: string; contentHash: string }>;
  verdict: {
    outcome: DecisionOutcome;
    stage: string;
    severityCode: string | null;
    syndromeCode: string | null;
    nextQuestions: NextQuestion[];
    matchedRuleIds: string[];
    rulePackageVersion: string;
    rulePackageHash: string;
    rulePackageStatus: string;
  } | null;
  proposedCandidates: ProposedCandidateView[];
  /** 匿名会话被已登录患者继续时：必须再次确认保存，不能自动绑定。 */
  saveConfirmationRequired: boolean;
  saved: boolean;
  closed: boolean;
}

export interface ConversationTestRunInput {
  answers: readonly ConfirmedFact[];
}

/** 决策元数据摘要（不含输入快照与聊天正文）。 */
export interface DecisionSummary {
  id: string;
  decisionSequence: number;
  outcome: DecisionOutcome;
  stage: string;
  severityCode: string | null;
  syndromeCode: string | null;
  matchedRuleIds: string[];
  rulePackageVersion: string;
  planId: string | null;
  createdAt: string;
}

export interface ConversationShowResult {
  session: ConversationSession;
  decisionCount: number;
  lastDecision: DecisionSummary | null;
}

export interface ConversationTestRunResult {
  verdict: ClinicalVerdict;
  planBlocked: boolean;
  explanation: {
    templateId: string;
    content: string;
    contentHash: string;
    simulated: true;
  };
  knowledge: { state: "not_available" };
}
