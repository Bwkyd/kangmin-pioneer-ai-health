import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRehabSafety, REHAB_SAFETY_FIELDS } from "../../../lib/agent/rehab-safety.ts";

function answers(overrides = {}) {
  return Object.fromEntries(REHAB_SAFETY_FIELDS.map((field) => [field, overrides[field] ?? "no"]));
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
