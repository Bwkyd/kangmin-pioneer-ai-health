import assert from "node:assert/strict";
import test from "node:test";

import {
  captureOriginalValues,
  restoreAcceptedValues,
} from "../../../lib/agent/candidate-state.ts";

test("忽略、清空或重新提取会恢复候选采用前的结构化回答", () => {
  const originals = captureOriginalValues(
    ["respiratoryEmergency", "thirst"],
    {
      respiratoryEmergency: "no",
    },
  );

  assert.deepEqual(originals, {
    respiratoryEmergency: "no",
    thirst: undefined,
  });

  const restored = restoreAcceptedValues(
    {
      respiratoryEmergency: "yes",
      thirst: "yes",
      fatigue: "no",
    },
    ["respiratoryEmergency", "thirst"],
    {
      respiratoryEmergency: "accepted",
      thirst: "accepted",
    },
    originals,
  );

  assert.deepEqual(restored, {
    respiratoryEmergency: "no",
    fatigue: "no",
  });
});

test("未采用的候选不会覆盖用户后来手工确认的回答", () => {
  const restored = restoreAcceptedValues(
    { thirst: "no" },
    ["thirst"],
    { thirst: "ignored" },
    { thirst: "yes" },
  );

  assert.deepEqual(restored, { thirst: "no" });
});
