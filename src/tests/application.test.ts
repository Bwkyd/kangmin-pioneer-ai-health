import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../app/composition-root.js";
import type { CommandResult } from "../kernel/result.js";
import type {
  CalendarProjection,
  ExposureRecord,
  HealthProfile,
  MedicationRecord,
  OverviewData,
  SymptomRecord,
  TrendProjection
} from "../modules/record/contracts.js";

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

async function fixture(): Promise<{
  application: ReturnType<typeof createApplication>;
  tokenA: string;
  tokenB: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-app-"));
  const application = createApplication(join(directory, "records.sqlite"));
  const tokenA =
    (await application.sessions.createDevelopmentSession("patient-a")).token;
  const tokenB =
    (await application.sessions.createDevelopmentSession("patient-b")).token;
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

test("Record 创建、查询和更新形成单一患者闭环", async () => {
  const { application, tokenA } = await fixture();
  try {
    const created = await application.execute({
      command: "record symptom add",
      input: symptomInput,
      sessionToken: tokenA,
      requestId: "req-create"
    });
    const createdData = dataOf<SymptomRecord>(created);
    assert.equal(createdData.tnssTotal, 8);
    assert.equal(createdData.revision, 1);

    const listed = await application.execute({
      command: "record symptom list",
      sessionToken: tokenA
    });
    const listedData = dataOf<{ items: SymptomRecord[] }>(listed);
    assert.equal(listedData.items.length, 1);
    assert.equal(listedData.items[0]?.id, createdData.id);

    const updated = await application.execute({
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

test("幂等重放返回原结果，同键不同请求被拒绝", async () => {
  const { application, tokenA } = await fixture();
  try {
    const first = await application.execute({
      command: "record symptom add",
      input: symptomInput,
      sessionToken: tokenA
    });
    const replay = await application.execute({
      command: "record symptom add",
      input: symptomInput,
      sessionToken: tokenA
    });
    const firstData = dataOf<SymptomRecord>(first);
    const replayData = dataOf<SymptomRecord>(replay);
    assert.equal(firstData.id, replayData.id);

    const conflict = await application.execute({
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

test("跨患者访问隐藏资源，旧 revision 不能迟到覆盖", async () => {
  const { application, tokenA, tokenB } = await fixture();
  try {
    const created = await application.execute({
      command: "record symptom add",
      input: symptomInput,
      sessionToken: tokenA
    });
    const createdData = dataOf<SymptomRecord>(created);

    const crossPatient = await application.execute({
      command: "record symptom show",
      input: { id: createdData.id },
      sessionToken: tokenB
    });
    assert.equal(crossPatient.ok, false);
    if (!crossPatient.ok) {
      assert.equal(crossPatient.error.code, "resource_not_found");
    }

    const updated = await application.execute({
      command: "record symptom update",
      input: {
        id: createdData.id,
        expectedRevision: 1,
        notes: "第一次更新"
      },
      sessionToken: tokenA
    });
    assert.equal(updated.ok, true);

    const stale = await application.execute({
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

test("客户端不能提交权威患者 ID，未实现能力明确失败", async () => {
  const { application, tokenA } = await fixture();
  try {
    const forged = await application.execute({
      command: "record symptom list",
      input: { patientId: "forged" },
      sessionToken: tokenA
    });
    assert.equal(forged.ok, false);
    if (!forged.ok) {
      assert.equal(forged.error.code, "permission_denied");
    }

    const agent = await application.execute({ command: "agent" });
    assert.equal(agent.ok, false);
    if (!agent.ok) {
      assert.equal(agent.error.code, "capability_unavailable");
    }
  } finally {
    application.close();
  }
});

test("健康档案从未建档到创建再到版本冲突", async () => {
  const { application, tokenA } = await fixture();
  try {
    const empty = await application.execute({
      command: "record profile show",
      sessionToken: tokenA
    });
    const emptyData = dataOf<HealthProfile>(empty);
    assert.equal(emptyData.revision, 0);
    assert.equal(emptyData.sex, "unspecified");

    const created = await application.execute({
      command: "record profile update",
      input: {
        expectedRevision: 0,
        displayName: "小王",
        birthDate: "1990-05-20",
        sex: "male",
        allergyHistory: "尘螨过敏史",
        notes: "换季加重"
      },
      sessionToken: tokenA
    });
    const createdData = dataOf<HealthProfile>(created);
    assert.equal(createdData.revision, 1);
    assert.equal(createdData.displayName, "小王");
    assert.equal(createdData.birthDate, "1990-05-20");

    const updated = await application.execute({
      command: "record profile update",
      input: {
        expectedRevision: 1,
        commonTriggers: "花粉、冷空气"
      },
      sessionToken: tokenA
    });
    const updatedData = dataOf<HealthProfile>(updated);
    assert.equal(updatedData.revision, 2);
    assert.equal(updatedData.commonTriggers, "花粉、冷空气");
    assert.equal(updatedData.displayName, "小王");

    const stale = await application.execute({
      command: "record profile update",
      input: { expectedRevision: 1, notes: "迟到修改" },
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

test("健康档案校验：非法性别、非法生日、空更新被拒绝", async () => {
  const { application, tokenA } = await fixture();
  try {
    const badSex = await application.execute({
      command: "record profile update",
      input: { expectedRevision: 0, sex: "robot" },
      sessionToken: tokenA
    });
    assert.equal(badSex.ok, false);
    if (!badSex.ok) {
      assert.equal(badSex.error.code, "validation_failed");
    }

    const badBirth = await application.execute({
      command: "record profile update",
      input: { expectedRevision: 0, birthDate: "1990-13-40" },
      sessionToken: tokenA
    });
    assert.equal(badBirth.ok, false);
    if (!badBirth.ok) {
      assert.equal(badBirth.error.code, "validation_failed");
    }

    const empty = await application.execute({
      command: "record profile update",
      input: { expectedRevision: 0 },
      sessionToken: tokenA
    });
    assert.equal(empty.ok, false);
    if (!empty.ok) {
      assert.equal(empty.error.code, "validation_failed");
    }
  } finally {
    application.close();
  }
});

test("暴露记录闭环：互斥校验、同日期冲突、版本冲突与删除确认", async () => {
  const { application, tokenA, tokenB } = await fixture();
  try {
    const conflicting = await application.execute({
      command: "record exposure add",
      input: {
        localDate: "2026-07-10",
        factors: ["none_identified", "pollen"],
        idempotencyKey: "exposure-conflict-key"
      },
      sessionToken: tokenA
    });
    assert.equal(conflicting.ok, false);
    if (!conflicting.ok) {
      assert.equal(conflicting.error.code, "validation_failed");
    }

    const noOtherDescription = await application.execute({
      command: "record exposure add",
      input: {
        localDate: "2026-07-10",
        factors: ["other"],
        idempotencyKey: "exposure-other-key"
      },
      sessionToken: tokenA
    });
    assert.equal(noOtherDescription.ok, false);
    if (!noOtherDescription.ok) {
      assert.equal(noOtherDescription.error.code, "validation_failed");
    }

    const created = await application.execute({
      command: "record exposure add",
      input: {
        localDate: "2026-07-10",
        factors: ["pollen", "dust_mite"],
        otherDescription: null,
        notes: "白天外出",
        idempotencyKey: "exposure-20260710"
      },
      sessionToken: tokenA
    });
    const createdData = dataOf<ExposureRecord>(created);
    assert.equal(createdData.revision, 1);
    assert.deepEqual(createdData.factors, ["pollen", "dust_mite"]);

    const sameDate = await application.execute({
      command: "record exposure add",
      input: {
        localDate: "2026-07-10",
        factors: ["mold"],
        idempotencyKey: "exposure-20260710-b"
      },
      sessionToken: tokenA
    });
    assert.equal(sameDate.ok, false);
    if (!sameDate.ok) {
      assert.equal(sameDate.error.code, "date_conflict");
    }

    const updated = await application.execute({
      command: "record exposure update",
      input: {
        id: createdData.id,
        expectedRevision: 1,
        factors: ["other"],
        otherDescription: "装修油漆味"
      },
      sessionToken: tokenA
    });
    const updatedData = dataOf<ExposureRecord>(updated);
    assert.equal(updatedData.revision, 2);
    assert.equal(updatedData.otherDescription, "装修油漆味");

    const withoutYes = await application.execute({
      command: "record exposure delete",
      input: { id: createdData.id, expectedRevision: 2 },
      sessionToken: tokenA
    });
    assert.equal(withoutYes.ok, false);
    if (!withoutYes.ok) {
      assert.equal(withoutYes.error.code, "confirmation_required");
    }

    const deleted = await application.execute({
      command: "record exposure delete",
      input: { id: createdData.id, expectedRevision: 2, yes: true },
      sessionToken: tokenA
    });
    assert.equal(deleted.ok, true);
    const deletedData = dataOf<{ deleted: boolean }>(deleted);
    assert.equal(deletedData.deleted, true);

    const gone = await application.execute({
      command: "record exposure show",
      input: { id: createdData.id },
      sessionToken: tokenA
    });
    assert.equal(gone.ok, false);
    if (!gone.ok) {
      assert.equal(gone.error.code, "resource_not_found");
    }

    const crossPatient = await application.execute({
      command: "record exposure delete",
      input: { id: createdData.id, expectedRevision: 2, yes: true },
      sessionToken: tokenB
    });
    assert.equal(crossPatient.ok, false);
    if (!crossPatient.ok) {
      assert.equal(crossPatient.error.code, "resource_not_found");
    }
  } finally {
    application.close();
  }
});

test("用药记录闭环：同日多条、幂等重放、删除确认与跨患者隔离", async () => {
  const { application, tokenA, tokenB } = await fixture();
  try {
    const first = await application.execute({
      command: "record medication add",
      input: {
        localDate: "2026-07-20",
        medicationName: "氯雷他定",
        dosage: "10mg",
        actualUse: "每晚一次",
        idempotencyKey: "med-20260720-1"
      },
      sessionToken: tokenA
    });
    const firstData = dataOf<MedicationRecord>(first);
    assert.equal(firstData.revision, 1);

    const secondSameDay = await application.execute({
      command: "record medication add",
      input: {
        localDate: "2026-07-20",
        medicationName: "生理盐水喷雾",
        idempotencyKey: "med-20260720-2"
      },
      sessionToken: tokenA
    });
    const secondData = dataOf<MedicationRecord>(secondSameDay);
    assert.notEqual(secondData.id, firstData.id);

    const replay = await application.execute({
      command: "record medication add",
      input: {
        localDate: "2026-07-20",
        medicationName: "氯雷他定",
        dosage: "10mg",
        actualUse: "每晚一次",
        idempotencyKey: "med-20260720-1"
      },
      sessionToken: tokenA
    });
    const replayData = dataOf<MedicationRecord>(replay);
    assert.equal(replayData.id, firstData.id);

    const updated = await application.execute({
      command: "record medication update",
      input: {
        id: firstData.id,
        expectedRevision: 1,
        dosage: "20mg"
      },
      sessionToken: tokenA
    });
    const updatedData = dataOf<MedicationRecord>(updated);
    assert.equal(updatedData.dosage, "20mg");
    assert.equal(updatedData.revision, 2);

    const crossPatient = await application.execute({
      command: "record medication show",
      input: { id: firstData.id },
      sessionToken: tokenB
    });
    assert.equal(crossPatient.ok, false);
    if (!crossPatient.ok) {
      assert.equal(crossPatient.error.code, "resource_not_found");
    }

    const deleted = await application.execute({
      command: "record medication delete",
      input: { id: firstData.id, expectedRevision: 2, yes: true },
      sessionToken: tokenA
    });
    assert.equal(deleted.ok, true);

    const staleDelete = await application.execute({
      command: "record medication delete",
      input: { id: firstData.id, expectedRevision: 2, yes: true },
      sessionToken: tokenA
    });
    assert.equal(staleDelete.ok, false);
    if (!staleDelete.ok) {
      assert.equal(staleDelete.error.code, "resource_not_found");
    }
  } finally {
    application.close();
  }
});

test("症状删除：确认后删除、同日期可重建、旧版本拒绝", async () => {
  const { application, tokenA } = await fixture();
  try {
    const created = await application.execute({
      command: "record symptom add",
      input: { ...symptomInput, idempotencyKey: "symptom-delete-1" },
      sessionToken: tokenA
    });
    const createdData = dataOf<SymptomRecord>(created);

    const deleted = await application.execute({
      command: "record symptom delete",
      input: { id: createdData.id, expectedRevision: 1, yes: true },
      sessionToken: tokenA
    });
    assert.equal(deleted.ok, true);

    const gone = await application.execute({
      command: "record symptom show",
      input: { id: createdData.id },
      sessionToken: tokenA
    });
    assert.equal(gone.ok, false);
    if (!gone.ok) {
      assert.equal(gone.error.code, "resource_not_found");
    }

    const rebuilt = await application.execute({
      command: "record symptom add",
      input: { ...symptomInput, idempotencyKey: "symptom-delete-2" },
      sessionToken: tokenA
    });
    const rebuiltData = dataOf<SymptomRecord>(rebuilt);
    assert.notEqual(rebuiltData.id, createdData.id);

    const wrongRevision = await application.execute({
      command: "record symptom delete",
      input: { id: rebuiltData.id, expectedRevision: 99, yes: true },
      sessionToken: tokenA
    });
    assert.equal(wrongRevision.ok, false);
    if (!wrongRevision.ok) {
      assert.equal(wrongRevision.error.code, "version_conflict");
    }

    const deletedRebuilt = await application.execute({
      command: "record symptom delete",
      input: { id: rebuiltData.id, expectedRevision: 1, yes: true },
      sessionToken: tokenA
    });
    assert.equal(deletedRebuilt.ok, true);

    const again = await application.execute({
      command: "record symptom delete",
      input: { id: rebuiltData.id, expectedRevision: 1, yes: true },
      sessionToken: tokenA
    });
    assert.equal(again.ok, false);
    if (!again.ok) {
      assert.equal(again.error.code, "resource_not_found");
    }
  } finally {
    application.close();
  }
});

test("删除后同幂等键重放被拒绝为 stale_replay，不返回幻影记录", async () => {
  const { application, tokenA } = await fixture();
  try {
    const created = await application.execute({
      command: "record symptom add",
      input: { ...symptomInput, idempotencyKey: "replay-after-delete" },
      sessionToken: tokenA
    });
    const createdData = dataOf<SymptomRecord>(created);

    const deleted = await application.execute({
      command: "record symptom delete",
      input: { id: createdData.id, expectedRevision: 1, yes: true },
      sessionToken: tokenA
    });
    assert.equal(deleted.ok, true);

    const replay = await application.execute({
      command: "record symptom add",
      input: { ...symptomInput, idempotencyKey: "replay-after-delete" },
      sessionToken: tokenA
    });
    assert.equal(replay.ok, false);
    if (!replay.ok) {
      assert.equal(replay.error.code, "stale_replay");
    }
  } finally {
    application.close();
  }
});

test("未来日期被拒绝，空更新在查找前校验失败", async () => {
  const { application, tokenA } = await fixture();
  try {
    const future = await application.execute({
      command: "record symptom add",
      input: {
        ...symptomInput,
        localDate: "2099-01-01",
        idempotencyKey: "future-date"
      },
      sessionToken: tokenA
    });
    assert.equal(future.ok, false);
    if (!future.ok) {
      assert.equal(future.error.code, "validation_failed");
    }

    const emptySymptomUpdate = await application.execute({
      command: "record symptom update",
      input: { id: "no-such-id", expectedRevision: 1 },
      sessionToken: tokenA
    });
    assert.equal(emptySymptomUpdate.ok, false);
    if (!emptySymptomUpdate.ok) {
      assert.equal(emptySymptomUpdate.error.code, "validation_failed");
    }

    const emptyExposureUpdate = await application.execute({
      command: "record exposure update",
      input: { id: "no-such-id", expectedRevision: 1 },
      sessionToken: tokenA
    });
    assert.equal(emptyExposureUpdate.ok, false);
    if (!emptyExposureUpdate.ok) {
      assert.equal(emptyExposureUpdate.error.code, "validation_failed");
    }

    const emptyProfileUpdate = await application.execute({
      command: "record profile update",
      input: { expectedRevision: 0 },
      sessionToken: tokenA
    });
    assert.equal(emptyProfileUpdate.ok, false);
    if (!emptyProfileUpdate.ok) {
      assert.equal(emptyProfileUpdate.error.code, "validation_failed");
    }
  } finally {
    application.close();
  }
});

test("概览在空数据与有数据之间明确区分", async () => {
  const { application, tokenA } = await fixture();
  try {
    const empty = await application.execute({
      command: "record overview",
      sessionToken: tokenA
    });
    const emptyData = dataOf<OverviewData>(empty);
    assert.equal(emptyData.recentSymptomDate, null);
    assert.equal(emptyData.monthRecordCount, 0);
    assert.equal(emptyData.consecutiveDays, 0);
    assert.equal(emptyData.lastTnss, null);
    assert.equal(emptyData.recentExposureDate, null);
    assert.equal(emptyData.recentMedicationDate, null);
    assert.equal(emptyData.dataRead, "ok");

    const today = new Date();
    const localToday = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0")
    ].join("-");
    const daysAgo = (days: number): string => {
      const date = new Date(today);
      date.setDate(date.getDate() - days);
      return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")
      ].join("-");
    };

    for (const [index, day] of [localToday, daysAgo(1), daysAgo(2)].entries()) {
      const result = await application.execute({
        command: "record symptom add",
        input: {
          ...symptomInput,
          localDate: day,
          idempotencyKey: `overview-symptom-${index}`
        },
        sessionToken: tokenA
      });
      assert.equal(result.ok, true);
    }
    await application.execute({
      command: "record exposure add",
      input: {
        localDate: daysAgo(1),
        factors: ["pollen"],
        idempotencyKey: "overview-exposure"
      },
      sessionToken: tokenA
    });
    await application.execute({
      command: "record medication add",
      input: {
        localDate: daysAgo(2),
        medicationName: "鼻喷剂",
        idempotencyKey: "overview-medication"
      },
      sessionToken: tokenA
    });

    const filled = await application.execute({
      command: "record overview",
      sessionToken: tokenA
    });
    const filledData = dataOf<OverviewData>(filled);
    assert.equal(filledData.recentSymptomDate, localToday);
    assert.equal(filledData.consecutiveDays, 3);
    assert.equal(filledData.lastTnss, 8);
    assert.equal(filledData.recentExposureDate, daysAgo(1));
    assert.equal(filledData.recentMedicationDate, daysAgo(2));
    assert.equal(filledData.dataRead, "ok");
    const currentMonth = localToday.slice(0, 7);
    const expectedMonthCount = [localToday, daysAgo(1), daysAgo(2)].filter(
      (day) => day.slice(0, 7) === currentMonth
    ).length;
    assert.equal(filledData.monthRecordCount, expectedMonthCount);
  } finally {
    application.close();
  }
});

test("日历投影按日合并症状、暴露和用药，趋势只读且不填充", async () => {
  const { application, tokenA } = await fixture();
  try {
    const symptom = await application.execute({
      command: "record symptom add",
      input: {
        ...symptomInput,
        localDate: "2026-07-15",
        idempotencyKey: "calendar-symptom"
      },
      sessionToken: tokenA
    });
    const symptomData = dataOf<SymptomRecord>(symptom);

    await application.execute({
      command: "record exposure add",
      input: {
        localDate: "2026-07-15",
        factors: ["pollen"],
        idempotencyKey: "calendar-exposure"
      },
      sessionToken: tokenA
    });
    await application.execute({
      command: "record medication add",
      input: {
        localDate: "2026-07-16",
        medicationName: "鼻喷剂",
        idempotencyKey: "calendar-medication"
      },
      sessionToken: tokenA
    });

    const calendar = await application.execute({
      command: "record calendar",
      input: { month: "2026-07" },
      sessionToken: tokenA
    });
    const calendarData = dataOf<CalendarProjection>(calendar);
    assert.deepEqual(
      calendarData.days.map((day) => day.localDate),
      ["2026-07-15", "2026-07-16"]
    );
    const day15 = calendarData.days.find((day) => day.localDate === "2026-07-15");
    assert.ok(day15 !== undefined);
    assert.equal(day15.symptomId, symptomData.id);
    assert.equal(day15.tnssTotal, 8);
    assert.equal(day15.hasExposure, true);
    assert.equal(day15.hasMedication, false);
    const day16 = calendarData.days.find((day) => day.localDate === "2026-07-16");
    assert.ok(day16 !== undefined);
    assert.equal(day16.symptomId, null);
    assert.equal(day16.hasExposure, false);
    assert.equal(day16.hasMedication, true);

    const badMonth = await application.execute({
      command: "record calendar",
      input: { month: "2026-13" },
      sessionToken: tokenA
    });
    assert.equal(badMonth.ok, false);
    if (!badMonth.ok) {
      assert.equal(badMonth.error.code, "validation_failed");
    }

    const trend = await application.execute({
      command: "record trend",
      input: { from: "2026-07-01", to: "2026-07-31" },
      sessionToken: tokenA
    });
    const trendData = dataOf<TrendProjection>(trend);
    assert.deepEqual(
      trendData.items.map((item) => item.localDate),
      ["2026-07-15"]
    );
    assert.equal(trendData.items[0]?.tnssTotal, 8);

    const reversed = await application.execute({
      command: "record trend",
      input: { from: "2026-07-31", to: "2026-07-01" },
      sessionToken: tokenA
    });
    assert.equal(reversed.ok, false);
    if (!reversed.ok) {
      assert.equal(reversed.error.code, "validation_failed");
    }

    const emptyRange = await application.execute({
      command: "record trend",
      input: { from: "2026-08-01", to: "2026-08-31" },
      sessionToken: tokenA
    });
    const emptyTrend = dataOf<TrendProjection>(emptyRange);
    assert.equal(emptyTrend.items.length, 0);
  } finally {
    application.close();
  }
});
