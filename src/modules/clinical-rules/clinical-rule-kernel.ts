/**
 * Clinical Rule Kernel 实现。
 *
 * 固定执行顺序：安全 > 适用范围 > 严重度 > 证型 > 方案安全；
 * 低优先级结果不能覆盖高优先级阻断。unknown/missing 一律不能
 * 让规则“通过”——要么补问，要么按裁决语义处理，绝不猜测。
 */

import type {
  ClinicalRuleKernelPort,
  ClinicalVerdict,
  ConfirmedFact,
  NextQuestion,
  PlanRegistryPort,
  SeverityCode
} from "./contracts.js";
import type { ClinicalRule, FactEntry, FactMap, RulePackage } from "./domain.js";
import { evaluateRules } from "./domain.js";

/** 单次裁决的补问上限（客户资料：单次问诊提问≤2 个）。 */
export const MAX_NEXT_QUESTIONS = 2;

class MapFactSource implements FactMap {
  private readonly map = new Map<string, FactEntry>();

  constructor(facts: readonly ConfirmedFact[]) {
    // 同一字段最后一次确认生效；missing/unknown 不进入条件评估
    // （unknown 由规则的补问机制处理，绝不等于 no）。
    for (const fact of facts) {
      if (fact.state === "missing" || fact.state === "unknown") {
        continue;
      }
      this.map.set(fact.fieldCode, { state: fact.state, value: fact.value });
    }
  }

  get(fieldCode: string): FactEntry | null {
    return this.map.get(fieldCode) ?? null;
  }

  with(facts: readonly ConfirmedFact[]): MapFactSource {
    return new MapFactSource([...this.facts(), ...facts]);
  }

  private facts(): ConfirmedFact[] {
    const result: ConfirmedFact[] = [];
    for (const [fieldCode, entry] of this.map) {
      result.push({
        fieldCode,
        state: entry.state,
        value: entry.value,
        source: "confirmed_answer"
      });
    }
    return result;
  }
}

export class ClinicalRuleKernel implements ClinicalRuleKernelPort {
  readonly rulePackageVersion: string;
  readonly rulePackageHash: string;
  readonly rulePackageStatus: "candidate" | "approved";

  constructor(
    private readonly pack: RulePackage,
    private readonly planRegistry: PlanRegistryPort
  ) {
    this.rulePackageVersion = pack.version;
    this.rulePackageHash = pack.checksum;
    this.rulePackageStatus = pack.status;
  }

  evaluate(facts: readonly ConfirmedFact[]): ClinicalVerdict {
    const source = new MapFactSource(facts);

    const safety = this.evaluateSafety(source);
    if (safety !== null) {
      return safety;
    }

    const applicability = this.evaluateApplicability(source);
    if (applicability !== null) {
      return applicability;
    }

    const severity = this.evaluateSeverity(source);
    if (severity !== null) {
      if (severity.outcome !== "classified") {
        return severity;
      }
      const withSeverity = source.with([
        {
          fieldCode: "severity_code",
          state: "value",
          value: severity.severityCode ?? "mild",
          source: "derived"
        }
      ]);

      const syndrome = this.evaluateSyndrome(withSeverity, severity.severityCode);
      if (syndrome !== null) {
        if (syndrome.outcome !== "classified") {
          // 终止于证型阶段时携带已确定的严重度（该阶段之后的字段仍为空）。
          return syndrome;
        }
        const withSyndrome = withSeverity.with([
          {
            fieldCode: "syndrome_code",
            state: "value",
            value: syndrome.syndromeCode ?? "",
            source: "derived"
          }
        ]);

        // 决策凭证需要跨阶段累积命中规则（如 ["SEV-05","T1"]）。
        const allMatched = [...severity.matchedRuleIds, ...syndrome.matchedRuleIds];
        const plan = this.evaluatePlanSafety(withSyndrome, allMatched);
        if (plan !== null) {
          return plan;
        }
      }
    }

    // 不可达的防御分支：不允许静默通过。
    return this.verdict("no_match", "completed", [], null, null, null);
  }

  private evaluateSafety(source: MapFactSource): ClinicalVerdict | null {
    const report = evaluateRules(this.stageRules("safety"), source);
    if (report.matched.length > 0) {
      return this.verdict(
        "blocked",
        "safety",
        report.matched.map((rule) => rule.id),
        report.matched[0]?.message ?? null,
        null,
        null
      );
    }
    if (report.questions.length > 0) {
      return this.needMoreVerdict("safety", report.questions);
    }
    return null;
  }

  private evaluateApplicability(source: MapFactSource): ClinicalVerdict | null {
    const report = evaluateRules(this.stageRules("applicability"), source);
    if (report.matched.length > 0) {
      return this.verdict(
        "non_applicable",
        "applicability",
        report.matched.map((rule) => rule.id),
        report.matched[0]?.message ?? null,
        null,
        null
      );
    }
    if (report.questions.length > 0) {
      return this.needMoreVerdict("applicability", report.questions);
    }
    return null;
  }

