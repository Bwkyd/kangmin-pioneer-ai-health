import assert from "node:assert/strict";
import test from "node:test";

import type { FactEntry, FactMap } from "@kangmin/core/intelligence/clinical-rules/domain";
import {
  enumerateSyndromeTreePaths,
  evaluateSyndromeDecisionTree,
  type SyndromeNodeCode,
  type SyndromeOption
} from "@kangmin/core/intelligence/clinical-rules/syndrome-decision-tree";

class TestFacts implements FactMap {
  constructor(private readonly values: ReadonlyMap<string, FactEntry>) {}

  get(fieldCode: string): FactEntry | null {
    return this.values.get(fieldCode) ?? null;
  }
}

function facts(
  answers: ReadonlyArray<{ nodeCode: SyndromeNodeCode; option: SyndromeOption }>,
  auxiliary: ReadonlyArray<[string, FactEntry]> = []
): TestFacts {
  return new TestFacts(
    new Map<string, FactEntry>([
      ...answers.map(
        ({ nodeCode, option }) =>
          [nodeCode, { state: "value", value: option }] as const
      ),
      ...auxiliary
    ])
  );
}

test("六步证型树：穷举 111 条根到叶路径，逐节点有序且叶子立即终止", () => {
  const paths = enumerateSyndromeTreePaths();
  assert.equal(paths.length, 111);

  for (const [pathIndex, path] of paths.entries()) {
    for (let prefixLength = 0; prefixLength < path.answers.length; prefixLength += 1) {
      const result = evaluateSyndromeDecisionTree(
        facts(path.answers.slice(0, prefixLength))
      );
      assert.equal(result.kind, "need_answer", `路径 ${pathIndex} 前缀 ${prefixLength}`);
      if (result.kind === "need_answer") {
        assert.equal(
          result.nodeCode,
          path.answers[prefixLength]?.nodeCode,
          `路径 ${pathIndex} 不得跳题`
        );
      }
    }

    const result = evaluateSyndromeDecisionTree(facts(path.answers));
    assert.equal(result.kind, "classified", `路径 ${pathIndex} 必须到叶子`);
    if (result.kind === "classified") {
      assert.equal(result.leaf.syndromeCode, path.leaf.syndromeCode);
      assert.equal(result.leaf.ruleId, path.leaf.ruleId);
    }
  }
});

test("六步证型树：客户指定的四条关键纠错路径", () => {
  const cases: Array<{
    answers: Array<{ nodeCode: SyndromeNodeCode; option: SyndromeOption }>;
    expected: string;
  }> = [
    { answers: [{ nodeCode: "step1_q10", option: "A" }], expected: "LUNG_HEAT" },
    {
      answers: [
        { nodeCode: "step1_q10", option: "B" },
        { nodeCode: "step2_q8", option: "A" }
      ],
      expected: "SPLEEN_QI_DEF"
    },
    {
      answers: [
        { nodeCode: "step1_q10", option: "B" },
        { nodeCode: "step2_q8", option: "B" },
        { nodeCode: "step3_q6", option: "B" },
        { nodeCode: "step4_q9", option: "B" }
      ],
      expected: "LUNG_QI_COLD"
    },
    {
      answers: [
        { nodeCode: "step1_q10", option: "C" },
        { nodeCode: "step2_q8", option: "C" },
        { nodeCode: "step3_q6", option: "C" },
        { nodeCode: "step4_q9", option: "C" }
      ],
      expected: "LUNG_QI_COLD"
    }
  ];

  for (const entry of cases) {
    const result = evaluateSyndromeDecisionTree(facts(entry.answers));
    assert.equal(result.kind, "classified");
    if (result.kind === "classified") {
      assert.equal(result.leaf.syndromeCode, entry.expected);
    }
  }
});

test("六步证型树：首次与二次 Q8/Q10 独立，辅助事实不能覆盖叶子", () => {
  const answers = [
    { nodeCode: "step1_q10", option: "B" },
    { nodeCode: "step2_q8", option: "C" },
    { nodeCode: "step3_q6", option: "A" },
    { nodeCode: "step4_q9", option: "A" },
    { nodeCode: "step5_q8_confirm", option: "B" },
    { nodeCode: "step6_q10_confirm", option: "A" }
  ] as const;
  const auxiliary: Array<[string, FactEntry]> = [
    ["thirst", { state: "no" }],
    ["fatigue", { state: "yes" }],
    ["fear_wind", { state: "no" }],
    ["limbs_not_warm", { state: "no" }],
    ["heat_imbalance", { state: "no" }]
  ];

  const result = evaluateSyndromeDecisionTree(facts(answers, auxiliary));
  assert.equal(result.kind, "classified");
  if (result.kind === "classified") {
    assert.equal(result.leaf.syndromeCode, "COLD_HEAT_COMPLEX");
  }

  assert.notEqual("step2_q8", "step5_q8_confirm");
  assert.notEqual("step1_q10", "step6_q10_confirm");
});

test("六步证型树：非 A/B/C 或布尔压缩答案 fail-closed", () => {
  for (const entry of [
    { state: "yes" as const },
    { state: "no" as const },
    { state: "value" as const, value: "D" }
  ]) {
    const result = evaluateSyndromeDecisionTree(
      new TestFacts(new Map([["step1_q10", entry]]))
    );
    assert.equal(result.kind, "invalid_answer");
  }
});
