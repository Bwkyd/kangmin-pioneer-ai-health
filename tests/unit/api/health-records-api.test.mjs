import assert from "node:assert/strict";
import test from "node:test";

import { createHealthRecordsApi } from "../../../lib/health-records/api.ts";
import { InMemoryHealthRecordsRepository } from "../../../lib/health-records/in-memory-repository.ts";
import { createRuntimeHealthIdentityResolver, fixedHealthIdentity, unauthenticatedHealthIdentity } from "../../../lib/health-records/identity.ts";

function request(path, method = "GET", value, headers = {}) {
  return new Request(`http://localhost${path}`, { method, headers: { ...(value === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: value === undefined ? undefined : JSON.stringify(value) });
}
async function result(response) { return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() }; }
const medication = { takenAt: "2026-07-26T08:30:00+08:00", medicationName: "合成测试药物", dosage: { status: "unknown" }, actualUse: { status: "known", description: "患者自述使用一次" } };
const exposure = { date: "2026-07-26", selections: [{ group: "environment", code: "dust_mite" }, { group: "contact", code: "pet_dander" }], otherDescription: null, note: "患者自述当天接触" };

test("身份默认拒绝，x-user-id 和客户端 userId 均不能指定归属", async () => {
  const repository = new InMemoryHealthRecordsRepository();
  const denied = createHealthRecordsApi(repository, unauthenticatedHealthIdentity());
  assert.equal((await result(await denied.listMedications(request("/api/v1/health-records/medications")))).body.error.code, "AUTHENTICATION_REQUIRED");
  const api = createHealthRecordsApi(repository, fixedHealthIdentity("usr_test_owner"));
  assert.equal((await result(await api.listMedications(request("/api/v1/health-records/medications", "GET", undefined, { "x-user-id": "usr_test_attacker" })))).body.error.code, "CLIENT_IDENTITY_FORBIDDEN");
  const injected = await result(await api.createMedication(request("/api/v1/health-records/medications", "POST", { ...medication, userId: "usr_test_attacker" }, { "idempotency-key": "med-injected" })));
  assert.equal(injected.status, 400);
  assert.equal(injected.body.error.code, "CLIENT_IDENTITY_FORBIDDEN");
});

test("合成身份仅在 local/integration 显式配置时启用", async () => {
  const production = createRuntimeHealthIdentityResolver(async () => ({ APP_ENV: "production", HEALTH_IDENTITY_MODE: "synthetic", HEALTH_SYNTHETIC_USER_ID: "usr_test_owner" }));
  assert.equal(await production.resolve(request("/")), null);
  const integration = createRuntimeHealthIdentityResolver(async () => ({ APP_ENV: "integration", HEALTH_IDENTITY_MODE: "synthetic", HEALTH_SYNTHETIC_USER_ID: "usr_test_owner" }));
  assert.deepEqual(await integration.resolve(request("/")), { userId: "usr_test_owner", assurance: "synthetic" });
});

test("用药记录显式保留 unknown、追加历史、幂等重放并阻止旧版本覆盖", async () => {
  const repository = new InMemoryHealthRecordsRepository();
  const api = createHealthRecordsApi(repository, fixedHealthIdentity("usr_test_owner"));
  const created = await result(await api.createMedication(request("/api/v1/health-records/medications", "POST", medication, { "idempotency-key": "med-1" })));
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.record.dosage, { status: "unknown" });
  const replay = await result(await api.createMedication(request("/api/v1/health-records/medications", "POST", medication, { "idempotency-key": "med-1" })));
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal((await result(await api.listMedications(request("/api/v1/health-records/medications")))).body.items.length, 1);
  const reused = await result(await api.createMedication(request("/api/v1/health-records/medications", "POST", { ...medication, medicationName: "另一条记录" }, { "idempotency-key": "med-1" })));
  assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  const updatedInput = { ...medication, actualUse: { status: "unknown" } };
  const updated = await result(await api.updateMedication(request("/", "PATCH", updatedInput, { "if-match": '"1"' }), created.body.record.id));
  assert.equal(updated.body.record.version, 2);
  const conflict = await result(await api.updateMedication(request("/", "PATCH", medication, { "if-match": '"1"' }), created.body.record.id));
  assert.equal(conflict.body.error.code, "VERSION_CONFLICT");
});

