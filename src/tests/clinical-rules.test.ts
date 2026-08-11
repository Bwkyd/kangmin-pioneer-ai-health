import assert from "node:assert/strict";

// 测试进程以本地开发模式启动：组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为
// PlaintextEncryption（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KangminDatabase } from "../infrastructure/database.js";
import { SqlitePlanRegistry } from "../infrastructure/sqlite-plan-registry.js";
import { ClinicalRuleKernel } from "../modules/clinical-rules/clinical-rule-kernel.js";
import type {
  ClinicalVerdict,
  ConfirmedFact,
  PlanBundle,
  PlanRegistryPort
} from "../modules/clinical-rules/contracts.js";
import type { ClinicalRule, RulePackage } from "../modules/clinical-rules/domain.js";
import { DRAFT_RULE_PACKAGE } from "../modules/clinical-rules/rule-package.js";
import { ASSESSMENT_QUESTIONS } from "../modules/clinical-rules/assessment-questionnaire.js";
import { enumerateSyndromeTreePaths } from "../modules/clinical-rules/syndrome-decision-tree.js";

function withoutQuestionnaireStrategy(rulePackage: RulePackage): RulePackage {
  const { questionnaireStrategy: _questionnaireStrategy, ...legacy } = rulePackage;
  return legacy;
}

/** 旧规则流水线只用于保留既有安全/筛查单元测试，不参与生产装配。 */
const LEGACY_PIPELINE_PACKAGE = withoutQuestionnaireStrategy(DRAFT_RULE_PACKAGE);

function fact(fieldCode: string, state: ConfirmedFact["state"]): ConfirmedFact {
  return { fieldCode, state, source: "patient_confirmation" };
}

function optionFact(fieldCode: string, value: "A" | "B" | "C"): ConfirmedFact {
  return { fieldCode, state: "value", value, source: "patient_confirmation" };
}

function pageFact(fieldCode: string, value: string): ConfirmedFact {
  return { fieldCode, state: "value", value, source: "patient_confirmation" };
}

function pageAnswers(values: Record<string, string>): ConfirmedFact[] {
  return Object.entries(values).map(([fieldCode, value]) => pageFact(fieldCode, value));
}

/** 让规则流水线能一路走到严重度/证型的"干净"事实（v4：含确诊/人群/期别）。 */
function safeFacts(): ConfirmedFact[] {
  return [
    fact("urgent_help", "no"),
    fact("high_fever", "no"),
    fact("epistaxis_foul_discharge", "no"),
    fact("severe_neuro_symptoms", "no"),
    fact("skin_lesion", "no"),
    fact("pregnancy", "no"),
    fact("diagnosed_confirmed", "yes"),
    fact("child_under_12", "no"),
    fact("paroxysmal_sneezing", "yes"),
    fact("cold_like_symptoms", "no"),
    fact("sinusitis_like_symptoms", "no")
  ];
}

const emptyRegistry: PlanRegistryPort = {
  findApprovedPlanBundle: async () => ({ acute: null, constitution: null })
};

function kernelWith(planRegistry: PlanRegistryPort = emptyRegistry): ClinicalRuleKernel {
  return new ClinicalRuleKernel(LEGACY_PIPELINE_PACKAGE, planRegistry);
}

function factsWith(base: ConfirmedFact[], extra: ConfirmedFact[]): ConfirmedFact[] {
  return [...base, ...extra];
}

/** 4 项生活质量影响全部"否"（轻度）。 */
function mildSeverityFacts(): ConfirmedFact[] {
  return [
    fact("sleep_affected", "no"),
    fact("daily_activity_affected", "no"),
    fact("work_study_affected", "no"),
    fact("symptoms_intolerable", "no")
  ];
}

/** 走到方案安全阶段的完整事实：安全通过 + 确诊 + 成人 + 急性 + 轻度 + 肺经伏热。 */
function lungHeatFacts(): ConfirmedFact[] {
  return factsWith(safeFacts(), [
    ...mildSeverityFacts(),
    optionFact("step1_q10", "A")
  ]);
}

