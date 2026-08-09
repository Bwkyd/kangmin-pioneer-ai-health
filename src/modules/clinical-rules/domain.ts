/**
 * 规则模型与三态评估语义（临床规则领域）。
 *
 * 条件语义：
 * - 一个规则的 `conditions` 是 AND 关系；
 * - 简单条件 { fieldCode, state } 要求事实状态精确等于期望状态
 *   （unknown/missing 不算满足）；
 * - anyOf 条件组内任一分支满足即算满足；
 * - 条件字段为 unknown/missing 时，规则处于“待定”状态：若该规则
 *   有对应提问，则内核产生补问；绝不在信息不足时让规则“通过”。
 */

import type { NextQuestion, StageName, VerdictOutcome } from "./contracts.js";

export interface SimpleCondition {
  fieldCode: string;
  state: "yes" | "no" | "value";
  /** state 为 value 时的期望值。 */
  value?: string | number | undefined;
}

export interface AnyOfCondition {
  anyOf: SimpleCondition[];
}

/** 计数条件：fieldCodes 中 state=yes 的字段数 ≥ minYes 时满足。 */
export interface CountCondition {
  fieldCodes: string[];
  minYes: number;
}

export type RuleCondition =
  | SimpleCondition
  | AnyOfCondition
  | CountCondition;

export interface ClinicalRule {
  /** 稳定规则 ID，如 SAF-02、SEV-01、SDT-04-B。 */
  id: string;
  stage: StageName;
  /** 命中时的裁决结果。 */
  outcome: VerdictOutcome;
  /** severity_code 或 syndrome_code（outcome 为 classified 时）。 */
  code?: string | undefined;
  /** 命中的固定文案（阻断/转介/分类说明）；派生类规则可无文案。 */
  message: string | null;
  /** 条件字段不足时向患者补问的问题（单条规则最多 2 个）。 */
  nextQuestions: NextQuestion[];
  conditions: RuleCondition[];
  /** 反转语义：条件不满足（且无待定）时命中。用于“主症不足”等规则。 */
  inverted?: boolean | undefined;
}

export interface RulePackage {
  version: string;
  status: "candidate" | "approved";
  /** 临床来源引用（客户资料文件）。 */
  sourceRefs: string[];
  rules: readonly ClinicalRule[];
  planSafetyRules: readonly ClinicalRule[];
  /** 证型阶段使用客户确认的有序六步状态机；缺省时兼容通用规则评估。 */
  syndromeStrategy?: "ordered_six_step" | undefined;
  /** 规则包内容哈希（加载时计算，不可人工维护）。 */
  checksum: string;
}

/** 字段的短标签：供确定性结构化问答解析与界面展示（固定中文，不可修改）。 */
export const FIELD_LABELS: Record<string, string> = {
  urgent_help: "急救",
  high_fever: "高热",
  epistaxis_foul_discharge: "鼻出血",
  severe_neuro_symptoms: "剧烈头痛",
  skin_lesion: "皮肤破损",
  pregnancy: "怀孕",
  child_under_12: "未满12周岁",
  paroxysmal_sneezing: "阵发性喷嚏",
  watery_rhinorrhea: "清水样涕",
  nasal_itching: "鼻痒",
  nasal_congestion: "鼻塞",
  cold_like_symptoms: "感冒样表现",
  sinusitis_like_symptoms: "鼻窦炎样表现",
  sleep_affected: "影响睡眠",
  daily_activity_affected: "影响日常活动",
  work_study_affected: "影响工作学习",
  symptoms_intolerable: "难以忍受",
  thirst: "口渴",
  fatigue: "倦怠乏力",
  limbs_not_warm: "四肢不温",
  fear_wind: "怕风",
  cold_intolerance: "形寒肢冷",
  diagnosed_confirmed: "确诊过敏性鼻炎",
  heat_imbalance: "怕热",
  step1_q10: "第1步口干",
  step2_q8: "第2步疲倦",
  step3_q6: "第3步怕风怕冷",
  step4_q9: "第4步手脚冰凉",
  step5_q8_confirm: "第5步疲倦二次确认",
  step6_q10_confirm: "第6步口干二次确认"
};

/** 严重度代码的固定中文标签。 */
export const SEVERITY_LABELS: Record<string, string> = {
  mild: "轻度",
  moderate_severe: "中重度"
};

/** 证型代码的固定中文标签（简称，作者拍板 ⑦：展示名用简称）。 */
export const SYNDROME_LABELS: Record<string, string> = {
  LUNG_HEAT: "肺经伏热",
  LUNG_QI_COLD: "肺气虚寒",
  SPLEEN_QI_DEF: "脾气虚弱",
  KIDNEY_YANG_DEF: "肾阳不足",
  COLD_HEAT_COMPLEX: "寒热错杂"
};