  private evaluateSeverity(source: MapFactSource): ClinicalVerdict | null {
    const report = evaluateRules(this.stageRules("severity"), source);
    const codes = [...new Set(report.matched.map((rule) => rule.code).filter(Boolean))];

    if (codes.length === 1) {
      const severityCode = codes[0] as SeverityCode;
      const matched = report.matched.filter((rule) => rule.code === severityCode);
      return this.verdict(
        "classified",
        "severity",
        matched.map((rule) => rule.id),
        matched[0]?.message ?? null,
        severityCode,
        null
      );
    }
    if (codes.length > 1) {
      // 多个不同严重度结论同时命中：不猜测。
      return this.verdict(
        "conflict",
        "severity",
        report.matched.map((rule) => rule.id),
        null,
        null,
        null
      );
    }
    if (report.questions.length > 0) {
      return this.needMoreVerdict("severity", report.questions);
    }
    // 防御：SEV-05 覆盖全 no，理论上不可达；仍不猜测。
    return this.verdict("no_match", "severity", [], null, null, null);
  }

  private evaluateSyndrome(
    source: MapFactSource,
    severityCode: SeverityCode | null
  ): ClinicalVerdict | null {
    const report = evaluateRules(this.stageRules("syndrome"), source);
    const codes = [...new Set(report.matched.map((rule) => rule.code).filter(Boolean))];

    if (codes.length === 1) {
      const syndromeCode = codes[0] as string;
      const matched = report.matched.filter((rule) => rule.code === syndromeCode);
      return this.verdict(
        "classified",
        "syndrome",
        matched.map((rule) => rule.id),
        matched[0]?.message ?? null,
        severityCode,
        syndromeCode
      );
    }
    if (codes.length > 1) {
      // 多个证型同时精确命中：冲突，绝不猜测。
      return this.verdict(
        "conflict",
        "syndrome",
        report.matched.map((rule) => rule.id),
        null,
        severityCode,
        null
      );
    }
    if (report.questions.length > 0) {
      return this.needMoreVerdict("syndrome", report.questions, severityCode);
    }
    return this.verdict("no_match", "syndrome", [], null, severityCode, null);
  }

  /** 方案安全：仅在证型已分类后执行；无已批准方案时直接完成（planId=null）。 */
  private evaluatePlanSafety(
    source: MapFactSource,
    matchedSoFar: readonly string[]
  ): ClinicalVerdict | null {
    const syndrome = source.get("syndrome_code");
    const severity = source.get("severity_code");
    if (syndrome === null || severity === null) {
      return null;
    }

    const plan = this.planRegistry.findApprovedPlan({
      syndromeCode: String(syndrome.value),
      severityCode: severity.value as SeverityCode
    });
    const severityCode = severity.value as SeverityCode;
    const syndromeCode = String(syndrome.value);

    if (plan === null) {
      return this.verdict(
        "classified",
        "completed",
        [...matchedSoFar],
        null,
        severityCode,
        syndromeCode,
        null,
        null
      );
    }

    const planFacts: ConfirmedFact[] = Object.entries(plan.attributes).map(
      ([key, value]) => ({
        fieldCode: key,
        state: "value" as const,
        value,
        source: "approved_plan"
      })
    );
    const report = evaluateRules(this.pack.planSafetyRules, source.with(planFacts));
    if (report.matched.length > 0) {
      return this.verdict(
        "blocked",
        "plan_safety",
        [...matchedSoFar, ...report.matched.map((rule) => rule.id)],
        report.matched[0]?.message ?? null,
        severityCode,
        syndromeCode,
        plan.planId,
        plan.planRevision
      );
    }
    if (report.questions.length > 0) {
      return this.needMoreVerdict("plan_safety", report.questions, severityCode);
    }
    return this.verdict(
      "classified",
      "completed",
      [...matchedSoFar],
      null,
      severityCode,
      syndromeCode,
      plan.planId,
      plan.planRevision
    );
  }

  private stageRules(stage: "safety" | "applicability" | "severity" | "syndrome"): readonly ClinicalRule[] {
    return this.pack.rules.filter((rule) => rule.stage === stage);
  }

  private needMoreVerdict(
    stage: "safety" | "applicability" | "severity" | "syndrome" | "plan_safety",
    questions: readonly NextQuestion[],
    severityCode: SeverityCode | null = null
  ): ClinicalVerdict {
    return {
      outcome: "need_more_information",
      stage,
      severityCode,
      syndromeCode: null,
      nextQuestions: questions.slice(0, MAX_NEXT_QUESTIONS),
      matchedRuleIds: [],
      message: null,
      planId: null,
      planRevision: null,
      rulePackageVersion: this.rulePackageVersion,
      rulePackageHash: this.rulePackageHash
    };
  }

  private verdict(
    outcome: ClinicalVerdict["outcome"],
    stage: ClinicalVerdict["stage"],
    matchedRuleIds: string[],
    message: string | null,
    severityCode: SeverityCode | null,
    syndromeCode: string | null,
    planId: string | null = null,
    planRevision: number | null = null
  ): ClinicalVerdict {
    return {
      outcome,
      stage,
      severityCode,
      syndromeCode,
      nextQuestions: [],
      matchedRuleIds,
      message,
      planId,
      planRevision,
      rulePackageVersion: this.rulePackageVersion,
      rulePackageHash: this.rulePackageHash
    };
  }
}
