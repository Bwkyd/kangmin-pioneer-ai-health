/**
 * Clinical Rule Kernel 实现。
 *
 * 生产 page_q1_q14 路径：Q1-Q11 → 六步证型树 → Q12-Q14 → 期别/方案。
 * 兼容旧规则包时仍使用固定执行顺序（智能体设计 v4）：
 *   安全 > 确诊门禁/人群派生 > 期别派生 > 适用范围 > 严重度 > 证型 > 方案安全；
 * 低优先级结果不能覆盖高优先级阻断。unknown/missing 一律不能
 * 让规则"通过"——要么补问，要么按裁决语义处理，绝不猜测。
 *
 * 例外仅一处（AI 决策 A4）：确诊题 diagnosed_confirmed 的 unknown 按
 * no→转介门诊（白名单特判，严禁通用 unknown→no 击穿 SAF-01）。
 */

import type {
  ApprovedPlan,
  ClinicalRuleKernelPort,
  ClinicalVerdict,
  ConfirmedFact,
  NextQuestion,
  PlanRegistryPort,
  SeverityCode
} from "./contracts.js";
import type { ClinicalRule, FactEntry, FactMap, RulePackage } from "./domain.js";
import { evaluateRules } from "./domain.js";
import {
  CONSTITUTION_QUESTION_IDS,
  PHASE_QUESTION_IDS,
  assessmentQuestion
} from "./assessment-questionnaire.js";
import { evaluateSyndromeDecisionTree } from "./syndrome-decision-tree.js";

