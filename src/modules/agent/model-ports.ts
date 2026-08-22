/**
 * 模型端口（架构 §19 ModelExtractionPort / ModelExplanationPort）。
 *
 * 模型职责边界（患者 CLI 设计 §6.4）：
 * - 只能从自然语言提取待确认候选；
 * - 只能把规则结果解释成结构化字段（由固定模板渲染，禁止自由文本）；
 * - 不能决定证型/严重度、不能把 unknown 当 no、不能新增穴位/疗程/
 *   力度/剂量/禁忌/疗效、不能读取草稿知识、不能写任何患者事实。
 *
 * 降级：未配置 / 超时 / 非法 JSON 时返回空候选或 null，
 * 固定规则结果仍然有效，结构化问答继续，绝不伪造模型回答。
 */

import type {
  ConfirmedFact,
  ClinicalVerdict,
  NextQuestion,
  RulePackageStatus
} from "../clinical-rules/contracts.js";
export type { KnowledgeAnswerPort } from "./knowledge-ports.js";

export interface ExtractionCandidate {
  fieldCode: string;
  state: "yes" | "no" | "unknown" | "value";
  value?: string | number | undefined;
  /** 模型给出的依据描述（不得进入规则输入）。 */
  justification?: string | undefined;
}

export interface ModelExtractionInput {
  message: string;
  /** 服务端规则要求的补问（模型只能从中提取，不能新增临床分支）。 */
  askedQuestions: readonly NextQuestion[];
  confirmedFacts: readonly ConfirmedFact[];
}

export interface ModelExtractionPort {
  /**
   * 提取待确认候选。失败（未配置/超时/非法 JSON）返回空数组，
   * 调用方降级为结构化问答；绝不宽松解析。
   */
  extractCandidates(input: ModelExtractionInput): Promise<ExtractionCandidate[]>;
}

/**
 * 模型解释的结构化输出：只允许从规则结果中搬运字段，
 * 由固定模板渲染成最终正文；任何新增字段都会被输出校验拒绝。
 */
export interface ExplanationFields {
  outcome: string;
  severityCode: string | null;
  syndromeCode: string | null;
  matchedRuleIds: string[];
  message: string | null;
}

export interface ModelExplanationPort {
  /**
   * 把规则结果解释为结构化字段。失败或不可用时返回 null，
   * 调用方使用固定模板（规则结果仍然有效）。
   */
  explain(
    verdict: ClinicalVerdict,
    packageStatus: RulePackageStatus
  ): Promise<ExplanationFields | null>;
}

export interface PlanDialogueSource {
  knowledgeId: string;
  name: string;
  source: string | null;
  text: string;
}

export interface PlanDialogueContext {
  assessment: {
    completedAt: string;
    answers: readonly ConfirmedFact[];
  };
  recentMessages: ReadonlyArray<{
    role: "user" | "assistant";
    content: string;
  }>;
}

/**
 * 规则判定后的患者对话端口。
 *
 * 输入中的证型、期别、方案和资料都由服务端准备；模型只能转译和答疑，
 * 无权改变裁决或补充方案。输出仍须经过服务端医学校验后才能展示。
 */
export interface PlanDialoguePort {
  generatePlan(verdict: ClinicalVerdict): Promise<string | null>;
  answerFollowUp(input: {
    question: string;
    verdict: ClinicalVerdict;
    sources: readonly PlanDialogueSource[];
    context: PlanDialogueContext;
  }): Promise<string | null>;
}