test("生产规则包元数据：v3 页面问卷、六步树与稳定哈希", () => {
  const kernel = new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, emptyRegistry);
  assert.equal(kernel.rulePackageVersion, "clinical-rules-v3");
  assert.equal(kernel.rulePackageStatus, "approved");
  assert.match(kernel.rulePackageHash, /^[0-9a-f]{64}$/u);
  assert.equal(DRAFT_RULE_PACKAGE.questionnaireStrategy, "page_q1_q14");
  assert.deepEqual(DRAFT_RULE_PACKAGE.sourceRefs, [
    "vault/truth/clinical/syndrome-six-step-decision-tree.md",
    "vault/truth/clinical/assessment-rules.md",
    "vault/truth/product/assessment-page-content.md",
    "vault/truth/clinical/care-plans.md"
  ]);
});

test("生产页面严格按《页面展示》Q1-Q14 逐题推进，不插入旧筛查题", async () => {
  const kernel = new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, emptyRegistry);
  const answers: ConfirmedFact[] = [];

  assert.deepEqual(ASSESSMENT_QUESTIONS.map((question) => question.id), [
    "q1", "q2", "q3", "q4", "q5", "q6", "q7",
    "q8", "q9", "q10", "q11", "q12", "q13", "q14"
  ]);

  const defaults: Record<string, string> = {
    q1: "A", q2: "A", q3: "A", q4: "A", q5: "A", q6: "A", q7: "A",
    q8: "A", q9: "A", q10: "A", q11: "A", q12: "A", q13: "A", q14: "A"
  };
  for (const question of ASSESSMENT_QUESTIONS) {
    const verdict = await kernel.evaluate(answers);
    assert.equal(verdict.outcome, "need_more_information", question.id);
    assert.equal(verdict.nextQuestions[0]?.fieldCode, question.id, question.id);
    assert.equal(verdict.nextQuestions[0]?.prompt, question.title, question.id);
    answers.push(pageFact(question.id, defaults[question.id] ?? "A"));
  }

  const completed = await kernel.evaluate(answers);
  assert.equal(completed.outcome, "classified");
  assert.equal(completed.syndromeCode, "LUNG_HEAT");
  assert.equal(completed.phaseCode, "acute");
});

test("生产六步树：Q1-Q11 后才做独立二次确认，完成后继续 Q12-Q14", async () => {
  const kernel = new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, emptyRegistry);
  const base = pageAnswers({
    q1: "C", q2: "B", q3: "B", q4: "C", q5: "D", q6: "B",
    q7: "C", q8: "C", q9: "A", q10: "B", q11: "D"
  });

  const step5 = await kernel.evaluate(base);
  assert.equal(step5.nextQuestions[0]?.fieldCode, "step5_q8_confirm");

  const step6 = await kernel.evaluate([
    ...base,
    pageFact("step5_q8_confirm", "B")
  ]);
  assert.equal(step6.nextQuestions[0]?.fieldCode, "step6_q10_confirm");

  const phaseStart = await kernel.evaluate([
    ...base,
    pageFact("step5_q8_confirm", "B"),
    pageFact("step6_q10_confirm", "A")
  ]);
  assert.equal(phaseStart.nextQuestions[0]?.fieldCode, "q12");

  const completed = await kernel.evaluate([
    ...base,
    pageFact("step5_q8_confirm", "B"),
    pageFact("step6_q10_confirm", "A"),
    pageFact("q12", "C"),
    pageFact("q13", "B"),
    pageFact("q14", "B")
  ]);
  assert.equal(completed.outcome, "classified");
  assert.equal(completed.syndromeCode, "COLD_HEAT_COMPLEX");
  assert.equal(completed.phaseCode, "remission");
});

test("高危输入逐项阻断：高热/出血/皮损/孕期/急救/神经症状（SAF-07 已删）", async () => {
  const cases: Array<[string, string]> = [
    ["urgent_help", "SAF-01"],
    ["high_fever", "SAF-02"],
    ["epistaxis_foul_discharge", "SAF-03"],
    ["severe_neuro_symptoms", "SAF-04"],
    ["skin_lesion", "SAF-05"],
    ["pregnancy", "SAF-06"]
  ];
  for (const [fieldCode, ruleId] of cases) {
    const verdict = await kernelWith().evaluate([fact(fieldCode, "yes")]);
    assert.equal(verdict.outcome, "blocked", fieldCode);
    assert.equal(verdict.stage, "safety");
    assert.ok(verdict.matchedRuleIds.includes(ruleId), fieldCode);
    assert.ok(verdict.message !== null && verdict.message.length > 0);
  }
});

