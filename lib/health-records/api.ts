import { ALLERGEN_GROUPS, HealthRecordError, allergenOption, parseDateFilter, parseExpectedVersion, parseExposureInput, parseMedicationInput, parseProfileInput, parseSymptomRecordInput, type ExposureRecord, type HealthProfile } from "./domain.ts";
import { createRuntimeHealthRecordsRepository } from "./d1-repository.ts";
import { createRuntimeHealthIdentityResolver, requireHealthIdentity, type HealthIdentityResolver } from "./identity.ts";
import type { HealthRecordsRepository } from "./repository.ts";

const MAX_BODY = 32_768;

async function body(request: Request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY) throw new HealthRecordError(413, "PAYLOAD_TOO_LARGE", "请求内容过长");
  try { return JSON.parse(text) as unknown; } catch { throw new HealthRecordError(400, "INVALID_JSON", "请求必须是有效 JSON"); }
}

async function hash(value: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function idempotencyKey(request: Request) {
  const key = request.headers.get("idempotency-key")?.trim();
  if (key && key.length <= 120) return key;
  if (key) throw new HealthRecordError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key 不能超过 120 个字符");
  throw new HealthRecordError(400, "IDEMPOTENCY_KEY_REQUIRED", "创建健康记录必须提交 Idempotency-Key");
}

function ok(data: unknown, status = 200, headers?: HeadersInit) { return Response.json(data, { status, headers }); }
function failed(error: unknown) {
  if (error instanceof HealthRecordError) return Response.json({ ok: false, error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } }, { status: error.status });
  return Response.json({ ok: false, error: { code: "INTERNAL_ERROR", message: "健康记录服务暂时不可用" } }, { status: 500 });
}

function profilePayload(profile: HealthProfile | null) {
  if (!profile) return null;
  const known = <T>(value: { status: "known"; value: T } | { status: "unknown" }, fallback: T) => value.status === "known" ? value.value : fallback;
  const legacyCommonTriggers = Array.isArray(profile.commonTriggers)
    ? profile.commonTriggers.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return {
    basicInfo: {
      displayName: known(profile.basicInfo.displayName, ""),
      birthDate: known(profile.basicInfo.birthDate, ""),
      sex: known(profile.basicInfo.sex, "unspecified" as const),
    },
    allergyHistory: profile.allergyHistory.map((item) => item.allergenName).join("、"),
    allergyHistoryEntries: profile.allergyHistory,
    legacyCommonTriggers,
    version: profile.version,
    updatedAt: profile.updatedAt,
  };
}

function profileInput(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const basic = record.basicInfo;
    if (basic && typeof basic === "object" && !Array.isArray(basic) && (typeof record.allergyHistory === "string" || Array.isArray(record.allergyHistoryEntries))) {
      const info = basic as Record<string, unknown>;
      const displayName = typeof info.displayName === "string" && info.displayName.trim() ? { status: "known" as const, value: info.displayName } : { status: "unknown" as const };
      const birthDate = typeof info.birthDate === "string" && info.birthDate ? { status: "known" as const, value: info.birthDate } : { status: "unknown" as const };
      const sex = info.sex === "female" || info.sex === "male" ? { status: "known" as const, value: info.sex } : { status: "unknown" as const };
      const allergyHistory = Array.isArray(record.allergyHistoryEntries)
        ? record.allergyHistoryEntries
        : typeof record.allergyHistory === "string" && record.allergyHistory.trim()
          ? [{ id: null, allergenName: record.allergyHistory, certainty: "unknown", note: null }]
          : [];
      return parseProfileInput({ basicInfo: { displayName, birthDate, sex }, allergyHistory });
    }
  }
  return parseProfileInput(value);
}

const factorAliases: Record<string, { group: string; code: string }> = {
  "动物/宠物毛": { group: "contact", code: "pet_dander" },
  "香水或清洁剂": { group: "contact", code: "cleaning_products" },
  "熬夜或睡眠不足": { group: "diet_lifestyle", code: "sleep_deprivation" },
  "辛辣刺激": { group: "diet_lifestyle", code: "spicy_food" },
  "运动后": { group: "activity", code: "exercise" },
  "烟雾或粉尘": { group: "environment", code: "dust" },
  "其它（请简要描述）": { group: "other", code: "other" },
};
for (const group of ALLERGEN_GROUPS) for (const option of group.options) factorAliases[option.label] = { group: group.code, code: option.code };

function exposureInput(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.factors)) {
      const selections = record.factors.map((factor) => typeof factor === "string" ? factorAliases[factor] : null);
      if (selections.some((item) => !item)) return null;
      return parseExposureInput({ date: record.date, selections, otherDescription: typeof record.otherDescription === "string" && record.otherDescription.trim() ? record.otherDescription : null, note: typeof record.note === "string" && record.note.trim() ? record.note : "患者自述当天接触" });
    }
  }
  return parseExposureInput(value);
}

function exposurePayload(record: ExposureRecord) {
  return { ...record, factors: record.selections.map((item) => allergenOption(item.code)?.label ?? item.code), otherDescription: record.otherDescription ?? "", source: "patient" as const };
}

