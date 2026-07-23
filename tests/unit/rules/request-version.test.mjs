import assert from "node:assert/strict";
import test from "node:test";

import { RequestVersion } from "../../../lib/agent/request-version.ts";

test("候选变化后在途评估响应不得落地", async () => {
  const versions = new RequestVersion();
  const submittedVersion = versions.capture();
  let landedAssessment = null;

  const staleResponse = Promise.resolve("旧 answers 的非阻断结果").then(
    (assessment) => {
      if (versions.isCurrent(submittedVersion)) {
        landedAssessment = assessment;
      }
    },
  );

  versions.invalidate();
  await staleResponse;

  assert.equal(landedAssessment, null);
});

test("没有候选变化时当前评估响应允许落地", async () => {
  const versions = new RequestVersion();
  const submittedVersion = versions.capture();
  let landedAssessment = null;

  await Promise.resolve("当前 answers 的结果").then((assessment) => {
    if (versions.isCurrent(submittedVersion)) {
      landedAssessment = assessment;
    }
  });

  assert.equal(landedAssessment, "当前 answers 的结果");
});