export interface FactEntry {
  state: "yes" | "no" | "value";
  value?: string | number | undefined;
}

export interface FactMap {
  get(fieldCode: string): FactEntry | null;
}

export interface RuleMatchReport {
  matched: readonly ClinicalRule[];
  pending: readonly ClinicalRule[];
  questions: readonly NextQuestion[];
}

/**
 * 评估单条规则：返回 "matched" | "pending"（缺信息）| "unmatched"。
 * pending 只发生在条件字段 unknown/missing 且规则声明了对应提问；
 * 未声明提问的字段按“不满足”处理（规则包必须为全部条件字段声明提问）。
 *
 * 关键语义：一旦某个条件被已知事实确定性地违反，规则永远不可能命中
 * （即使其他字段仍未知），此时返回 unmatched 而不是 pending——
 * 避免把“确定不适用”误报为“需要补问”。
 */
export function evaluateRule(
  rule: ClinicalRule,
  facts: FactMap
): "matched" | "pending" | "unmatched" {
  const branchResult = (branch: SimpleCondition): "matched" | "pending" | "unmatched" => {
    const fact = facts.get(branch.fieldCode);
    if (fact === null) {
      if (rule.nextQuestions.some((q) => q.fieldCode === branch.fieldCode)) {
        return "pending";
      }
      return "unmatched";
    }
    if (fact.state !== branch.state) {
      return "unmatched";
    }
    if (branch.state === "value") {
      return String(fact.value) === String(branch.value) ? "matched" : "unmatched";
    }
    return "matched";
  };

  const conditionResult = (condition: RuleCondition): "matched" | "pending" | "unmatched" => {
    if ("anyOf" in condition) {
      let sawPending = false;
      for (const branch of condition.anyOf) {
        const result = branchResult(branch);
        if (result === "matched") {
          return "matched";
        }
        if (result === "pending") {
          sawPending = true;
        }
      }
      return sawPending ? "pending" : "unmatched";
    }
    if ("fieldCodes" in condition) {
      let yes = 0;
      let unknownCount = 0;
      for (const fieldCode of condition.fieldCodes) {
        const fact = facts.get(fieldCode);
        if (fact === null) {
          unknownCount += 1;
        } else if (fact.state === "yes") {
          yes += 1;
        }
      }
      const possibleMax = yes + unknownCount;
      if (yes >= condition.minYes) {
        return "matched";
      }
      if (possibleMax < condition.minYes) {
        return "unmatched";
      }
      // 信息不足时仍可能达成计数条件 → 待定（有提问才计入 pending）。
      const anyQuestion = condition.fieldCodes.some((fieldCode) =>
        rule.nextQuestions.some((q) => q.fieldCode === fieldCode)
      );
      return anyQuestion ? "pending" : "unmatched";
    }
    return branchResult(condition);
  };

  let allMatched = true;
  let sawPending = false;
  let decisiveFailure = false;

  for (const condition of rule.conditions) {
    const result = conditionResult(condition);
    if (result === "matched") {
      continue;
    }
    allMatched = false;
    if (result === "pending") {
      sawPending = true;
    } else {
      decisiveFailure = true;
      break;
    }
  }

  if (rule.inverted === true) {
    // 反转规则：底层条件确定不满足 → 命中；底层待定 → 待定。
    if (decisiveFailure) {
      return "matched";
    }
    if (sawPending) {
      return "pending";
    }
    return allMatched ? "unmatched" : "matched";
  }

  if (allMatched) {
    return "matched";
  }
  if (decisiveFailure) {
    return "unmatched";
  }
  return sawPending ? "pending" : "unmatched";
}

/**
 * 分组评估一组规则：
 * - matched：全部条件精确满足的规则；
 * - pending：条件有 unknown/missing 且带提问的规则（收集其问题）；
 * - questions 按规则顺序去重，供内核截断到 2 个。
 */
export function evaluateRules(
  rules: readonly ClinicalRule[],
  facts: FactMap
): RuleMatchReport {
  const matched: ClinicalRule[] = [];
  const pending: ClinicalRule[] = [];
  const questionMap = new Map<string, NextQuestion>();

  for (const rule of rules) {
    const result = evaluateRule(rule, facts);
    if (result === "matched") {
      matched.push(rule);
    } else if (result === "pending") {
      pending.push(rule);
      for (const question of rule.nextQuestions) {
        const fact = facts.get(question.fieldCode);
        if (fact === null) {
          questionMap.set(question.fieldCode, question);
        }
      }
    }
  }

  return {
    matched,
    pending,
    questions: [...questionMap.values()]
  };
}
