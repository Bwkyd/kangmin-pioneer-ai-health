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
  PlanRegistryPort
} from "../modules/clinical-rules/contracts.js";
import type { ClinicalRule, RulePackage } from "../modules/clinical-rules/domain.js";
import { DRAFT_RULE_PACKAGE } from "../modules/clinical-rules/rule-package.js";

function fact(fieldCode: string, state: ConfirmedFact["state"]): ConfirmedFact {
  return { fieldCode, state, source: "patient_confirmation" };
}

/** 让规则流水线能一路走到严重度/证型的“干净”安全与适用范围事实。 */
function safeFacts(): ConfirmedFact[] {
  return [
    fact("urgent_help", "no"),
    fact("high_fever", "no"),
    fact("epistaxis_foul_discharge", "no"),
    fact("severe_neuro_symptoms", "no"),
    fact("skin_lesion", "no"),
    fact("pregnancy", "no"),
    fact("child_under_12", "no"),
    fact("paroxysmal_sneezing", "yes"),
    fact("watery_rhinorrhea", "yes"),
    fact("nasal_itching", "yes"),
    fact("nasal_congestion", "yes"),
    fact("cold_like_symptoms", "no"),
    fact("sinusitis_like_symptoms", "no")
  ];
}

function kernelWith(planRegistry: PlanRegistryPort = { findApprovedPlan: async () => null }): ClinicalRuleKernel {
  return new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, planRegistry);
}

function factsWith(base: ConfirmedFact[], extra: ConfirmedFact[]): ConfirmedFact[] {
  return [...base, ...extra];
}

/** 4 项生活质量影响全部“否”（轻度）。 */
function mildSeverityFacts(): ConfirmedFact[] {
  return [
    fact("sleep_affected", "no"),
    fact("daily_activity_affected", "no"),
    fact("work_study_affected", "no"),
    fact("symptoms_intolerable", "no")
  ];
}

test("规则包元数据：版本、candidate 状态与稳定哈希", () => {
  const kernel = kernelWith();
  assert.equal(kernel.rulePackageVersion, "clinical-rules-draft-v0");
  assert.equal(kernel.rulePackageStatus, "candidate");
  assert.match(kernel.rulePackageHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(DRAFT_RULE_PACKAGE.sourceRefs, [
    "vault/truth/clinical/assessment-rules.md",
    "vault/truth/clinical/care-plans.md"
  ]);
});

test("高危输入逐项阻断：高热/出血/皮损/孕期/儿童/急救/神经症状", async () => {
  const cases: Array<[string, string]> = [
    ["urgent_help", "SAF-01"],
    ["high_fever", "SAF-02"],
    ["epistaxis_foul_discharge", "SAF-03"],
    ["severe_neuro_symptoms", "SAF-04"],
    ["skin_lesion", "SAF-05"],
    ["pregnancy", "SAF-06"],
    ["child_under_12", "SAF-07"]
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
  assert.ok(verdict.nextQuestions.some((q) => q.fieldCode === "high_fever"));
});

test("没有任何事实时：先补问安全字段，单次不超过 2 个", async () => {
  const verdict = await kernelWith().evaluate([]);
  assert.equal(verdict.outcome, "need_more_information");
  assert.equal(verdict.stage, "safety");
  assert.ok(verdict.nextQuestions.length > 0);
  assert.ok(verdict.nextQuestions.length <= 2);
});

test("nextQuestions 截断展示但 allQuestions 保留全集（fail-closed 判定依据）", async () => {
  // 严重度阶段待答全集 4 问；展示截断为 2 问（评审 P1 kimi P1-6）。
  const verdict = await kernelWith().evaluate(safeFacts());
  assert.equal(verdict.outcome, "need_more_information");
  assert.equal(verdict.stage, "severity");
  assert.equal(verdict.nextQuestions.length, 2);
  assert.equal(verdict.allQuestions.length, 4);
  // 展示集是全集的前缀子集：截断只影响展示，不影响全集。
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
      fact("limbs_not_warm", "no")
    ])
  );
  assert.equal(classified.outcome, "classified");
  assert.deepEqual(classified.allQuestions, []);
});