test("unknown 不等于 no：安全字段 unknown 时绝不通过安全阶段", async () => {
  const verdict = await kernelWith().evaluate([fact("high_fever", "unknown")]);
  assert.equal(verdict.outcome, "need_more_information");
  assert.equal(verdict.stage, "safety");
  // 逐题一问（MAX=1）截断展示集；unknown 字段必须在全集（fail-closed 依据）。
  assert.ok(verdict.allQuestions.some((q) => q.fieldCode === "high_fever"));
});

test("没有任何事实时：先补问安全字段，单次 1 个（逐题一问）", async () => {
  const verdict = await kernelWith().evaluate([]);
  assert.equal(verdict.outcome, "need_more_information");
  assert.equal(verdict.stage, "safety");
  assert.ok(verdict.nextQuestions.length > 0);
  assert.ok(verdict.nextQuestions.length <= 1);
});

/** 仅含安全字段确认（供 screening 用例绕过 safety 阶段）。 */
function screeningFacts(): ConfirmedFact[] {
  return [
    fact("urgent_help", "no"),
    fact("high_fever", "no"),
    fact("epistaxis_foul_discharge", "no"),
    fact("severe_neuro_symptoms", "no"),
    fact("skin_lesion", "no"),
    fact("pregnancy", "no")
  ];
}

test("screening：确诊 no → non_applicable 转介门诊", async () => {
  const verdict = await kernelWith().evaluate(
    factsWith(screeningFacts(), [fact("diagnosed_confirmed", "no")])
  );
  assert.equal(verdict.outcome, "non_applicable");
  assert.equal(verdict.stage, "screening");
  assert.ok(verdict.matchedRuleIds.includes("S-01"));
  assert.ok(verdict.message !== null && verdict.message.includes("确诊"));
});

test("screening：确诊 unknown 白名单特判为 no → 转介（A4）", async () => {
  const verdict = await kernelWith().evaluate(
    factsWith(screeningFacts(), [fact("diagnosed_confirmed", "unknown")])
  );
  assert.equal(verdict.outcome, "non_applicable");
  assert.equal(verdict.stage, "screening");
  assert.ok(verdict.matchedRuleIds.includes("S-01"));
});

test("screening：确诊 yes + 未答人群 → 补问人群", async () => {
  const verdict = await kernelWith().evaluate(
    factsWith(screeningFacts(), [fact("diagnosed_confirmed", "yes")])
  );
  assert.equal(verdict.outcome, "need_more_information");
  assert.equal(verdict.stage, "screening");
  assert.ok(verdict.nextQuestions.some((q) => q.fieldCode === "child_under_12"));
});

test("screening：儿童 yes → audience=child 继续流水线（SAF-07 已删）", async () => {
  const verdict = await kernelWith().evaluate(
    factsWith(safeFacts(), [fact("child_under_12", "yes")])
  );
  // 儿童不再被安全阻断；流水线继续到 phase/后续阶段。
  assert.notEqual(verdict.outcome, "blocked");
  assert.equal(verdict.stage, "severity");
  assert.equal(verdict.audience, "child");
});

test("phase：Q1 映射 paroxysmal_sneezing no → 缓解期；yes → 急性期", async () => {
  const remission = await kernelWith().evaluate(
    factsWith(safeFacts(), [fact("paroxysmal_sneezing", "no")])
  );
  assert.equal(remission.phaseCode, "remission");

  const acute = await kernelWith().evaluate(
    factsWith(safeFacts(), [fact("paroxysmal_sneezing", "yes")])
  );
  assert.equal(acute.phaseCode, "acute");
});

