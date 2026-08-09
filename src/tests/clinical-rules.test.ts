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

function fact(fieldCode: string, state: ConfirmedFact["state"]): ConfirmedFact {
  return { fieldCode, state, source: "patient_confirmation" };
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
  return new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, planRegistry);
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
    fact("thirst", "yes"),
    fact("heat_imbalance", "no")
  ]);
}

test("规则包元数据：版本 clinical-rules-v1、approved 冻结状态与稳定哈希", () => {
  const kernel = kernelWith();
  assert.equal(kernel.rulePackageVersion, "clinical-rules-v1");
  assert.equal(kernel.rulePackageStatus, "approved");
  assert.match(kernel.rulePackageHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(DRAFT_RULE_PACKAGE.sourceRefs, [
    "vault/truth/clinical/assessment-rules.md",
    "vault/truth/clinical/care-plans.md"
  ]);
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
      fact("thirst", "yes"),
      fact("heat_imbalance", "no")
    ])
  );
  assert.equal(classified.outcome, "classified");
  assert.deepEqual(classified.allQuestions, []);
});

test("低优先级不能覆盖高优先级阻断：安全阻断优先于严重度/证型分类", async () => {
  const facts = factsWith(safeFacts(), [
    fact("sleep_affected", "yes"),
    fact("thirst", "yes"),
    fact("heat_imbalance", "no")
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

/** 证型 v3 判定矩阵（31 组合唯一命中 + 1 no_match 兜底，二轮评审穷举结论）。 */
const SYNDROME_FIELDS = ["thirst", "fatigue", "limbs_not_warm", "fear_wind", "heat_imbalance"] as const;
const SYNDROME_EXPECT: Record<string, string> = {
  no_match: "no_match",
  LUNG_HEAT: "LUNG_HEAT",
  SPLEEN_QI_DEF: "SPLEEN_QI_DEF",
  LUNG_QI_COLD: "LUNG_QI_COLD",
  KIDNEY_YANG_DEF: "KIDNEY_YANG_DEF",
  COLD_HEAT_COMPLEX: "COLD_HEAT_COMPLEX"
};

test("证型 v3：32 组合穷举——31 唯一命中 + 1 no_match（怕热单独）+ 0 conflict", async () => {
  const distribution = new Map<string, number>();
  let noMatch = 0;
  let conflict = 0;
  for (let bits = 0; bits < 32; bits++) {
    const comboFacts = SYNDROME_FIELDS.map((field, index) =>
      fact(field, (bits >> index) & 1 ? "yes" : "no")
    );
    const verdict = await kernelWith().evaluate(
      factsWith(safeFacts(), [...mildSeverityFacts(), ...comboFacts])
    );
    if (verdict.outcome === "conflict") {
      conflict += 1;
      continue;
    }
    if (verdict.outcome !== "classified") {
      assert.equal(verdict.outcome, "no_match", `bits=${bits} 应 no_match 而非其他`);
      noMatch += 1;
      continue;
    }
    const code = verdict.syndromeCode ?? "unknown";
    distribution.set(code, (distribution.get(code) ?? 0) + 1);
  }
  // 分布锚点（独立于实现的数值验证）：
  assert.equal(conflict, 0);
  assert.equal(noMatch, 1);
  assert.equal(distribution.get("LUNG_HEAT"), 10);
  assert.equal(distribution.get("SPLEEN_QI_DEF"), 5);
  assert.equal(distribution.get("LUNG_QI_COLD"), 2);
  assert.equal(distribution.get("KIDNEY_YANG_DEF"), 2);
  assert.equal(distribution.get("COLD_HEAT_COMPLEX"), 12);
  const total = [...distribution.values()].reduce((a, b) => a + b, 0);
  assert.equal(total + noMatch, 32);
});

test("证型：五型决策树关键组合逐一命中（v3 七规则）", async () => {
  const cases: Array<[ConfirmedFact[], string, string]> = [
    // T1a：口渴 + 无热象 → 肺经伏热
    [
      [fact("thirst", "yes"), fact("heat_imbalance", "no")],
      "LUNG_HEAT",
      "T1a"
    ],
    // T1b：口渴 + 怕热 + 无寒象（不怕风不四肢凉）→ 肺经伏热
    [
      [
        fact("thirst", "yes"),
        fact("heat_imbalance", "yes"),
        fact("fear_wind", "no"),
        fact("limbs_not_warm", "no")
      ],
      "LUNG_HEAT",
      "T1b"
    ],
    // T5：口渴 + 怕热 + 四肢不温（有寒象）→ 寒热错杂
    [
      [
        fact("thirst", "yes"),
        fact("heat_imbalance", "yes"),
        fact("limbs_not_warm", "yes")
      ],
      "COLD_HEAT_COMPLEX",
      "T5"
    ],
    // T2a：倦怠 + 不渴 + 无热象 → 脾气虚弱
    [
      [fact("fatigue", "yes"), fact("thirst", "no"), fact("heat_imbalance", "no")],
      "SPLEEN_QI_DEF",
      "T2a"
    ],
    // T2b：倦怠 + 不渴 + 怕热 + 无寒象 → 脾气虚弱
    [
      [
        fact("fatigue", "yes"),
        fact("thirst", "no"),
        fact("heat_imbalance", "yes"),
        fact("fear_wind", "no"),
        fact("limbs_not_warm", "no")
      ],
      "SPLEEN_QI_DEF",
      "T2b"
    ],
    // T3：无四肢不温 + 无倦怠 + 不渴 + 无热象 → 肺气虚寒（v4 不再依赖怕风）
    [
      [
        fact("limbs_not_warm", "no"),
        fact("fatigue", "no"),
        fact("thirst", "no"),
        fact("heat_imbalance", "no")
      ],
      "LUNG_QI_COLD",
      "T3"
    ],
    // T4：四肢不温 + 无倦怠 + 不渴 + 无热象 → 肾阳不足（v4 形寒肢冷仅信息收集）
    [
      [
        fact("limbs_not_warm", "yes"),
        fact("fatigue", "no"),
        fact("thirst", "no"),
        fact("heat_imbalance", "no")
      ],
      "KIDNEY_YANG_DEF",
      "T4"
    ]
  ];

  for (const [syndromeFacts, expectedCode, expectedRule] of cases) {
    const verdict = await kernelWith().evaluate(
      factsWith(safeFacts(), [...mildSeverityFacts(), ...syndromeFacts])
    );
    assert.equal(verdict.outcome, "classified", `${expectedRule} ${expectedCode}`);
    assert.equal(verdict.syndromeCode, expectedCode);
    assert.ok(verdict.matchedRuleIds.includes(expectedRule));
  }
});

test("证型 no_match 兜底：怕热单独（无寒象无口渴无疲倦）→ no_match 且带兜底文案", async () => {
  const verdict = await kernelWith().evaluate(
    factsWith(safeFacts(), [
      ...mildSeverityFacts(),
      fact("heat_imbalance", "yes"),
      fact("fear_wind", "no"),
      fact("limbs_not_warm", "no"),
      fact("thirst", "no"),
      fact("fatigue", "no")
    ])
  );
  assert.equal(verdict.outcome, "no_match");
  assert.equal(verdict.stage, "syndrome");
  assert.equal(verdict.syndromeCode, null);
  assert.deepEqual(verdict.matchedRuleIds, []);
  assert.ok(verdict.message !== null && verdict.message.includes("门诊"));
});

test("证型待定信息不足 → 补问且不越过证型阶段", async () => {
  const verdict = await kernelWith().evaluate(
    factsWith(safeFacts(), [
      ...mildSeverityFacts(),
      fact("thirst", "yes"),
      fact("heat_imbalance", "yes"),
      fact("limbs_not_warm", "unknown")
    ])
  );
  assert.equal(verdict.outcome, "need_more_information");
  assert.equal(verdict.stage, "syndrome");
  // 逐题一问下展示集可能为 fear_wind（T1b/T5 规则顺序在前）；未知字段在全集。
  assert.ok(verdict.allQuestions.some((q) => q.fieldCode === "limbs_not_warm"));
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
  assert.ok(verdict.matchedRuleIds.includes("T1a"));
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
  const verdict = await new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, registry).evaluate(
    lungHeatFacts()
  );
  assert.equal(verdict.outcome, "blocked");
  assert.equal(verdict.stage, "plan_safety");
  assert.ok(verdict.matchedRuleIds.includes("MSAF-01"));
  assert.ok(verdict.matchedRuleIds.includes("T1a"));
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
  const verdict = await new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, registry).evaluate(
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
  assert.ok(verdict.matchedRuleIds.includes("T1a"));
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
    const kernel = new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, registry);

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

    const verdict = await new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, registry).evaluate(
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

    const verdict = await new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, registry).evaluate(
      lungHeatFacts()
    );
    assert.equal(verdict.outcome, "classified");
    assert.equal(verdict.stage, "completed");
    assert.ok(!verdict.matchedRuleIds.includes("MSAF-01"));
  } finally {
    database.close();
  }
});
