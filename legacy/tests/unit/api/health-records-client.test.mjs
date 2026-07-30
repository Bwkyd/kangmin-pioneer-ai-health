import assert from "node:assert/strict";
import test from "node:test";

import {
  HealthRecordsApiError,
  NONE_IDENTIFIED,
  OTHER_ALLERGEN,
  allergenGroups,
  getHealthProfile,
  hasCompleteSymptomScores,
  saveAllergenExposure,
  saveHealthProfile,
  saveMedication,
  saveSymptom,
  toggleAllergen,
  validateExposureDraft,
} from "../../../app/health-records.ts";
import { ALLERGEN_GROUPS } from "../../../lib/health-records/domain.ts";

test("过敏原客户端选项与服务端目录保持完整一致", () => {
  assert.deepEqual(
    allergenGroups,
    ALLERGEN_GROUPS.map((group) => ({ name: group.label, options: group.options.map((option) => option.label) })),
  );
});

test("新症状记录保持 unknown，四项均明确选择后才允许保存", () => {
  assert.equal(hasCompleteSymptomScores([null, null, null, null]), false);
  assert.equal(hasCompleteSymptomScores([0, 0, 0, null]), false);
  assert.equal(hasCompleteSymptomScores([0, 0, 0, 0]), true);
  assert.equal(hasCompleteSymptomScores([0, 1, 2, 3]), true);
});

test("过敏原多选保留其它描述，并让未识别因素保持互斥", () => {
  assert.deepEqual(toggleAllergen(["花粉"], "尘螨"), ["花粉", "尘螨"]);
  assert.deepEqual(toggleAllergen(["花粉", "尘螨"], NONE_IDENTIFIED), [NONE_IDENTIFIED]);
  assert.deepEqual(toggleAllergen([NONE_IDENTIFIED], "花粉"), ["花粉"]);
  assert.equal(validateExposureDraft({ date: "2026-07-26", factors: [OTHER_ALLERGEN], otherDescription: "" }), "请补充其它因素的简要描述");
  assert.equal(validateExposureDraft({ date: "2026-07-26", factors: [OTHER_ALLERGEN], otherDescription: "患者自述接触新装修材料" }), null);
});

test("健康档案 PATCH 只提交后端字段并使用服务端身份和版本", async () => {
  let request;
  const fetcher = async (path, init) => {
    request = { path, init };
    return Response.json({
      ok: true,
      data: {
        profile: {
          basicInfo: { displayName: { status: "known", value: "测试用户" }, birthDate: { status: "unknown" }, sex: { status: "unknown" } },
          allergyHistory: [], version: 3, createdAt: "2026-07-26T00:00:00.000Z", updatedAt: "2026-07-26T00:00:00.000Z",
        },
        triggers: [],
      },
    });
  };
  const saved = await saveHealthProfile({ basicInfo: { displayName: "测试用户", birthDate: "", sex: "unspecified" }, allergyHistory: "" }, 2, fetcher);
  assert.equal(saved.version, 3);
  assert.equal(request.path, "/api/v1/health-records/profile");
  assert.equal(request.init.method, "PATCH");
  assert.equal(request.init.credentials, "same-origin");
  assert.equal(request.init.headers["if-match"], '"2"');
  assert.equal(request.init.headers["x-user-id"], undefined);
  const body = JSON.parse(request.init.body);
  assert.deepEqual(Object.keys(body).sort(), ["allergyHistory", "basicInfo"]);
  assert.equal("commonTriggers" in body, false);
});

test("健康档案客户端兼容当前服务端的扁平档案响应", async () => {
  const profile = await getHealthProfile(async () => Response.json({
    profile: {
      basicInfo: { displayName: "体验用户", birthDate: "1992-01-02", sex: "female" },
      allergyHistory: [{ id: "allergy_1", allergenName: "尘螨", certainty: "suspected", note: "既往检查待复核" }],
      allergyHistoryEntries: [{ id: "allergy_1", allergenName: "尘螨", certainty: "suspected", note: "既往检查待复核" }],
      commonTriggers: [],
      version: 1,
      updatedAt: "2026-07-26T00:00:00.000Z",
    },
    exposureTriggerProjection: [],
  }));
  assert.deepEqual(profile.basicInfo, { displayName: "体验用户", birthDate: "1992-01-02", sex: "female" });
  assert.equal(profile.allergyHistory, "尘螨");
  assert.deepEqual(profile.allergyHistoryEntries, [{ id: "allergy_1", allergenName: "尘螨", certainty: "suspected", note: "既往检查待复核" }]);
  assert.deepEqual(profile.commonTriggers, []);
});