test("nextQuestions 截断展示但 allQuestions 保留全集（fail-closed 判定依据）", async () => {
  // 严重度阶段待答全集 4 问；展示截断为 1 问（逐题一问）。
  const verdict = await kernelWith().evaluate(safeFacts());
  assert.equal(verdict.outcome, "need_more_information");
  assert.equal(verdict.stage, "severity");
  assert.equal(verdict.nextQuestions.length, 1);
  assert.equal(verdict.allQuestions.length, 4);
  for (const question of verdict.nextQuestions) {
    assert.ok(verdict.allQuestions.includes(question));
  }
  assert.deepEqual(
    verdict.allQuestions.map((q) => q.fieldCode),
    ["sleep_affected", "daily_activity_affected", "work_study_affected", "symptoms_intolerable"]
  );
});

test("非补问裁决 allQuestions 为空", async () => {
  const blocked = await kernelWith().evaluate([fact("pregnancy", "yes")]);
  assert.equal(blocked.outcome, "blocked");
  assert.deepEqual(blocked.allQuestions, []);

  const classified = await kernelWith().evaluate(
    factsWith(safeFacts(), [
      ...mildSeverityFacts(),
      optionFact("step1_q10", "A")
    ])
  );
  assert.equal(classified.outcome, "classified");
  assert.deepEqual(classified.allQuestions, []);
});

test("低优先级不能覆盖高优先级阻断：安全阻断优先于严重度/证型分类", async () => {
  const facts = factsWith(safeFacts(), [
    fact("sleep_affected", "yes"),
    optionFact("step1_q10", "A")
  ]);
  const clean = await kernelWith().evaluate(facts);
  assert.equal(clean.outcome, "classified");

  const blocked = await kernelWith().evaluate(
    factsWith(facts, [fact("pregnancy", "yes")])
  );
  assert.equal(blocked.outcome, "blocked");
  assert.equal(blocked.stage, "safety");
  assert.ok(blocked.matchedRuleIds.includes("SAF-06"));
});

test("严重度信息缺失时绝不静默按轻度处理（unknown 不等于 no）", async () => {
  const verdict = await kernelWith().evaluate(safeFacts());
  assert.equal(verdict.outcome, "need_more_information");
  assert.equal(verdict.stage, "severity");
  assert.ok(verdict.nextQuestions.some((q) => q.fieldCode === "sleep_affected"));
});

test("严重度：4 问全否 → mild；任一为是 → moderate_severe；未知 → 补问", async () => {
  const allNo = await kernelWith().evaluate(
    factsWith(safeFacts(), mildSeverityFacts())
  );
  assert.equal(allNo.outcome, "need_more_information");
  assert.equal(allNo.stage, "syndrome");
  assert.equal(allNo.severityCode, "mild");

  const oneYes = await kernelWith().evaluate(
    factsWith(safeFacts(), [
      fact("sleep_affected", "yes"),
      fact("daily_activity_affected", "no"),
      fact("work_study_affected", "no"),
      fact("symptoms_intolerable", "no")
    ])
  );
  assert.equal(oneYes.stage, "syndrome");
  assert.equal(oneYes.severityCode, "moderate_severe");

  const unknown = await kernelWith().evaluate(
    factsWith(safeFacts(), [fact("sleep_affected", "unknown")])
  );
  assert.equal(unknown.outcome, "need_more_information");
  assert.equal(unknown.stage, "severity");
  assert.equal(unknown.severityCode, null);
});

test("证型六步树：111 条路径经完整临床内核得到客户指定叶子", async () => {
  const paths = enumerateSyndromeTreePaths();
  assert.equal(paths.length, 111);
  for (const [index, path] of paths.entries()) {
    const verdict = await kernelWith().evaluate(
      factsWith(safeFacts(), [
        ...mildSeverityFacts(),
        ...path.answers.map(({ nodeCode, option }) => optionFact(nodeCode, option))
      ])
    );
    assert.equal(verdict.outcome, "classified", `路径 ${index}`);
    assert.equal(verdict.stage, "completed", `路径 ${index}`);
    assert.equal(verdict.syndromeCode, path.leaf.syndromeCode, `路径 ${index}`);
    assert.ok(verdict.matchedRuleIds.includes(path.leaf.ruleId), `路径 ${index}`);
  }
});