/** 单次裁决的补问上限（智能体设计 v4：逐题一问，多选题保真）。 */
export const MAX_NEXT_QUESTIONS = 1;

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

  async evaluate(facts: readonly ConfirmedFact[]): Promise<ClinicalVerdict> {
    const source = new MapFactSource(facts);

    if (this.pack.questionnaireStrategy === "page_q1_q14") {
      return this.evaluatePageQuestionnaire(source);
    }

    const safety = this.evaluateSafety(source);
    if (safety !== null) {
      return safety;
    }

    // AI 决策 A4：确诊题白名单特判——unknown 按 no→转介门诊。
    // 必须在原始 facts 上判断：MapFactSource 会跳过 unknown，规则评估
    // 无法看到该状态（防止通用 unknown→no 击穿 SAF-01 等安全规则）。
    const diagnosedFact = facts.find(
      (fact) => fact.fieldCode === "diagnosed_confirmed"
    );
    if (diagnosedFact !== undefined && diagnosedFact.state === "unknown") {
      const gateRule = this.pack.rules.find((rule) => rule.id === "S-01");
      return this.verdict(
        source,
        "non_applicable",
        "screening",
        ["S-01"],
        gateRule?.message ?? null,
        null,
        null
      );
    }

    // screening：确诊门禁（转介）→ 人群派生（audience）。
    const screening = this.evaluateScreening(source);
    if (screening.verdict !== null) {
      return screening.verdict;
    }
    let current =
      screening.audience === null
        ? source
        : source.with([
            {
              fieldCode: "audience",
              state: "value",
              value: screening.audience,
              source: "derived"
            }
          ]);

    // phase：Q1 期别派生（acute/remission）。
    const phase = this.evaluatePhase(current);
    if (phase.verdict !== null) {
      return phase.verdict;
    }
    current =
      phase.phaseCode === null
        ? current
        : current.with([
            {
              fieldCode: "phase_code",
              state: "value",
              value: phase.phaseCode,
              source: "derived"
            }
          ]);

    const applicability = this.evaluateApplicability(current);
    if (applicability !== null) {
      return applicability;
    }

    const severity = this.evaluateSeverity(current);
    if (severity !== null) {
      if (severity.outcome !== "classified") {
        return severity;
      }
      const withSeverity = current.with([
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

        // 决策凭证需要跨阶段累积命中规则（如 ["SEV-05","SDT-01-A"]）。
        const allMatched = [...severity.matchedRuleIds, ...syndrome.matchedRuleIds];
        const plan = await this.evaluatePlanSafety(withSyndrome, allMatched);
        if (plan !== null) {
          return plan;
        }
      }
    }

    // 不可达的防御分支：不允许静默通过。
    return this.verdict(
      current,
      "no_match",
      "completed",
      [],
      null,
      null,
      null
    );
  }

  /**
   * 客户页面问卷流程：严格按《页面展示》Q1→Q14 逐题收集。
   * Q1-Q11 收齐后才执行《前置规则》六步证型树；树需要二次确认时
   * 继续使用独立 step5/step6 节点。证型完成后收集 Q12-Q14，最后
   * 按《前置规则》以 Q1 为硬指标派生急性/缓解期并组合方案。
   */
  private async evaluatePageQuestionnaire(source: MapFactSource): Promise<ClinicalVerdict> {
    for (const questionId of CONSTITUTION_QUESTION_IDS) {
      const pending = this.validatePageAnswer(source, questionId, "syndrome");
      if (pending !== null) {
        return pending;
      }
    }

    const treeSource = source.with([
      this.copyPageAnswer(source, "q10", "step1_q10"),
      this.copyPageAnswer(source, "q8", "step2_q8"),
      this.copyPageAnswer(source, "q6", "step3_q6"),
      this.copyPageAnswer(source, "q9", "step4_q9")
    ]);
    const tree = evaluateSyndromeDecisionTree(treeSource);
    if (tree.kind === "need_answer") {
      return this.needMoreVerdict(treeSource, "syndrome", [tree.question], "mild");
    }
    if (tree.kind === "invalid_answer") {
      return this.verdict(
        treeSource,
        "conflict",
        "syndrome",
        [],
        "证型问卷答案与当前节点不兼容，请重新开始评估。",
        null,
        null
      );
    }

    for (const questionId of PHASE_QUESTION_IDS) {
      const pending = this.validatePageAnswer(source, questionId, "phase");
      if (pending !== null) {
        return pending;
      }
    }

    const q1 = this.pageOption(source, "q1");
    // 《前置规则》：Q1 A/B 为急性期；Q1 C 且 Q2B/Q3B 为缓解期，
    // 其余组合仍“以 Q1 为准”，故 Q1C 的兜底同为缓解期。
    const phaseCode = q1 === "A" || q1 === "B" ? "acute" : "remission";
    const phaseRuleId = phaseCode === "acute" ? "P-Q1-ACUTE" : "P-Q1-REMISSION";
    const completedSource = treeSource.with([
      {
        fieldCode: "syndrome_code",
        state: "value",
        value: tree.leaf.syndromeCode,
        source: "derived"
      },
      {
        fieldCode: "phase_code",
        state: "value",
        value: phaseCode,
        source: "derived"
      },
      {
        // 客户页面资料未设置年龄题；当前公开试用页面沿用成人方案。
        fieldCode: "audience",
        state: "value",
        value: "adult",
        source: "derived"
      },
      {
        fieldCode: "severity_code",
        state: "value",
        value: "mild",
        source: "derived"
      }
    ]);

    const plan = await this.evaluatePlanSafety(
      completedSource,
      [phaseRuleId, tree.leaf.ruleId]
    );
    return plan ?? this.verdict(
      completedSource,
      "classified",
      "completed",
      [phaseRuleId, tree.leaf.ruleId],
      null,
      "mild",
      tree.leaf.syndromeCode
    );
  }

  private validatePageAnswer(
    source: MapFactSource,
    questionId: string,
    stage: "syndrome" | "phase"
  ): ClinicalVerdict | null {
    const question = assessmentQuestion(questionId);
    if (question === undefined) {
      return this.verdict(
        source,
        "conflict",
        stage,
        [],
        "评估问卷配置不完整，请重新开始评估。",
        null,
        null
      );
    }
    const entry = source.get(questionId);
    if (entry === null) {
      return this.needMoreVerdict(
        source,
        stage,
        [{ fieldCode: question.id, prompt: question.title }]
      );
    }
    const option = String(entry.value ?? "").toUpperCase();
    if (
      entry.state !== "value" ||
      !question.options.some((candidate) => candidate.code === option)
    ) {
      return this.verdict(
        source,
        "conflict",
        stage,
        [],
        "问卷选项与当前题目不兼容，请重新开始评估。",
        null,
        null
      );
    }
    return null;
  }

  private pageOption(source: MapFactSource, questionId: string): string {
    return String(source.get(questionId)?.value ?? "").toUpperCase();
  }

  private copyPageAnswer(
    source: MapFactSource,
    questionId: string,
    targetField: string
  ): ConfirmedFact {
    return {
      fieldCode: targetField,
      state: "value",
      value: this.pageOption(source, questionId),
      source: "derived"
    };
  }

  private evaluateSafety(source: MapFactSource): ClinicalVerdict | null {
    const report = evaluateRules(this.stageRules("safety"), source);
    if (report.matched.length > 0) {
      return this.verdict(
        source,
        "blocked",
        "safety",
        report.matched.map((rule) => rule.id),
        report.matched[0]?.message ?? null,
        null,
        null
      );
    }
    if (report.questions.length > 0) {
      return this.needMoreVerdict(source, "safety", report.questions);
    }
    return null;
  }

  /**
   * screening 阶段（v4）：S-01 确诊门禁（no/unknown→转介门诊，A4 白名单
   * 特判）+ S-02/S-03 人群派生（child/adult）。返回 verdict 与派生人群。
   */
  private evaluateScreening(source: MapFactSource): {
    verdict: ClinicalVerdict | null;
    audience: "child" | "adult" | null;
  } {
    const gate = evaluateRules(
      this.stageRules("screening").filter((rule) => rule.id === "S-01"),
      source
    );
    if (gate.matched.length > 0) {
      return {
        verdict: this.verdict(
          source,
          "non_applicable",
          "screening",
          gate.matched.map((rule) => rule.id),
          gate.matched[0]?.message ?? null,
          null,
          null
        ),
        audience: null
      };
    }
    if (gate.questions.length > 0) {
      return {
        verdict: this.needMoreVerdict(source, "screening", gate.questions),
        audience: null
      };
    }

    const crowdRules = this.stageRules("screening").filter(
      (rule) => rule.id !== "S-01"
    );
    if (crowdRules.length === 0) {
      // 最小/异常包无人群规则：不设 audience，直接通过（兼容旧测试包）。
      return { verdict: null, audience: null };
    }
    const crowd = evaluateRules(crowdRules, source);
    if (crowd.matched.length === 1) {
      return {
        verdict: null,
        audience: (crowd.matched[0]?.code as "child" | "adult" | undefined) ?? null
      };
    }
    if (crowd.matched.length > 1) {
      return {
        verdict: this.verdict(
          source,
          "conflict",
          "screening",
          crowd.matched.map((rule) => rule.id),
          null,
          null,
          null
        ),
        audience: null
      };
    }
    if (crowd.questions.length > 0) {
      return {
        verdict: this.needMoreVerdict(source, "screening", crowd.questions),
        audience: null
      };
    }
    // 防御：异常包无提问且无命中（理论上 S-02/S-03 必有一命中）。
    return {
      verdict: this.verdict(source, "no_match", "screening", [], null, null, null),
      audience: null
    };
  }

  /** phase 阶段（v4）：paroxysmal_sneezing → 期别派生（P-01/P-02）。 */
  private evaluatePhase(source: MapFactSource): {
    verdict: ClinicalVerdict | null;
    phaseCode: "acute" | "remission" | null;
  } {
    const phaseRules = this.stageRules("phase");
    if (phaseRules.length === 0) {
      // 最小/异常包无期别规则：不设 phaseCode，直接通过。
      return { verdict: null, phaseCode: null };
    }
    const report = evaluateRules(phaseRules, source);
    if (report.matched.length === 1) {
      return {
        verdict: null,
        phaseCode: (report.matched[0]?.code as "acute" | "remission" | undefined) ?? null
      };
    }
    if (report.matched.length > 1) {
      return {
        verdict: this.verdict(
          source,
          "conflict",
          "phase",
          report.matched.map((rule) => rule.id),
          null,
          null,
          null
        ),
        phaseCode: null
      };
    }
    if (report.questions.length > 0) {
      return {
        verdict: this.needMoreVerdict(source, "phase", report.questions),
        phaseCode: null
      };
    }
    // 防御：paroxysmal_sneezing 必为 yes/no，异常包兜底。
    return {
      verdict: this.verdict(source, "no_match", "phase", [], null, null, null),
      phaseCode: null
    };
  }

  private evaluateApplicability(source: MapFactSource): ClinicalVerdict | null {
    const report = evaluateRules(this.stageRules("applicability"), source);
    if (report.matched.length > 0) {
      return this.verdict(
        source,
        "non_applicable",
        "applicability",
        report.matched.map((rule) => rule.id),
        report.matched[0]?.message ?? null,
        null,
        null
      );
    }
    if (report.questions.length > 0) {
      return this.needMoreVerdict(source, "applicability", report.questions);
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
        source,
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
        source,
        "conflict",
        "severity",
        report.matched.map((rule) => rule.id),
        null,
        null,
        null
      );
    }
    if (report.questions.length > 0) {
      return this.needMoreVerdict(source, "severity", report.questions);
    }
    // 防御：SEV-05 覆盖全 no，理论上不可达；仍不猜测。
    return this.verdict(source, "no_match", "severity", [], null, null, null);
  }

  private evaluateSyndrome(
    source: MapFactSource,
    severityCode: SeverityCode | null
  ): ClinicalVerdict | null {
    if (this.pack.syndromeStrategy === "ordered_six_step") {
      const result = evaluateSyndromeDecisionTree(source);
      if (result.kind === "need_answer") {
        return this.needMoreVerdict(
          source,
          "syndrome",
          [result.question],
          severityCode
        );
      }
      if (result.kind === "invalid_answer") {
        return this.verdict(
          source,
          "conflict",
          "syndrome",
          [],
          "证型问卷答案与当前节点不兼容，请重新开始评估。",
          severityCode,
          null
        );
      }
      return this.verdict(
        source,
        "classified",
        "syndrome",
        [result.leaf.ruleId],
        result.leaf.message,
        severityCode,
        result.leaf.syndromeCode
      );
    }

    const report = evaluateRules(this.stageRules("syndrome"), source);
    const codes = [...new Set(report.matched.map((rule) => rule.code).filter(Boolean))];

    if (codes.length === 1) {
      const syndromeCode = codes[0] as string;
      const matched = report.matched.filter((rule) => rule.code === syndromeCode);
      return this.verdict(
        source,
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
        source,
        "conflict",
        "syndrome",
        report.matched.map((rule) => rule.id),
        null,
        severityCode,
        null
      );
    }
    if (report.questions.length > 0) {
      return this.needMoreVerdict(source, "syndrome", report.questions, severityCode);
    }
    // no_match 兜底（AI 决策 A2）：怕热单独（无寒象无口渴无疲倦）为罕见
    // 组合，客户树无判定归属。安全侧提示门诊；会话结束（评审并发 P1-1
    // 修正：no_match 必发生在字段闭环后，无新信息可收集，结束会话并
    // 渲染 message 兜底文案，见 conversation-service execTurn）。
    return this.verdict(
      source,
      "no_match",
      "syndrome",
      [],
      "您的情况较特殊，暂无法匹配现有体质类型。本工具不提供个性化方案，建议到正规医院耳鼻喉科门诊进一步评估。",
      severityCode,
      null
    );
  }

  /** 方案安全：仅在证型已分类后执行；双方案逐条独立评估，任一命中即阻断整包。 */
  private async evaluatePlanSafety(
    source: MapFactSource,
    matchedSoFar: readonly string[]
  ): Promise<ClinicalVerdict | null> {
    const syndrome = source.get("syndrome_code");
    const severity = source.get("severity_code");
    if (syndrome === null || severity === null) {
      return null;
    }
    const phaseCode = (source.get("phase_code")?.value as "acute" | "remission") ?? null;
    const audience = (source.get("audience")?.value as "child" | "adult") ?? null;
    if (phaseCode === null || audience === null) {
      // 防御：期别/人群必须先由 screening/phase 派生（正常流水线必达）。
      return null;
    }
    const severityCode = severity.value as SeverityCode;
    const syndromeCode = String(syndrome.value);

    const bundle = await this.planRegistry.findApprovedPlanBundle({
      syndromeCode,
      phaseCode,
      audience
    });
    const plans: ApprovedPlan[] = [
      bundle.acute,
      bundle.constitution
    ].filter((plan): plan is ApprovedPlan => plan !== null);

    if (plans.length === 0) {
      return this.verdict(
        source,
        "classified",
        "completed",
        [...matchedSoFar],
        null,
        severityCode,
        syndromeCode,
        null,
        null,
        null
      );
    }

    for (const plan of plans) {
      const planFacts: ConfirmedFact[] = Object.entries(plan.attributes).map(
        ([key, value]) => ({
          fieldCode: key,
          state: "value" as const,
          value,
          source: "approved_plan"
        })
      );
      const planSafetyRules =
        this.pack.questionnaireStrategy === "page_q1_q14"
          ? this.pack.planSafetyRules.filter((rule) => rule.nextQuestions.length === 0)
          : this.pack.planSafetyRules;
      const report = evaluateRules(planSafetyRules, source.with(planFacts));
      if (report.matched.length > 0) {
        return this.verdict(
          source,
          "blocked",
          "plan_safety",
          [...matchedSoFar, ...report.matched.map((rule) => rule.id)],
          report.matched[0]?.message ?? null,
          severityCode,
          syndromeCode,
          plan.planId,
          plan.planRevision,
          null
        );
      }
      if (report.questions.length > 0) {
        return this.needMoreVerdict(source, "plan_safety", report.questions, severityCode);
      }
    }

    // 全过：planBundle 供渲染；planId 落调体方案（AI 决策 A9 约定）。
    return this.verdict(
      source,
      "classified",
      "completed",
      [...matchedSoFar],
      null,
      severityCode,
      syndromeCode,
      bundle.constitution?.planId ?? null,
      bundle.constitution?.planRevision ?? null,
      bundle
    );
  }

  private stageRules(stage: "safety" | "screening" | "phase" | "applicability" | "severity" | "syndrome"): readonly ClinicalRule[] {
    return this.pack.rules.filter((rule) => rule.stage === stage);
  }

  private needMoreVerdict(
    source: MapFactSource,
    stage: "safety" | "screening" | "phase" | "applicability" | "severity" | "syndrome" | "plan_safety",
    questions: readonly NextQuestion[],
    severityCode: SeverityCode | null = null
  ): ClinicalVerdict {
    const { phaseCode, audience } = this.derived(source);
    return {
      outcome: "need_more_information",
      stage,
      severityCode,
      syndromeCode: null,
      phaseCode,
      audience,
      nextQuestions: questions.slice(0, MAX_NEXT_QUESTIONS),
      // 未截断的全集：供 fail-closed 进展判定使用（截断只影响展示，
      // 不影响判定，评审 P1 kimi P1-6）。
      allQuestions: [...questions],
      matchedRuleIds: [],
      message: null,
      planId: null,
      planRevision: null,
      planBundle: null,
      rulePackageVersion: this.rulePackageVersion,
      rulePackageHash: this.rulePackageHash
    };
  }

  private derived(source: MapFactSource): {
    phaseCode: "acute" | "remission" | null;
    audience: "child" | "adult" | null;
  } {
    return {
      phaseCode: (source.get("phase_code")?.value as "acute" | "remission") ?? null,
      audience: (source.get("audience")?.value as "child" | "adult") ?? null
    };
  }

  private verdict(
    source: MapFactSource,
    outcome: ClinicalVerdict["outcome"],
    stage: ClinicalVerdict["stage"],
    matchedRuleIds: string[],
    message: string | null,
    severityCode: SeverityCode | null,
    syndromeCode: string | null,
    planId: string | null = null,
    planRevision: number | null = null,
    planBundle: ClinicalVerdict["planBundle"] = null
  ): ClinicalVerdict {
    const { phaseCode, audience } = this.derived(source);
    return {
      outcome,
      stage,
      severityCode,
      syndromeCode,
      phaseCode,
      audience,
      nextQuestions: [],
      allQuestions: [],
      matchedRuleIds,
      message,
      planId,
      planRevision,
      planBundle,
      rulePackageVersion: this.rulePackageVersion,
      rulePackageHash: this.rulePackageHash
    };
  }
}
