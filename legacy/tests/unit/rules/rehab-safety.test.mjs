import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRehabSafety, GUA_SHA_SAFETY_FIELDS, REHAB_SAFETY_FIELDS } from "../../../lib/agent/rehab-safety.ts";

function answers(overrides = {}) {
  return Object.fromEntries(REHAB_SAFETY_FIELDS.map((field) => [field, overrides[field] ?? "no"]));
}

function guaShaAnswers(overrides = {}) {
  return Object.fromEntries(GUA_SHA_SAFETY_FIELDS.map((field) => [field, overrides[field] ?? "no"]));
}

test("鼻三线姜刮不是普通刮痧，但仍先做专项安全排除", () => {
  const result = evaluateRehabSafety("nose_three_line_ginger_scrape", answers({ acuteColdRhinitis: "yes" }));
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockedBy, ["acuteColdRhinitis"]);
});

test("未知安全信息不能被当作可以操作", () => {
  const result = evaluateRehabSafety("finger_pressure_yingxiang", answers({ bleedingRisk: "unknown" }));
  assert.equal(result.status, "need_more_information");
  assert.deepEqual(result.nextQuestions, ["bleedingRisk"]);
});

test("肺经蕴热型不能推荐艾灸或电吹风吹大椎，两个方法分别受拦截", () => {
  for (const method of ["moxa_dazhui_fengchi", "electric_blow_dazhui_fengchi"]) {
    const result = evaluateRehabSafety(method, answers({ lungHeatPattern: "yes" }));
    assert.equal(result.status, "blocked");
    assert.ok(result.blockedBy.includes("lungHeatPattern"));
  }
});

test("全部专项风险明确排除后才允许进入已审核方案检索", () => {
  const result = evaluateRehabSafety("ear_acupressure", answers());
  assert.equal(result.status, "clear");
  assert.match(result.disclaimer, /不是诊断/u);
});

test("普通刮痧使用独立安全规则，先拦截发热感染并返回来源、版本和解释", () => {
  const result = evaluateRehabSafety("gua_sha", guaShaAnswers({ feverOrInfection: "yes" }));
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockedBy, ["feverOrInfection"]);
  assert.deepEqual(result.blockedReasons, ["发热、感染或明显头痛"]);
  assert.equal(result.rulePackageVersion, "gua-sha-safety-v1");
  assert.match(result.ruleSource, /Issue #94–#96/u);
});

test("普通刮痧的 unknown 按优先顺序补问，不能被当作安全", () => {
  const result = evaluateRehabSafety("gua_sha", guaShaAnswers({ feverOrInfection: "unknown" }));
  assert.equal(result.status, "need_more_information");
  assert.deepEqual(result.nextQuestions, ["feverOrInfection"]);
  assert.deepEqual(result.nextQuestionPrompts, ["发热、感染或明显头痛"]);
});

test("普通刮痧独立拦截皮肤、出血、慢病和特殊状态，不复用姜刮介质字段", () => {
  const result = evaluateRehabSafety("gua_sha", guaShaAnswers({ skinAllergyAtSite: "yes", bleedingRisk: "yes" }));
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockedBy, ["skinAllergyAtSite", "bleedingRisk"]);
  assert.equal(result.blockedReasons.length, 2);
});

test("普通刮痧每个受控关键字段命中 yes 都会阻断", () => {
  for (const field of GUA_SHA_SAFETY_FIELDS) {
    const result = evaluateRehabSafety("gua_sha", guaShaAnswers({ [field]: "yes" }));
    assert.equal(result.status, "blocked", field);
    assert.deepEqual(result.blockedBy, [field], field);
  }
});