test("冲突：多个不同证型同时精确命中 → conflict，绝不猜测", async () => {
  const overlapping: RulePackage = {
    version: "test-overlap-v0",
    status: "candidate",
    sourceRefs: [],
    rules: [
      {
        id: "TEST-SEV",
        stage: "severity",
        outcome: "classified",
        code: "moderate_severe",
        message: "sev",
        nextQuestions: [{ fieldCode: "sleep_affected", prompt: "影响睡眠？" }],
        conditions: [{ fieldCode: "sleep_affected", state: "yes" }]
      },
      {
        id: "TEST-A",
        stage: "syndrome",
        outcome: "classified",
        code: "ALPHA",
        message: "alpha",
        nextQuestions: [{ fieldCode: "thirst", prompt: "口渴？" }],
        conditions: [{ fieldCode: "thirst", state: "yes" }]
      },
      {
        id: "TEST-B",
        stage: "syndrome",
        outcome: "classified",
        code: "BETA",
        message: "beta",
        nextQuestions: [{ fieldCode: "thirst", prompt: "口渴？" }],
        conditions: [{ fieldCode: "thirst", state: "yes" }]
      }
    ],
    planSafetyRules: [],
    checksum: "test"
  };
  const kernel = new ClinicalRuleKernel(overlapping, emptyRegistry);
  const verdict = await kernel.evaluate(
    factsWith(safeFacts(), [
      fact("sleep_affected", "yes"),
      fact("thirst", "yes"),
      fact("limbs_not_warm", "yes")
    ])
  );
  assert.equal(verdict.outcome, "conflict");
  assert.equal(verdict.stage, "syndrome");
  assert.equal(verdict.syndromeCode, null);
  assert.deepEqual([...verdict.matchedRuleIds].sort(), ["TEST-A", "TEST-B"]);
});

test("适用范围：感冒样/鼻窦炎样表现 → non_applicable（APP-01 已删）", async () => {
  for (const fieldCode of ["cold_like_symptoms", "sinusitis_like_symptoms"]) {
    const verdict = await kernelWith().evaluate(
      factsWith(safeFacts(), [fact(fieldCode, "yes")])
    );
    assert.equal(verdict.outcome, "non_applicable", fieldCode);
    assert.equal(verdict.stage, "applicability");
  }
});

test("完整分类：轻度 + 肺经伏热，无已批准方案时 planBundle=null 且 phaseCode=acute", async () => {
  const verdict = await kernelWith().evaluate(lungHeatFacts());
  assert.equal(verdict.outcome, "classified");
  assert.equal(verdict.stage, "completed");
  assert.equal(verdict.severityCode, "mild");
  assert.equal(verdict.syndromeCode, "LUNG_HEAT");
  assert.equal(verdict.phaseCode, "acute");
  assert.equal(verdict.audience, "adult");
  assert.equal(verdict.planId, null);
  assert.equal(verdict.planBundle, null);
  assert.ok(verdict.matchedRuleIds.includes("SEV-05"));
  assert.ok(verdict.matchedRuleIds.includes("SDT-01-A"));
});

/** 双方案 mock：急期含灸（触发 MSAF-01）+ 调体无灸。 */
function bundleRegistry(bundle: PlanBundle): PlanRegistryPort {
  return { findApprovedPlanBundle: async () => bundle };
}

test("方案安全：急性方案含灸法 → 整包阻断（MSAF-01，逐条独立评估）", async () => {
  const registry = bundleRegistry({
    acute: {
      planId: "plan-acute",
      planRevision: 1,
      name: "急性期方案",
      method: "温和艾灸与日常护理",
      steps: "[]",
      precautions: "",
      videoResourceId: null,
      attributes: { moxibustion: "yes" }
    },
    constitution: {
      planId: "plan-tune",
      planRevision: 2,
      name: "调体方案",
      method: "日常护理",
      steps: "[]",
      precautions: "",
      videoResourceId: null,
      attributes: {}
    }
  });
  const verdict = await new ClinicalRuleKernel(LEGACY_PIPELINE_PACKAGE, registry).evaluate(
    lungHeatFacts()
  );
  assert.equal(verdict.outcome, "blocked");
  assert.equal(verdict.stage, "plan_safety");
  assert.ok(verdict.matchedRuleIds.includes("MSAF-01"));
  assert.ok(verdict.matchedRuleIds.includes("SDT-01-A"));
});