test("低优先级不能覆盖高优先级阻断：安全阻断优先于严重度/证型分类", async () => {
  const facts = factsWith(safeFacts(), [
    fact("sleep_affected", "yes"),
    fact("thirst", "yes"),
    fact("limbs_not_warm", "no")
  ]);
  // 无阻断时这条路径会分类为 moderate_severe + LUNG_HEAT
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
  // 严重度已分类但证型信息不足时，流水线停在 syndrome 阶段，
  // 裁决仍携带已确定的 severityCode（该阶段之后的字段为空）。
  const allNo = await kernelWith().evaluate(
    factsWith(safeFacts(), [
      fact("sleep_affected", "no"),
      fact("daily_activity_affected", "no"),
      fact("work_study_affected", "no"),
      fact("symptoms_intolerable", "no")
    ])
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

  const twoYes = await kernelWith().evaluate(
    factsWith(safeFacts(), [
      fact("sleep_affected", "yes"),
      fact("work_study_affected", "yes")
    ])
  );
  assert.equal(twoYes.severityCode, "moderate_severe");

  const unknown = await kernelWith().evaluate(
    factsWith(safeFacts(), [fact("sleep_affected", "unknown")])
  );
  assert.equal(unknown.outcome, "need_more_information");
  assert.equal(unknown.stage, "severity");
  assert.equal(unknown.severityCode, null);
});

test("证型：五型决策树逐一命中", async () => {
  const cases: Array<[ConfirmedFact[], string, string]> = [
    // 口渴 + 四肢不温否 → 肺经伏热
    [
      [fact("thirst", "yes"), fact("limbs_not_warm", "no"), fact("fatigue", "no")],
      "LUNG_HEAT",
      "T1"
    ],
    // 口渴 + 四肢不温 + 无倦怠 → 寒热错杂（T5 优先于 T1）
    [
      [fact("thirst", "yes"), fact("limbs_not_warm", "yes"), fact("fatigue", "no")],
      "COLD_HEAT_COMPLEX",
      "T5"
    ],
    // 倦怠乏力 + 无口渴 → 脾气虚弱
    [
      [fact("fatigue", "yes"), fact("thirst", "no")],
      "SPLEEN_QI_DEF",
      "T2"
    ],
    // 畏风 + 无四肢不温 + 无倦怠 + 无口渴 → 肺气虚寒
    [
      [
        fact("fear_wind", "yes"),
        fact("limbs_not_warm", "no"),
        fact("fatigue", "no"),
        fact("thirst", "no")
      ],
      "LUNG_QI_COLD",
      "T3"
    ],
    // 形寒肢冷 + 四肢不温 + 无倦怠 + 无口渴 → 肾阳不足
    [
      [
        fact("cold_intolerance", "yes"),
        fact("limbs_not_warm", "yes"),
        fact("fatigue", "no"),
        fact("thirst", "no")
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

test("证型无命中：信息完整但不匹配任何规则 → no_match，不猜测", async () => {
  const verdict = await kernelWith().evaluate(
    factsWith(safeFacts(), [
      ...mildSeverityFacts(),
      fact("thirst", "no"),
      fact("fatigue", "no"),
      fact("limbs_not_warm", "no"),
      fact("fear_wind", "no"),
      fact("cold_intolerance", "no")
    ])
  );
  assert.equal(verdict.outcome, "no_match");
  assert.equal(verdict.stage, "syndrome");
  assert.equal(verdict.syndromeCode, null);
  assert.deepEqual(verdict.matchedRuleIds, []);
});

test("证型待定信息不足 → 补问且不越过证型阶段", async () => {
  const verdict = await kernelWith().evaluate(
    factsWith(safeFacts(), [
      ...mildSeverityFacts(),
      fact("thirst", "yes"),
      fact("limbs_not_warm", "unknown")
    ])
  );
  assert.equal(verdict.outcome, "need_more_information");
  assert.equal(verdict.stage, "syndrome");
  assert.ok(verdict.nextQuestions.some((q) => q.fieldCode === "limbs_not_warm"));
});

test("冲突：多个不同证型同时精确命中 → conflict，绝不猜测", async () => {
  // 构造一个故意重叠的规则包（同一条件两个不同证型），验证引擎冲突语义。
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
  const kernel = new ClinicalRuleKernel(overlapping, { findApprovedPlan: async () => null });
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

test("适用范围：主症不足两项 → non_applicable（转介不猜测）", async () => {
  const verdict = await kernelWith().evaluate(
    factsWith(
      safeFacts().filter((f) => !["paroxysmal_sneezing", "watery_rhinorrhea", "nasal_itching", "nasal_congestion"].includes(f.fieldCode)),
      [
        fact("paroxysmal_sneezing", "yes"),
        fact("watery_rhinorrhea", "no"),
        fact("nasal_itching", "no"),
        fact("nasal_congestion", "no")
      ]
    )
  );
  assert.equal(verdict.outcome, "non_applicable");
  assert.equal(verdict.stage, "applicability");
  assert.ok(verdict.matchedRuleIds.includes("APP-01"));
});

test("适用范围：感冒样/鼻窦炎样表现 → non_applicable", async () => {
  for (const fieldCode of ["cold_like_symptoms", "sinusitis_like_symptoms"]) {
    // 安全字段全部确认 no 后，适用范围阶段才会被评估（固定顺序）。
    const verdict = await kernelWith().evaluate(
      factsWith(safeFacts(), [fact(fieldCode, "yes")])
    );
    assert.equal(verdict.outcome, "non_applicable", fieldCode);
    assert.equal(verdict.stage, "applicability");
  }
});

test("完整分类：轻度 + 肺经伏热，无已批准方案时 planId=null", async () => {
  const verdict = await kernelWith().evaluate(
    factsWith(safeFacts(), [
      ...mildSeverityFacts(),
      fact("thirst", "yes"),
      fact("limbs_not_warm", "no")
    ])
  );
  assert.equal(verdict.outcome, "classified");
  assert.equal(verdict.stage, "completed");
  assert.equal(verdict.severityCode, "mild");
  assert.equal(verdict.syndromeCode, "LUNG_HEAT");
  assert.equal(verdict.planId, null);
  assert.ok(verdict.matchedRuleIds.includes("SEV-05"));
  assert.ok(verdict.matchedRuleIds.includes("T1"));
});

test("方案安全：肺经伏热 + 含灸法方案 → 方案安全阻断（MSAF-01）", async () => {
  const registry: PlanRegistryPort = {
    findApprovedPlan: async (input) =>
      input.syndromeCode === "LUNG_HEAT"
        ? { planId: "plan-test", planRevision: 1, attributes: { moxibustion: "yes" } }
        : null
  };
  const verdict = await new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, registry).evaluate(
    factsWith(safeFacts(), [
      ...mildSeverityFacts(),
      fact("thirst", "yes"),
      fact("limbs_not_warm", "no")
    ])
  );
  assert.equal(verdict.outcome, "blocked");
  assert.equal(verdict.stage, "plan_safety");
  assert.ok(verdict.matchedRuleIds.includes("MSAF-01"));
  assert.ok(verdict.matchedRuleIds.includes("T1"));
});

test("方案安全通过：肺经伏热 + 无灸法方案 → classified 且绑定方案", async () => {
  const registry: PlanRegistryPort = {
    findApprovedPlan: async () => ({
      planId: "plan-test",
      planRevision: 3,
      attributes: { moxibustion: "no" }
    })
  };
  const verdict = await new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, registry).evaluate(
    factsWith(safeFacts(), [
      ...mildSeverityFacts(),
      fact("thirst", "yes"),
      fact("limbs_not_warm", "no")
    ])
  );
  assert.equal(verdict.outcome, "classified");
  assert.equal(verdict.stage, "completed");
  assert.equal(verdict.planId, "plan-test");
  assert.equal(verdict.planRevision, 3);
  assert.ok(verdict.matchedRuleIds.includes("SEV-05"));
  assert.ok(verdict.matchedRuleIds.includes("T1"));
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

/** 生产注册表集成（评审 P0-1）：管理端自由文本 method 必须确定性映射为
 * 规则约定的属性键（moxibustion/guasha_cupping），否则 MSAF 规则永不触发。 */
function insertPlan(
  database: KangminDatabase,
  row: {
    id: string;
    syndrome: string;
    method: string;
    status?: "draft" | "enabled" | "disabled";
  }
): void {
  const now = "2026-08-01T00:00:00Z";
  database.connection
    .prepare(`
      INSERT INTO agent_plans(
        id, name, syndrome, method, steps_json, precautions, risks,
        contraindications, display_order, status, revision,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, '[]', '', '', '', 0, ?, 1, ?, ?)
    `)
    .run(
      row.id,
      `${row.id} 方案`,
      row.syndrome,
      row.method,
      row.status ?? "enabled",
      now,
      now
    );
}

/** 走到方案安全阶段的完整事实：安全通过 + 轻度 + 肺经伏热（T1）。 */
function lungHeatFacts(): ConfirmedFact[] {
  return factsWith(safeFacts(), [
    ...mildSeverityFacts(),
    fact("thirst", "yes"),
    fact("limbs_not_warm", "no")
  ]);
}

test("生产注册表：含灸法的启用方案触发 MSAF-01 阻断（自由文本 method 映射）", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-registry-"));
  const database = new KangminDatabase(join(directory, "registry.sqlite"));
  try {
    insertPlan(database, {
      id: "plan-moxa",
      syndrome: "LUNG_HEAT",
      method: "温和艾灸与日常护理"
    });
    const registry = new SqlitePlanRegistry(database);
    const kernel = new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, registry);

    // 管理端自由文本“温和艾灸与日常护理”含“灸”→ 属性键 moxibustion。
    const found = await registry.findApprovedPlan({
      syndromeCode: "LUNG_HEAT",
      severityCode: "mild"
    });
    assert.notEqual(found, null);
    assert.equal(found?.attributes.moxibustion, "yes");
    assert.equal(found?.attributes.guasha_cupping, undefined);

    const verdict = await kernel.evaluate(lungHeatFacts());
    assert.equal(verdict.outcome, "blocked");
    assert.equal(verdict.stage, "plan_safety");
    assert.ok(verdict.matchedRuleIds.includes("MSAF-01"));
    assert.ok(verdict.matchedRuleIds.includes("T1"));
    assert.equal(verdict.planId, "plan-moxa");
  } finally {
    database.close();
  }
});

test("生产注册表：刮痧/拔罐方法映射为 guasha_cupping（MSAF-02 属性键）", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-registry-"));
  const database = new KangminDatabase(join(directory, "registry.sqlite"));
  try {
    insertPlan(database, {
      id: "plan-cupping",
      syndrome: "COLD_HEAT_COMPLEX",
      method: "刮痧与拔罐组合调理"
    });
    const registry = new SqlitePlanRegistry(database);
    const found = await registry.findApprovedPlan({
      syndromeCode: "COLD_HEAT_COMPLEX",
      severityCode: "mild"
    });
    assert.notEqual(found, null);
    assert.equal(found?.attributes.guasha_cupping, "yes");
    assert.equal(found?.attributes.moxibustion, undefined);

    // 注：MSAF-02 与 SAF-05（皮损整体阻断外治）语义重叠矛盾需临床
    // 裁决；皮损时 pipeline 在 safety 阶段已被 SAF-05 阻断，MSAF-02
    // 在本测试中通过注册表映射直接验证属性键而非经完整流水线。
    const guashaFacts = factsWith(lungHeatFacts(), [fact("skin_lesion", "yes")]);
    const safetyVerdict = await new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, registry).evaluate(
      guashaFacts
    );
    assert.equal(safetyVerdict.outcome, "blocked");
    assert.equal(safetyVerdict.stage, "safety");
    assert.ok(safetyVerdict.matchedRuleIds.includes("SAF-05"));
  } finally {
    database.close();
  }
});

test("生产注册表：method 为空或无法映射时不出属性键（unmatched 安全语义）", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-registry-"));
  const database = new KangminDatabase(join(directory, "registry.sqlite"));
  try {
    const cases: Array<[string, string, string]> = [
      ["plan-empty", "LUNG_HEAT", ""],
      ["plan-unmapped", "SPLEEN_QI_DEF", "日常护理"],
      ["plan-other", "KIDNEY_YANG_DEF", "中药汤剂"]
    ];
    for (const [id, syndrome, method] of cases) {
      insertPlan(database, { id, syndrome, method });
    }
    const registry = new SqlitePlanRegistry(database);
    for (const [id, syndrome] of cases) {
      const found = await registry.findApprovedPlan({
        syndromeCode: syndrome,
        severityCode: "mild"
      });
      assert.notEqual(found, null);
      assert.equal(found?.planId, id);
      assert.deepEqual(found?.attributes, {}, `${id} 不应输出方法属性`);
    }

    // 无方法属性 → MSAF-01 的 moxibustion 条件按 unmatched 处理，
    // 方案安全通过（classified + 绑定方案），绝不误阻断。
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
