import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAFT_SYNDROME_RULES,
  RULE_PACKAGE_VERSION,
  SAFETY_FIELDS,
  SEVERITY_FIELDS,
  SYNDROME_FIELDS,
  evaluateAssessment,
  evaluateSafety,
  evaluateSeverity,
  evaluateSyndrome,
} from "../../../lib/agent/rules.ts";

function answersFromBits(fields, bits) {
  return Object.fromEntries(
    fields.map((field, index) => [
      field,
      bits & (1 << index) ? "yes" : "no",
    ]),
  );
}

function allAnswers(fields, value = "no") {
  return Object.fromEntries(fields.map((field) => [field, value]));
}

function completeInput(overrides = {}) {
  return {
    diagnosedAllergicRhinitis: "yes",
    safety: allAnswers(SAFETY_FIELDS),
    severity: allAnswers(SEVERITY_FIELDS),
    syndrome: {
      thirst: "yes",
      fatigue: "no",
      limbsNotWarm: "no",
      fearWind: "no",
      coldIntolerance: "no",
    },
    ...overrides,
  };
}

test("五个高风险项任一命中都会阻断，未知项不会被当作否", () => {
  for (const field of SAFETY_FIELDS) {
    const answers = allAnswers(SAFETY_FIELDS);
    answers[field] = "yes";

    assert.deepEqual(evaluateSafety(answers), {
      status: "blocked",
      matchedRuleIds: [`SAFE-${field}`],
      rulePackageVersion: RULE_PACKAGE_VERSION,
    });
  }

  assert.equal(evaluateSafety(allAnswers(SAFETY_FIELDS)).status, "clear");

  const unknownAnswers = allAnswers(SAFETY_FIELDS);
  unknownAnswers.severeNoseBleed = "unknown";
  assert.deepEqual(evaluateSafety(unknownAnswers), {
    status: "need_more_information",
    nextQuestions: ["severeNoseBleed"],
    rulePackageVersion: RULE_PACKAGE_VERSION,
  });
});

test("严重度 16 种完整组合全部确定：全否为轻度，其余为中重度", () => {
  for (let bits = 0; bits < 2 ** SEVERITY_FIELDS.length; bits += 1) {
    const result = evaluateSeverity(answersFromBits(SEVERITY_FIELDS, bits));
    assert.equal(result.status, "classified");
    assert.equal(result.severity, bits === 0 ? "mild" : "moderate_severe");
  }
});

test("严重度未知项需要确认，但已有肯定项足以判为中重度", () => {
  const incomplete = allAnswers(SEVERITY_FIELDS);
  incomplete.sleepAffected = "unknown";
  assert.deepEqual(evaluateSeverity(incomplete), {
    status: "need_more_information",
    nextQuestions: ["sleepAffected"],
    rulePackageVersion: RULE_PACKAGE_VERSION,
  });

  incomplete.activityAffected = "yes";
  const determined = evaluateSeverity(incomplete);
  assert.equal(determined.status, "classified");
  assert.equal(determined.severity, "moderate_severe");
});

test("证型 32 种完整组合均有确定输出，且不依赖规则声明顺序", () => {
  for (let bits = 0; bits < 2 ** SYNDROME_FIELDS.length; bits += 1) {
    const answers = answersFromBits(SYNDROME_FIELDS, bits);
    const forward = evaluateSyndrome(answers);
    const reverse = evaluateSyndrome(answers, [...DRAFT_SYNDROME_RULES].reverse());

    assert.notEqual(forward.status, "need_more_information");
    assert.deepEqual(reverse, forward);
  }
});

test("证型规则覆盖单一命中、冲突、不足与无匹配", () => {
  const cases = [
    {
      expected: "LUNG_HEAT",
      answers: {
        thirst: "yes",
        fatigue: "no",
        limbsNotWarm: "no",
        fearWind: "no",
        coldIntolerance: "no",
      },
    },
    {
      expected: "SPLEEN_QI_DEF",
      answers: {
        thirst: "no",
        fatigue: "yes",
        limbsNotWarm: "no",
        fearWind: "no",
        coldIntolerance: "no",
      },
    },
    {
      expected: "LUNG_QI_COLD",
      answers: {
        thirst: "no",
        fatigue: "no",
        limbsNotWarm: "no",
        fearWind: "yes",
        coldIntolerance: "no",
      },
    },
    {
      expected: "KIDNEY_YANG_DEF",
      answers: {
        thirst: "no",
        fatigue: "no",
        limbsNotWarm: "yes",
        fearWind: "no",
        coldIntolerance: "yes",
      },
    },
  ];

  for (const item of cases) {
    const result = evaluateSyndrome(item.answers);
    assert.equal(result.status, "classified");
    assert.equal(result.syndromeCode, item.expected);
  }

  const conflict = evaluateSyndrome({
    thirst: "yes",
    fatigue: "no",
    limbsNotWarm: "yes",
    fearWind: "no",
    coldIntolerance: "no",
  });
  assert.equal(conflict.status, "conflict");
  assert.deepEqual(conflict.matchedRuleIds, ["T1", "T5"]);

  const incomplete = evaluateSyndrome({
    thirst: "unknown",
    fatigue: "yes",
    limbsNotWarm: "no",
    fearWind: "no",
    coldIntolerance: "no",
  });
  assert.equal(incomplete.status, "need_more_information");
  assert.ok(incomplete.nextQuestions.includes("thirst"));

  assert.equal(
    evaluateSyndrome({
      thirst: "no",
      fatigue: "no",
      limbsNotWarm: "no",
      fearWind: "no",
      coldIntolerance: "no",
    }).status,
    "no_match",
  );
});

test("总流程严格按安全、适用资格、严重度、证型顺序执行", () => {
  const blocked = evaluateAssessment(
    completeInput({
      diagnosedAllergicRhinitis: "unknown",
      safety: {
        ...allAnswers(SAFETY_FIELDS),
        respiratoryEmergency: "yes",
      },
    }),
  );
  assert.equal(blocked.status, "blocked");
  assert.equal("severity" in blocked, false);
  assert.equal("syndrome" in blocked, false);

  for (const eligibility of ["no", "unknown"]) {
    assert.deepEqual(
      evaluateAssessment(
        completeInput({ diagnosedAllergicRhinitis: eligibility }),
      ),
      {
        status: "referred",
        reason: "not_diagnosed_or_uncertain",
        rulePackageVersion: RULE_PACKAGE_VERSION,
      },
    );
  }

  const result = evaluateAssessment(completeInput());
  assert.equal(result.status, "classified");
  assert.equal(result.planStatus, "no_approved_plan");
  assert.equal(result.rulePackageVersion, RULE_PACKAGE_VERSION);
});