export function createHealthRecordsApi(repository: HealthRecordsRepository, identity: HealthIdentityResolver) {
  async function authenticated(request: Request) { return (await requireHealthIdentity(request, identity)).userId; }
  return {
    catalog: async (request: Request) => { try { await authenticated(request); return ok({ groups: ALLERGEN_GROUPS }); } catch (error) { return failed(error); } },
    getProfile: async (request: Request) => { try { const userId = await authenticated(request); const snapshot = await repository.getProfileSnapshot(userId); return ok({ profile: profilePayload(snapshot.profile), exposureTriggerProjection: snapshot.triggers }); } catch (error) { return failed(error); } },
    saveProfile: async (request: Request) => { try { const userId = await authenticated(request); const raw = await body(request); if (raw && typeof raw === "object" && "userId" in raw) throw new HealthRecordError(400, "CLIENT_IDENTITY_FORBIDDEN", "userId 不可由客户端指定"); const input = profileInput(raw); if (!input) throw new HealthRecordError(422, "INVALID_INPUT", "健康档案字段不完整或包含无效值；常见诱因只能由过敏原患者自述记录派生"); const current = await repository.getProfile(userId); const version = current ? parseExpectedVersion(request) : request.headers.has("if-match") ? parseExpectedVersion(request) : 0; await repository.saveProfile(userId, version, input); const snapshot = await repository.getProfileSnapshot(userId); return ok({ profile: profilePayload(snapshot.profile), exposureTriggerProjection: snapshot.triggers }); } catch (error) { return failed(error); } },
    listMedications: async (request: Request) => { try { return ok({ items: await repository.listMedications(await authenticated(request)) }); } catch (error) { return failed(error); } },
    createMedication: async (request: Request) => { try { const userId = await authenticated(request); const raw = await body(request); if (raw && typeof raw === "object" && "userId" in raw) throw new HealthRecordError(400, "CLIENT_IDENTITY_FORBIDDEN", "userId 不可由客户端指定"); const input = parseMedicationInput(raw); if (!input) throw new HealthRecordError(422, "INVALID_INPUT", "用药时间、药名、剂量/单位或实际用量字段不完整；未知值必须显式使用 unknown"); const requestHash = await hash(input); const result = await repository.createMedication(userId, idempotencyKey(request), requestHash, input); return ok({ record: result.value }, result.replayed ? 200 : 201, result.replayed ? { "idempotency-replayed": "true" } : undefined); } catch (error) { return failed(error); } },
    updateMedication: async (request: Request, id: string) => { try { const userId = await authenticated(request); const raw = await body(request); const input = parseMedicationInput(raw); if (!input) throw new HealthRecordError(422, "INVALID_INPUT", "用药记录字段不完整或包含无效值"); return ok({ record: await repository.updateMedication(userId, id, parseExpectedVersion(request), input) }); } catch (error) { return failed(error); } },
    deleteMedication: async (request: Request, id: string) => { try { await repository.deleteMedication(await authenticated(request), id, parseExpectedVersion(request)); return new Response(null, { status: 204 }); } catch (error) { return failed(error); } },
    listSymptoms: async (request: Request) => { try { return ok({ items: await repository.listSymptoms(await authenticated(request), parseDateFilter(request)) }); } catch (error) { return failed(error); } },
    saveSymptom: async (request: Request, date: string) => { try { const userId = await authenticated(request); const raw = await body(request); if (raw && typeof raw === "object" && "userId" in raw) throw new HealthRecordError(400, "CLIENT_IDENTITY_FORBIDDEN", "userId 不可由客户端指定"); const input = parseSymptomRecordInput({ date, scores: raw && typeof raw === "object" && !Array.isArray(raw) && "scores" in raw ? (raw as Record<string, unknown>).scores : raw }); if (!input) throw new HealthRecordError(422, "INVALID_INPUT", "症状日期或四项评分无效"); const current = (await repository.listSymptoms(userId, date))[0] ?? null; const version = current ? parseExpectedVersion(request) : request.headers.has("if-match") ? parseExpectedVersion(request) : 0; return ok({ record: await repository.saveSymptom(userId, date, version, input) }); } catch (error) { return failed(error); } },
    listExposures: async (request: Request) => { try { const userId = await authenticated(request); return ok({ items: (await repository.listExposures(userId, parseDateFilter(request))).map(exposurePayload) }); } catch (error) { return failed(error); } },
    createExposure: async (request: Request) => { try { const userId = await authenticated(request); const raw = await body(request); if (raw && typeof raw === "object" && "userId" in raw) throw new HealthRecordError(400, "CLIENT_IDENTITY_FORBIDDEN", "userId 不可由客户端指定"); const input = exposureInput(raw); if (!input) throw new HealthRecordError(422, "INVALID_INPUT", "暴露日期、分组选项或其它描述无效；未识别明确因素不能与其它选项同时提交"); const requestHash = await hash(input); const result = await repository.createExposure(userId, idempotencyKey(request), requestHash, input); return ok({ record: exposurePayload(result.value) }, result.replayed ? 200 : 201, result.replayed ? { "idempotency-replayed": "true" } : undefined); } catch (error) { return failed(error); } },
    updateExposure: async (request: Request, id: string) => { try { const userId = await authenticated(request); const input = exposureInput(await body(request)); if (!input) throw new HealthRecordError(422, "INVALID_INPUT", "过敏原暴露记录字段无效"); const version = parseExpectedVersion(request); return ok({ record: exposurePayload(await repository.updateExposure(userId, id, version, input)) }); } catch (error) { return failed(error); } },
    deleteExposure: async (request: Request, id: string) => { try { const userId = await authenticated(request); const version = parseExpectedVersion(request); await repository.deleteExposure(userId, id, version); return new Response(null, { status: 204 }); } catch (error) { return failed(error); } },
  };
}

export const healthRecordsApi = createHealthRecordsApi(createRuntimeHealthRecordsRepository(), createRuntimeHealthIdentityResolver());
