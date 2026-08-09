import assert from "node:assert/strict";
import test from "node:test";

import {
  FIELD_TO_QUESTION,
  parseOptionPayload
} from "../modules/agent/option-mapping.js";

test("证型选项按当前节点保存 A/B/C，不压成布尔值", () => {
  assert.deepEqual(parseOptionPayload("q10=A", [{ fieldCode: "step1_q10" }]), {
    question: "q10",
    option: "A",
    field: "step1_q10",
    state: "value",
    factValue: "A"
  });
  assert.deepEqual(parseOptionPayload("q9=B", [{ fieldCode: "step4_q9" }]), {
    question: "q9",
    option: "B",
    field: "step4_q9",
    state: "value",
    factValue: "B"
  });
});

test("同题首次与二次确认映射到不同节点", () => {
  assert.equal(
    parseOptionPayload("q8=C", [{ fieldCode: "step2_q8" }])?.field,
    "step2_q8"
  );
  assert.equal(
    parseOptionPayload("q8=C", [{ fieldCode: "step5_q8_confirm" }])?.field,
    "step5_q8_confirm"
  );
  assert.equal(
    parseOptionPayload("q10=B", [{ fieldCode: "step6_q10_confirm" }])?.field,
    "step6_q10_confirm"
  );
});

test("当前节点与题号不一致时拒绝越序写入", () => {
  assert.equal(
    parseOptionPayload("q8=A", [{ fieldCode: "step1_q10" }]),
    null
  );
});

test("非证型题继续按既有确定性映射", () => {
  assert.deepEqual(
    parseOptionPayload("q1=B", [{ fieldCode: "paroxysmal_sneezing" }]),
    {
      question: "q1",
      option: "B",
      field: "paroxysmal_sneezing",
      state: "yes",
      factValue: null
    }
  );
  assert.equal(FIELD_TO_QUESTION.step6_q10_confirm, "q10");
});