test("健康档案未编辑过敏史时保留结构化 certainty、note 和 id", async () => {
  let request;
  await saveHealthProfile({
    basicInfo: { displayName: "体验用户", birthDate: "1992-01-02", sex: "female" },
    allergyHistory: "尘螨",
    allergyHistoryEntries: [{ id: "allergy_1", allergenName: "尘螨", certainty: "suspected", note: "既往检查待复核" }],
  }, 1, async (path, init) => {
    request = { path, init };
    return Response.json({ profile: { basicInfo: { displayName: "体验用户", birthDate: "1992-01-02", sex: "female" }, allergyHistory: [], version: 2, updatedAt: "2026-07-26T00:00:00.000Z" }, exposureTriggerProjection: [] });
  });
  assert.deepEqual(JSON.parse(request.init.body).allergyHistory, [{ id: "allergy_1", allergenName: "尘螨", certainty: "suspected", note: "既往检查待复核" }]);
});

test("暴露创建使用正式字段与幂等键，401 原样失败且不修改输入", async () => {
  const draft = { date: "2026-07-26", factors: ["花粉", "宠物皮屑或动物毛"], otherDescription: "" };
  let request;
  const success = async (path, init) => {
    request = { path, init };
    return Response.json({
      ok: true,
      data: { record: { id: "exposure_1", date: draft.date, selections: [{ group: "environment", code: "pollen" }, { group: "contact", code: "pet_dander" }], otherDescription: null, note: "患者自述当天接触", version: 1, createdAt: "2026-07-26T00:00:00.000Z", updatedAt: "2026-07-26T00:00:00.000Z" } },
    }, { status: 201 });
  };
  const saved = await saveAllergenExposure(draft, null, success);
  assert.deepEqual(saved.factors, draft.factors);
  assert.equal(request.path, "/api/v1/health-records/exposures");
  assert.equal(request.init.method, "POST");
  assert.ok(request.init.headers["idempotency-key"]);
  assert.equal(request.init.headers["x-user-id"], undefined);
  assert.deepEqual(JSON.parse(request.init.body).selections, [{ group: "environment", code: "pollen" }, { group: "contact", code: "pet_dander" }]);

  const before = structuredClone(draft);
  const denied = async () => Response.json({ ok: false, error: { code: "AUTHENTICATION_REQUIRED", message: "保存或查看健康历史前需要完成服务端身份认证" } }, { status: 401 });
  await assert.rejects(() => saveAllergenExposure(draft, null, denied), (error) => error instanceof HealthRecordsApiError && error.status === 401 && /服务端身份认证/.test(error.message));
  assert.deepEqual(draft, before);
});

test("用药客户端提交时间、名称、剂量和实际用量，不发送客户端身份", async () => {
  let request;
  const saved = await saveMedication({ takenAt: "2026-07-26T08:30", medicationName: "氯雷他定", dosageValue: "10", dosageUnit: "mg", dosageUnknown: false, actualUseDescription: "按医嘱服用一次", actualUseUnknown: false }, null, async (path, init) => {
    request = { path, init };
    return Response.json({ record: { id: "med_1", takenAt: "2026-07-26T00:30:00.000Z", medicationName: "氯雷他定", dosage: { status: "known", value: "10", unit: "mg" }, actualUse: { status: "known", description: "按医嘱服用一次" }, version: 1, updatedAt: "2026-07-26T00:30:00.000Z" } }, { status: 201 });
  });
  assert.equal(saved.medicationName, "氯雷他定");
  assert.equal(request.path, "/api/v1/health-records/medications");
  assert.equal(request.init.headers["x-user-id"], undefined);
  const body = JSON.parse(request.init.body);
  assert.match(body.takenAt, /^2026-07-26T\d{2}:30:00\.000Z$/);
  assert.deepEqual(body.dosage, { status: "known", value: "10", unit: "mg" });
  assert.deepEqual(body.actualUse, { status: "known", description: "按医嘱服用一次" });
});

test("症状客户端提交四项评分，并用 If-Match 更新同一日期", async () => {
  let request;
  await saveSymptom({ date: "2026-07-26", scores: { sneezing: 1, rhinorrhea: 1, congestion: 2, itching: 0 } }, { id: "symptom_1", date: "2026-07-26", scores: { sneezing: 0, rhinorrhea: 0, congestion: 0, itching: 0 }, totalScore: 0, version: 2, updatedAt: "2026-07-26T00:00:00.000Z" }, async (path, init) => {
    request = { path, init };
    return Response.json({ record: { id: "symptom_1", date: "2026-07-26", scores: { sneezing: 1, rhinorrhea: 1, congestion: 2, itching: 0 }, totalScore: 4, version: 3, updatedAt: "2026-07-26T00:00:00.000Z" } });
  });
  assert.equal(request.path, "/api/v1/health-records/symptoms/2026-07-26");
  assert.equal(request.init.method, "PUT");
  assert.equal(request.init.headers["if-match"], '"2"');
  assert.deepEqual(JSON.parse(request.init.body).scores, { sneezing: 1, rhinorrhea: 1, congestion: 2, itching: 0 });
});
