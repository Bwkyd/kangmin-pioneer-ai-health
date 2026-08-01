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
 * 模拟测试链路（`agent test run`）属于管理端（kangmin-admin），患者侧调用
 * 返回 capability_unavailable——患者 CLI 设计 §6 没有 test run 命令，患者
 * 一步拿到完整 ClinicalVerdict 可枚举决策表（评审 R2 P0）。
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
  /**
   * 候选状态（proposed/adopted/ignored/expired）。
   * 模型原始 value/justification 绝不透传给患者（评审 P1 codex #9）：
   * 候选以密文完整存库，患者确认流程凭 fieldCode 进行。
   */
  state: string;
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
    /** candidate 规则包下裁剪为 null（评审 R2：stage 侧信道，见 patientVerdict）。 */
    stage: string | null;
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

/**
 * 模拟链路输入（保留以支撑 dispatcher 类型边界）：患者侧调用一律返回
 * capability_unavailable（评审 R2 P0，模拟链路属于管理端 kangmin-admin）。
 */
export interface ConversationTestRunInput {
  answers: readonly ConfirmedFact[];
}

/** 决策元数据摘要（不含输入快照与聊天正文）。 */
export interface DecisionSummary {
  id: string;
  decisionSequence: number;
  outcome: DecisionOutcome;
  /** candidate 规则包下裁剪为 null（评审 R2：stage 侧信道，见 summarizeDecision）。 */
  stage: string | null;
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

/** 结果类型保留仅为 dispatcher 类型边界；患者侧永不返回（capability_unavailable）。 */
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