test("暴露是诱因唯一事实源，编辑和删除会实时改变档案投影", async () => {
  const repository = new InMemoryHealthRecordsRepository();
  const api = createHealthRecordsApi(repository, fixedHealthIdentity("usr_test_owner"));
  const created = await result(await api.createExposure(request("/api/v1/health-records/exposures", "POST", exposure, { "idempotency-key": "exposure-1" })));
  let profile = await result(await api.getProfile(request("/api/v1/health-records/profile")));
  assert.deepEqual(profile.body.exposureTriggerProjection.map((item) => item.code).sort(), ["dust_mite", "pet_dander"]);
  assert.equal(profile.body.exposureTriggerProjection[0].source, "patient_reported_exposure");
  const changed = { ...exposure, selections: [{ group: "environment", code: "pollen" }] };
  const updated = await result(await api.updateExposure(request("/", "PATCH", changed, { "if-match": '"1"' }), created.body.record.id));
  assert.equal(updated.body.record.version, 2);
  profile = await result(await api.getProfile(request("/api/v1/health-records/profile")));
  assert.deepEqual(profile.body.exposureTriggerProjection.map((item) => item.code), ["pollen"]);
  assert.equal((await api.deleteExposure(request("/", "DELETE", undefined, { "if-match": '"2"' }), created.body.record.id)).status, 204);
  profile = await result(await api.getProfile(request("/api/v1/health-records/profile")));
  assert.deepEqual(profile.body.exposureTriggerProjection, []);
});

test("健康档案接受显式 unknown，但拒绝客户端写入派生诱因", async () => {
  const api = createHealthRecordsApi(new InMemoryHealthRecordsRepository(), fixedHealthIdentity("usr_test_owner"));
  const value = { basicInfo: { displayName: { status: "unknown" }, birthDate: { status: "unknown" }, sex: { status: "unknown" } }, allergyHistory: [{ id: null, allergenName: "尘螨", certainty: "suspected", note: null }], commonTriggers: ["冷空气"] };
  const saved = await result(await api.saveProfile(request("/", "PATCH", value, { "if-match": '"0"' })));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.profile.version, 1);
  assert.deepEqual(saved.body.profile.commonTriggers, ["冷空气"]);
  const derived = await result(await api.saveProfile(request("/", "PATCH", { ...value, triggers: [] }, { "if-match": '"1"' })));
  assert.equal(derived.status, 422);
});

test("与 issue-72 前端契约一致：PUT 档案、allergen-exposures 字段和根响应", async () => {
  const api = createHealthRecordsApi(new InMemoryHealthRecordsRepository(), fixedHealthIdentity("usr_test_owner"));
  const profileDraft = { basicInfo: { displayName: "测试用户", birthDate: "1990-01-02", sex: "female" }, allergyHistory: "尘螨待确认", commonTriggers: ["冷空气"] };
  const saved = await result(await api.saveProfile(request("/api/v1/health-records/profile", "PUT", profileDraft)));
  assert.deepEqual(saved.body.profile.commonTriggers, ["冷空气"]);
  assert.equal(saved.body.profile.allergyHistory, "尘螨待确认");
  const exposureDraft = { date: "2026-07-26", factors: ["花粉", "动物/宠物毛"], otherDescription: "" };
  const created = await result(await api.createExposure(request("/api/v1/health-records/allergen-exposures", "POST", exposureDraft)));
  assert.equal(created.body.record.source, "patient");
  assert.equal(created.body.record.otherDescription, "");
  assert.ok(created.body.record.factors.includes("花粉"));
  const replay = await result(await api.createExposure(request("/api/v1/health-records/allergen-exposures", "POST", exposureDraft)));
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal(replay.body.record.id, created.body.record.id);
  const edited = await result(await api.updateExposure(request("/api/v1/health-records/allergen-exposures/id", "PUT", { ...exposureDraft, factors: ["尘螨"] }), created.body.record.id));
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.record.factors, ["尘螨"]);
  assert.equal((await api.deleteExposure(request("/api/v1/health-records/allergen-exposures/id", "DELETE"), created.body.record.id)).status, 204);
});

test("不同服务端身份不能读取、编辑或删除他人的记录", async () => {
  const repository = new InMemoryHealthRecordsRepository();
  const owner = createHealthRecordsApi(repository, fixedHealthIdentity("usr_test_owner"));
  const other = createHealthRecordsApi(repository, fixedHealthIdentity("usr_test_other"));
  const created = await result(await owner.createMedication(request("/", "POST", medication, { "idempotency-key": "owner-med" })));
  assert.deepEqual((await result(await other.listMedications(request("/")))).body.items, []);
  assert.equal((await result(await other.updateMedication(request("/", "PATCH", medication, { "if-match": '"1"' }), created.body.record.id))).status, 404);
  assert.equal((await result(await other.deleteMedication(request("/", "DELETE", undefined, { "if-match": '"1"' }), created.body.record.id))).status, 404);
});