test("方案安全通过：双方案无禁忌 → classified 且绑定双方案（planId 落调体）", async () => {
  const registry = bundleRegistry({
    acute: {
      planId: "plan-acute",
      planRevision: 1,
      name: "急性期方案",
      method: "点揉鼻通穴",
      steps: "[]",
      precautions: "点揉，不灸",
      videoResourceId: null,
      attributes: {}
    },
    constitution: {
      planId: "plan-tune",
      planRevision: 2,
      name: "调体方案",
      method: "日常护理",
      steps: "[]",
      precautions: "",
      videoResourceId: null,
      attributes: {}
    }
  });
  const verdict = await new ClinicalRuleKernel(LEGACY_PIPELINE_PACKAGE, registry).evaluate(
    lungHeatFacts()
  );
  assert.equal(verdict.outcome, "classified");
  assert.equal(verdict.stage, "completed");
  // AI 决策 A9：plan_id 落调体方案。
  assert.equal(verdict.planId, "plan-tune");
  assert.equal(verdict.planRevision, 2);
  assert.equal(verdict.planBundle?.acute?.planId, "plan-acute");
  assert.equal(verdict.planBundle?.constitution?.planId, "plan-tune");
  assert.ok(verdict.matchedRuleIds.includes("SEV-05"));
  assert.ok(verdict.matchedRuleIds.includes("SDT-01-A"));
});

test("同一字段多次确认：最后一次生效（快照语义）", async () => {
  const verdict = await kernelWith().evaluate([
    fact("high_fever", "no"),
    fact("high_fever", "yes")
  ]);
  assert.equal(verdict.outcome, "blocked");
  assert.ok(verdict.matchedRuleIds.includes("SAF-02"));
});

test("规则包内容哈希稳定：同一包两次评估返回同一哈希", async () => {
  const kernel = kernelWith();
  const first = await kernel.evaluate([]);
  const second = await kernel.evaluate([fact("thirst", "yes")]);
  assert.equal(first.rulePackageHash, second.rulePackageHash);
  assert.equal(first.rulePackageHash, kernel.rulePackageHash);
});

/** 生产注册表集成（评审 codex P0-1）：自由文本 method 确定性映射 +
 *  期别×人群双方案查询。 */
function insertPlan(
  database: KangminDatabase,
  row: {
    id: string;
    syndrome: string;
    method: string;
    phaseCode?: string | null;
    audience?: string | null;
    status?: "draft" | "enabled" | "disabled";
  }
): void {
  const now = "2026-08-01T00:00:00Z";
  database.connection
    .prepare(`
      INSERT INTO agent_plans(
        id, name, syndrome, method, steps_json, precautions, risks,
        contraindications, phase_code, audience, display_order, status, revision,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, '[]', '', '', '', ?, ?, 0, ?, 1, ?, ?)
    `)
    .run(
      row.id,
      `${row.id} 方案`,
      row.syndrome,
      row.method,
      row.phaseCode ?? null,
      row.audience ?? null,
      row.status ?? "enabled",
      now,
      now
    );
}

test("生产注册表：急性+成人双方案按期别×人群命中（codex P0-1 回归）", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-registry-"));
  const database = new KangminDatabase(join(directory, "registry.sqlite"));
  try {
    insertPlan(database, { id: "plan-acute", syndrome: "ACUTE", method: "点揉迎香穴", phaseCode: "acute", audience: "adult" });
    insertPlan(database, { id: "plan-tune", syndrome: "LUNG_HEAT", method: "日常护理", phaseCode: null, audience: "adult" });
    // 儿童版本：同一证型两条并存，必须精确取 audience 匹配的那条。
    insertPlan(database, { id: "plan-tune-child", syndrome: "LUNG_HEAT", method: "小儿推拿", phaseCode: null, audience: "child" });

    const registry = new SqlitePlanRegistry(database);
    const adult = await registry.findApprovedPlanBundle({
      syndromeCode: "LUNG_HEAT",
      phaseCode: "acute",
      audience: "adult"
    });
    assert.equal(adult.acute?.planId, "plan-acute");
    assert.equal(adult.constitution?.planId, "plan-tune");

    // 儿童路径不得取到成人方案（评审 codex P0-1 复现场景）。
    const child = await registry.findApprovedPlanBundle({
      syndromeCode: "LUNG_HEAT",
      phaseCode: "remission",
      audience: "child"
    });
    assert.equal(child.acute, null);
    assert.equal(child.constitution?.planId, "plan-tune-child");
  } finally {
    database.close();
  }
});

