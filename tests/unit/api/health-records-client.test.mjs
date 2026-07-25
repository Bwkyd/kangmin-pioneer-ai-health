import assert from "node:assert/strict";
import test from "node:test";

import {
  HealthRecordsApiError,
  NONE_IDENTIFIED,
  OTHER_ALLERGEN,
  saveAllergenExposure,
  saveHealthProfile,
  toggleAllergen,
  validateExposureDraft,
} from "../../../app/health-records.ts";

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
