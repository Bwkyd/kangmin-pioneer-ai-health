import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../app/application.js";
import type { CommandResult } from "../kernel/result.js";
import type { SymptomRecord } from "../modules/record/contracts.js";

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

function fixture(): {
  application: ReturnType<typeof createApplication>;
  tokenA: string;
  tokenB: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-app-"));
  const application = createApplication(join(directory, "records.sqlite"));
  const tokenA = application.sessions.createDevelopmentSession("patient-a").token;
  const tokenB = application.sessions.createDevelopmentSession("patient-b").token;
  return { application, tokenA, tokenB };
}

const symptomInput = {
  localDate: "2026-07-31",
  nasalCongestion: 2,
  nasalItching: 1,
  sneezing: 3,
  runnyNose: 2,
  notes: "换季后加重",
  idempotencyKey: "symptom-20260731"
};

test("Record 创建、查询和更新形成单一患者闭环", () => {
  const { application, tokenA } = fixture();
  try {
    const created = application.execute({
      command: "record symptom add",
      input: symptomInput,
      sessionToken: tokenA,
      requestId: "req-create"
    });
    const createdData = dataOf<SymptomRecord>(created);
    assert.equal(createdData.tnssTotal, 8);
    assert.equal(createdData.revision, 1);

    const listed = application.execute({
      command: "record symptom list",
      sessionToken: tokenA
    });
    const listedData = dataOf<{ items: SymptomRecord[] }>(listed);
    assert.equal(listedData.items.length, 1);
    assert.equal(listedData.items[0]?.id, createdData.id);

    const updated = application.execute({
      command: "record symptom update",
      input: {
        id: createdData.id,
        expectedRevision: 1,
        sneezing: 1
      },
      sessionToken: tokenA
    });
    const updatedData = dataOf<SymptomRecord>(updated);
    assert.equal(updatedData.tnssTotal, 6);
    assert.equal(updatedData.revision, 2);
  } finally {
    application.close();
  }
});

test("幂等重放返回原结果，同键不同请求被拒绝", () => {
  const { application, tokenA } = fixture();
  try {
    const first = application.execute({
      command: "record symptom add",
      input: symptomInput,
      sessionToken: tokenA
    });
    const replay = application.execute({
      command: "record symptom add",
      input: symptomInput,
      sessionToken: tokenA
    });
    const firstData = dataOf<SymptomRecord>(first);
    const replayData = dataOf<SymptomRecord>(replay);
    assert.equal(firstData.id, replayData.id);

    const conflict = application.execute({
      command: "record symptom add",
      input: { ...symptomInput, sneezing: 0 },
      sessionToken: tokenA
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) {
      assert.equal(conflict.error.code, "idempotency_conflict");
    }
  } finally {
    application.close();
  }
});

test("跨患者访问隐藏资源，旧 revision 不能迟到覆盖", () => {
  const { application, tokenA, tokenB } = fixture();
  try {
    const created = application.execute({
      command: "record symptom add",
      input: symptomInput,
      sessionToken: tokenA
    });
    const createdData = dataOf<SymptomRecord>(created);

    const crossPatient = application.execute({
      command: "record symptom show",
      input: { id: createdData.id },
      sessionToken: tokenB
    });
    assert.equal(crossPatient.ok, false);
    if (!crossPatient.ok) {
      assert.equal(crossPatient.error.code, "resource_not_found");
    }

    const updated = application.execute({
      command: "record symptom update",
      input: {
        id: createdData.id,
        expectedRevision: 1,
        notes: "第一次更新"
      },
      sessionToken: tokenA
    });
    assert.equal(updated.ok, true);

    const stale = application.execute({
      command: "record symptom update",
      input: {
        id: createdData.id,
        expectedRevision: 1,
        notes: "迟到更新"
      },
      sessionToken: tokenA
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.error.code, "version_conflict");
    }
  } finally {
    application.close();
  }
});

test("客户端不能提交权威患者 ID，未实现能力明确失败", () => {
  const { application, tokenA } = fixture();
  try {
    const forged = application.execute({
      command: "record symptom list",
      input: { patientId: "forged" },
      sessionToken: tokenA
    });
    assert.equal(forged.ok, false);
    if (!forged.ok) {
      assert.equal(forged.error.code, "permission_denied");
    }

    const agent = application.execute({ command: "agent" });
    assert.equal(agent.ok, false);
    if (!agent.ok) {
      assert.equal(agent.error.code, "capability_unavailable");
    }
  } finally {
    application.close();
  }
});