test("生产注册表：含灸法的启用方案触发 MSAF-01 阻断（自由文本 method 映射）", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-registry-"));
  const database = new KangminDatabase(join(directory, "registry.sqlite"));
  try {
    insertPlan(database, { id: "plan-moxa", syndrome: "ACUTE", method: "温和艾灸与日常护理", phaseCode: "acute", audience: "adult" });
    insertPlan(database, { id: "plan-tune", syndrome: "LUNG_HEAT", method: "日常护理", phaseCode: null, audience: "adult" });
    const registry = new SqlitePlanRegistry(database);
    const kernel = new ClinicalRuleKernel(LEGACY_PIPELINE_PACKAGE, registry);

    const bundle = await registry.findApprovedPlanBundle({
      syndromeCode: "LUNG_HEAT",
      phaseCode: "acute",
      audience: "adult"
    });
    assert.equal(bundle.acute?.attributes.moxibustion, "yes");
    assert.equal(bundle.acute?.attributes.guasha_cupping, undefined);

    const verdict = await kernel.evaluate(lungHeatFacts());
    assert.equal(verdict.outcome, "blocked");
    assert.equal(verdict.stage, "plan_safety");
    assert.ok(verdict.matchedRuleIds.includes("MSAF-01"));
  } finally {
    database.close();
  }
});

test("生产注册表：'点揉，不灸'不得误判 moxibustion（评审 P0-2 回归）", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-registry-"));
  const database = new KangminDatabase(join(directory, "registry.sqlite"));
  try {
    insertPlan(database, { id: "plan-bumoxa", syndrome: "ACUTE", method: "点揉鼻通穴，不灸", phaseCode: "acute", audience: "adult" });
    insertPlan(database, { id: "plan-tune", syndrome: "LUNG_HEAT", method: "日常护理", phaseCode: null, audience: "adult" });
    const registry = new SqlitePlanRegistry(database);
    const bundle = await registry.findApprovedPlanBundle({
      syndromeCode: "LUNG_HEAT",
      phaseCode: "acute",
      audience: "adult"
    });
    assert.deepEqual(bundle.acute?.attributes, {}, "含'不灸'不得输出 moxibustion");

    const verdict = await new ClinicalRuleKernel(LEGACY_PIPELINE_PACKAGE, registry).evaluate(
      lungHeatFacts()
    );
    assert.equal(verdict.outcome, "classified");
    assert.ok(!verdict.matchedRuleIds.includes("MSAF-01"));
  } finally {
    database.close();
  }
});

test("生产注册表：method 为空或无法映射时不出属性键（unmatched 安全语义）", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-registry-"));
  const database = new KangminDatabase(join(directory, "registry.sqlite"));
  try {
    insertPlan(database, { id: "plan-empty", syndrome: "ACUTE", method: "", phaseCode: "acute", audience: "adult" });
    insertPlan(database, { id: "plan-tune", syndrome: "LUNG_HEAT", method: "日常护理", phaseCode: null, audience: "adult" });
    const registry = new SqlitePlanRegistry(database);
    const bundle = await registry.findApprovedPlanBundle({
      syndromeCode: "LUNG_HEAT",
      phaseCode: "acute",
      audience: "adult"
    });
    assert.deepEqual(bundle.acute?.attributes, {}, "空 method 不应输出属性键");

    const verdict = await new ClinicalRuleKernel(LEGACY_PIPELINE_PACKAGE, registry).evaluate(
      lungHeatFacts()
    );
    assert.equal(verdict.outcome, "classified");
    assert.equal(verdict.stage, "completed");
    assert.ok(!verdict.matchedRuleIds.includes("MSAF-01"));
  } finally {
    database.close();
  }
});
