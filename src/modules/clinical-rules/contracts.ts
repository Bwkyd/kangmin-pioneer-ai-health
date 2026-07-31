/**
 * Clinical Rule Kernel 端口（架构设计 §16、患者 CLI 设计 §6.3）。
 *
 * 规则内核是唯一允许产生临床裁决（安全阻断、适用范围、严重度、证型）
 * 的服务端组件。前端和模型不得复制或扩展临床分支；
 * `nextQuestions` 只能来自本内核，模型无权新增问题。
 *
 * 固定执行顺序（低优先级不能覆盖高优先级阻断）：
 *   安全 > 适用范围 > 严重度 > 证型 > 方案安全
 */

/**
 * 患者确认事实的三态模型。`unknown` 是正式状态，绝不等于 `no`；
 * `missing` 表示从未收集到该字段的任何信息。
 */
export type FactState = "missing" | "unknown" | "yes" | "no" | "value";

export interface ConfirmedFact {
  /** 字段编码，如 thirst / limbs_not_warm / pregnancy。 */
  fieldCode: string;
  state: FactState;
  /** state 为 value 时的值（如 fever_temp=39.5、age=8）。 */
  value?: string | number | undefined;
  /** 事实来源：patient_confirmation | record | model_candidate。 */
  source: string;
}

/** 内核执行阶段。classified 前必须依次通过 safety→applicability→severity→syndrome。 */
export type StageName =
  | "safety"
  | "applicability"
  | "severity"
  | "syndrome"
  | "plan_safety"
  | "completed";

export type VerdictOutcome =
  | "blocked"
  | "need_more_information"
  | "non_applicable"
  | "conflict"
  | "no_match"
  | "classified";

export type SeverityCode = "mild" | "moderate_severe";

export interface NextQuestion {
  fieldCode: string;
  /** 给患者的固定中文问题（来自规则包，模型不得改写）。 */
  prompt: string;
}

export interface ClinicalVerdict {
  outcome: VerdictOutcome;
  /** 流水线停在哪一阶段；classified 时为 completed。 */
  stage: StageName;
  severityCode: SeverityCode | null;
  syndromeCode: string | null;
  /** 本轮展示给患者的补问，单次不超过 2 个（客户资料：单次问诊提问≤2 个）。 */
  nextQuestions: NextQuestion[];
  /** 本轮全部待补问字段（未截断）。截断只影响本轮展示数量，不影响
   *  fail-closed 进展判定——进展判定必须基于全集（评审 P1 kimi P1-6）。 */
  allQuestions: NextQuestion[];
  /** 命中的规则 ID，如 ["SAF-02"]、["SEV-01","T3"]。 */
  matchedRuleIds: string[];
  /** 命中的固定阻断/转介文案（blocked/non_applicable 时有值）。 */
  message: string | null;
  /** 匹配到的已批准方案；无可用方案时为 null。 */
  planId: string | null;
  planRevision: number | null;
  rulePackageVersion: string;
  rulePackageHash: string;
}

/** 规则包临床冻结状态。approved 只能由开发发布流程产生，模型与后台不能设置。 */
export type RulePackageStatus = "candidate" | "approved";

/** 已批准方案查询端口：只返回批准且当前有效的方案，不返回草稿。 */
export interface ApprovedPlan {
  planId: string;
  planRevision: number;
  /** 方案方法属性（如 moxibustion/guasha_cupping），供方案安全规则评估。 */
  attributes: Record<string, string>;
}

export interface PlanRegistryPort {
  findApprovedPlan(input: {
    syndromeCode: string;
    severityCode: SeverityCode;
  }): ApprovedPlan | null;
}

export interface ClinicalRuleKernelPort {
  readonly rulePackageVersion: string;
  readonly rulePackageHash: string;
  readonly rulePackageStatus: RulePackageStatus;
  evaluate(facts: readonly ConfirmedFact[]): ClinicalVerdict;
}
