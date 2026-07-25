import { ALLERGEN_GROUPS } from "../lib/health-records/domain.ts";

export type BasicHealthInfo = {
  displayName: string;
  birthDate: string;
  sex: "female" | "male" | "other" | "unspecified";
};

export type TriggerProjection = {
  code: string;
  label: string;
  group: string;
  latestDate: string;
  occurrenceCount: number;
  source: "patient_reported_exposure";
  sourceRecordIds: string[];
};

export type AllergyHistoryEntry = {
  id: string;
  allergenName: string;
  certainty: "confirmed" | "suspected" | "unknown";
  note: string | null;
};

export type HealthProfile = {
  basicInfo: BasicHealthInfo;
  allergyHistory: string;
  allergyHistoryEntries: AllergyHistoryEntry[];
  commonTriggers: TriggerProjection[];
  version: number;
  updatedAt: string;
};

export type AllergenExposure = {
  id: string;
  date: string;
  factors: string[];
  otherDescription: string;
  source: "patient";
  version: number;
  updatedAt: string;
};

export type HealthProfileDraft = Pick<HealthProfile, "basicInfo" | "allergyHistory"> & { allergyHistoryEntries?: AllergyHistoryEntry[] };
export type AllergenExposureDraft = Pick<AllergenExposure, "date" | "factors" | "otherDescription">;

export type MedicationRecord = {
  id: string;
  takenAt: string;
  medicationName: string;
  dosage: { status: "known"; value: string; unit: string } | { status: "unknown" };
  actualUse: { status: "known"; description: string } | { status: "unknown" };
  version: number;
  updatedAt: string;
};

export type MedicationDraft = {
  takenAt: string;
  medicationName: string;
  dosageValue: string;
  dosageUnit: string;
  dosageUnknown: boolean;
  actualUseDescription: string;
  actualUseUnknown: boolean;
};

export type SymptomRecord = {
  id: string;
  date: string;
  scores: { sneezing: number; rhinorrhea: number; congestion: number; itching: number };
  totalScore: number;
  version: number;
  updatedAt: string;
};

export type SymptomDraft = Pick<SymptomRecord, "date" | "scores">;
export type SymptomScoreDraft = [number | null, number | null, number | null, number | null];

export type AllergenGroup = {
  name: string;
  options: string[];
};

export const OTHER_ALLERGEN = "其它（请简要描述）";
export const NONE_IDENTIFIED = "未识别到明确因素";

const optionContract = ALLERGEN_GROUPS.map((group) => ({
  group: group.code,
  name: group.label,
  options: group.options.map((option) => [option.code, option.label] as const),
}));

export const allergenGroups: AllergenGroup[] = optionContract.map((group) => ({
  name: group.name,
  options: group.options.map(([, label]) => label),
}));

const optionByLabel = new Map(
  optionContract.flatMap((group) => group.options.map(([code, label]) => [label, { group: group.group, code }] as const)),
);
const labelByCode = new Map(
  optionContract.flatMap((group) => group.options.map(([code, label]) => [code, label] as const)),
);

export const emptyHealthProfile: HealthProfileDraft = {
  basicInfo: { displayName: "", birthDate: "", sex: "unspecified" },
  allergyHistory: "",
  allergyHistoryEntries: [],
};

export const emptyMedication: MedicationDraft = {
  takenAt: "",
  medicationName: "",
  dosageValue: "",
  dosageUnit: "",
  dosageUnknown: false,
  actualUseDescription: "",
  actualUseUnknown: false,
};

export const emptySymptomScores: SymptomScoreDraft = [null, null, null, null];

export function hasCompleteSymptomScores(scores: readonly (number | null)[]): scores is [number, number, number, number] {
  return scores.length === 4 && scores.every((score) => Number.isInteger(score) && score !== null && score >= 0 && score <= 3);
}

type Fetcher = typeof fetch;

export class HealthRecordsApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HealthRecordsApiError";
    this.status = status;
  }
}

export function toggleAllergen(current: string[], option: string): string[] {
  if (option === NONE_IDENTIFIED) return current.includes(option) ? [] : [option];
  const withoutUnknown = current.filter((item) => item !== NONE_IDENTIFIED);
  return withoutUnknown.includes(option)
    ? withoutUnknown.filter((item) => item !== option)
    : [...withoutUnknown, option];
}

export function validateExposureDraft(draft: AllergenExposureDraft): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) return "请选择记录日期";
  if (draft.factors.length === 0) return "请至少选择一项患者自述因素";
  if (draft.factors.includes(OTHER_ALLERGEN) && !draft.otherDescription.trim()) return "请补充其它因素的简要描述";
  if (!draft.factors.includes(OTHER_ALLERGEN) && draft.otherDescription.trim()) return "请先选择其它因素再填写描述";
  if (draft.factors.includes(NONE_IDENTIFIED) && draft.factors.length > 1) return "未识别到明确因素不能与其它选项同时选择";
  if (draft.factors.some((factor) => !optionByLabel.has(factor))) return "包含后端不支持的过敏原选项";
  return null;
}

export function upsertExposure(current: AllergenExposure[], record: AllergenExposure): AllergenExposure[] {
  return current.some((item) => item.id === record.id)
    ? current.map((item) => (item.id === record.id ? record : item))
    : [record, ...current];
}

export function localDateValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function getHealthProfile(fetcher: Fetcher = fetch): Promise<HealthProfile | null> {
  const data = await requestData(fetcher, "/api/v1/health-records/profile", { method: "GET" });
  const triggers = isRecord(data) ? data.exposureTriggerProjection ?? data.triggers : null;
  if (!isRecord(data) || !(data.profile === null || isApiProfile(data.profile)) || !Array.isArray(triggers) || !triggers.every(isTrigger)) {
    throw new HealthRecordsApiError("健康档案接口返回格式不正确", 502);
  }
  if (data.profile === null) return null;
  return normalizeProfile(data.profile, triggers);
}

export async function saveHealthProfile(draft: HealthProfileDraft, expectedVersion: number, fetcher: Fetcher = fetch): Promise<HealthProfile> {
  const data = await requestData(fetcher, "/api/v1/health-records/profile", {
    method: "PATCH",
    headers: { "if-match": `"${expectedVersion}"` },
    body: JSON.stringify(profilePayload(draft)),
  });
  const triggers = isRecord(data) ? data.exposureTriggerProjection ?? data.triggers : null;
  if (!isRecord(data) || !isApiProfile(data.profile) || !Array.isArray(triggers) || !triggers.every(isTrigger)) {
    throw new HealthRecordsApiError("健康档案接口返回格式不正确", 502);
  }
  return normalizeProfile(data.profile, triggers);
}

export async function listAllergenExposures(fetcher: Fetcher = fetch): Promise<AllergenExposure[]> {
  const data = await requestData(fetcher, "/api/v1/health-records/exposures", { method: "GET" });
  if (!isRecord(data) || !Array.isArray(data.items) || !data.items.every(isApiExposure)) {
    throw new HealthRecordsApiError("过敏原记录接口返回格式不正确", 502);
  }
  return data.items.map(normalizeExposure);
}

export async function saveAllergenExposure(draft: AllergenExposureDraft, current: AllergenExposure | null, fetcher: Fetcher = fetch): Promise<AllergenExposure> {
  const validation = validateExposureDraft(draft);
  if (validation) throw new HealthRecordsApiError(validation, 422);
  const headers: Record<string, string> = current
    ? { "if-match": `"${current.version}"` }
    : { "idempotency-key": crypto.randomUUID() };
  const data = await requestData(
    fetcher,
    current ? `/api/v1/health-records/exposures/${encodeURIComponent(current.id)}` : "/api/v1/health-records/exposures",
    { method: current ? "PATCH" : "POST", headers, body: JSON.stringify(exposurePayload(draft)) },
  );
  if (!isRecord(data) || !isApiExposure(data.record)) throw new HealthRecordsApiError("过敏原记录接口返回格式不正确", 502);
  return normalizeExposure(data.record);
}

export async function deleteAllergenExposure(record: AllergenExposure, fetcher: Fetcher = fetch): Promise<void> {
  await requestData(fetcher, `/api/v1/health-records/exposures/${encodeURIComponent(record.id)}`, {
    method: "DELETE",
    headers: { "if-match": `"${record.version}"` },
  });
}

export async function listMedications(fetcher: Fetcher = fetch): Promise<MedicationRecord[]> {
  const data = await requestData(fetcher, "/api/v1/health-records/medications", { method: "GET" });
  if (!isRecord(data) || !Array.isArray(data.items) || !data.items.every(isApiMedication)) throw new HealthRecordsApiError("用药记录接口返回格式不正确", 502);
  return data.items.map(normalizeMedication);
}

export async function saveMedication(draft: MedicationDraft, current: MedicationRecord | null, fetcher: Fetcher = fetch): Promise<MedicationRecord> {
  const payload = medicationPayload(draft);
  const data = await requestData(fetcher, current ? `/api/v1/health-records/medications/${encodeURIComponent(current.id)}` : "/api/v1/health-records/medications", {
    method: current ? "PATCH" : "POST",
    headers: current ? { "if-match": `"${current.version}"` } : { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(payload),
  });
  if (!isRecord(data) || !isApiMedication(data.record)) throw new HealthRecordsApiError("用药记录接口返回格式不正确", 502);
  return normalizeMedication(data.record);
}

export async function deleteMedication(record: MedicationRecord, fetcher: Fetcher = fetch): Promise<void> {
  await requestData(fetcher, `/api/v1/health-records/medications/${encodeURIComponent(record.id)}`, {
    method: "DELETE",
    headers: { "if-match": `"${record.version}"` },
  });
}

export async function listSymptoms(fetcher: Fetcher = fetch): Promise<SymptomRecord[]> {
  const data = await requestData(fetcher, "/api/v1/health-records/symptoms", { method: "GET" });
  if (!isRecord(data) || !Array.isArray(data.items) || !data.items.every(isApiSymptom)) throw new HealthRecordsApiError("症状记录接口返回格式不正确", 502);
  return data.items.map(normalizeSymptom);
}

export async function saveSymptom(draft: SymptomDraft, current: SymptomRecord | null, fetcher: Fetcher = fetch): Promise<SymptomRecord> {
  const data = await requestData(fetcher, `/api/v1/health-records/symptoms/${encodeURIComponent(draft.date)}`, {
    method: "PUT",
    headers: current ? { "if-match": `"${current.version}"` } : undefined,
    body: JSON.stringify({ scores: draft.scores }),
  });
  if (!isRecord(data) || !isApiSymptom(data.record)) throw new HealthRecordsApiError("症状记录接口返回格式不正确", 502);
  return normalizeSymptom(data.record);
}

async function requestData(fetcher: Fetcher, path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(path, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
  } catch {
    throw new HealthRecordsApiError("健康记录服务暂时无法连接，当前输入没有保存", 0);
  }
  if (response.status === 204) return null;
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const backendMessage = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string" ? payload.error.message : null;
    const fallback = response.status === 404 ? "健康记录接口不存在或记录不可用，当前输入没有保存" : `健康记录服务返回 HTTP ${response.status}，当前输入没有保存`;
    throw new HealthRecordsApiError(backendMessage ?? fallback, response.status);
  }
  if (!isRecord(payload) || payload.ok === false) throw new HealthRecordsApiError("健康记录接口返回格式不正确", 502);
  return payload.ok === true && "data" in payload ? payload.data : payload;
}

function profilePayload(draft: HealthProfileDraft) {
  const knowledge = (value: string) => value.trim() ? { status: "known" as const, value: value.trim() } : { status: "unknown" as const };
  return {
    basicInfo: {
      displayName: knowledge(draft.basicInfo.displayName),
      birthDate: knowledge(draft.basicInfo.birthDate),
      sex: draft.basicInfo.sex === "unspecified" ? { status: "unknown" as const } : { status: "known" as const, value: draft.basicInfo.sex },
    },
    allergyHistory: draft.allergyHistoryEntries !== undefined
      ? draft.allergyHistoryEntries.map((entry) => ({ ...entry }))
      : draft.allergyHistory.trim() ? [{ id: null, allergenName: draft.allergyHistory.trim(), certainty: "unknown" as const, note: null }] : [],
  };
}

function exposurePayload(draft: AllergenExposureDraft) {
  return {
    date: draft.date,
    selections: draft.factors.map((label) => optionByLabel.get(label)),
    otherDescription: draft.factors.includes(OTHER_ALLERGEN) ? draft.otherDescription.trim() : null,
    note: "患者自述当天接触",
  };
}

function medicationPayload(draft: MedicationDraft) {
  const takenAt = draft.takenAt ? new Date(draft.takenAt).toISOString() : "";
  return {
    takenAt,
    medicationName: draft.medicationName.trim(),
    dosage: draft.dosageUnknown ? { status: "unknown" as const } : { status: "known" as const, value: draft.dosageValue.trim(), unit: draft.dosageUnit.trim() },
    actualUse: draft.actualUseUnknown ? { status: "unknown" as const } : { status: "known" as const, description: draft.actualUseDescription.trim() },
  };
}

function normalizeProfile(profile: Record<string, unknown>, triggers: TriggerProjection[]): HealthProfile {
  const basic = profile.basicInfo as Record<string, unknown>;
  const history = profile.allergyHistory;
  const historyEntries = Array.isArray(profile.allergyHistoryEntries)
    ? profile.allergyHistoryEntries.filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.id === "string" && typeof item.allergenName === "string" && (item.certainty === "confirmed" || item.certainty === "suspected" || item.certainty === "unknown") && (item.note === null || typeof item.note === "string")).map((item) => ({ id: item.id, allergenName: item.allergenName, certainty: item.certainty as AllergyHistoryEntry["certainty"], note: item.note as string | null }))
    : Array.isArray(history)
      ? history.filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.id === "string" && typeof item.allergenName === "string" && (item.certainty === "confirmed" || item.certainty === "suspected" || item.certainty === "unknown") && (item.note === null || typeof item.note === "string")).map((item) => ({ id: item.id, allergenName: item.allergenName, certainty: item.certainty as AllergyHistoryEntry["certainty"], note: item.note as string | null }))
      : [];
  return {
    basicInfo: {
      displayName: textValue(basic.displayName),
      birthDate: textValue(basic.birthDate),
      sex: (textValue(basic.sex) as BasicHealthInfo["sex"]) || "unspecified",
    },
    allergyHistory: Array.isArray(history)
      ? history.map((item) => isRecord(item) ? String(item.allergenName ?? "") : "").filter(Boolean).join("、")
      : typeof history === "string" ? history : "",
    allergyHistoryEntries: historyEntries,
    commonTriggers: triggers,
    version: Number(profile.version),
    updatedAt: String(profile.updatedAt),
  };
}

function normalizeExposure(value: Record<string, unknown>): AllergenExposure {
  const selections = value.selections as Array<Record<string, unknown>>;
  return {
    id: String(value.id), date: String(value.date),
    factors: selections.map((item) => labelByCode.get(String(item.code)) ?? String(item.code)),
    otherDescription: typeof value.otherDescription === "string" ? value.otherDescription : "",
    source: "patient", version: Number(value.version), updatedAt: String(value.updatedAt),
  };
}

function normalizeMedication(value: Record<string, unknown>): MedicationRecord {
  return {
    id: String(value.id), takenAt: String(value.takenAt), medicationName: String(value.medicationName),
    dosage: isRecord(value.dosage) && value.dosage.status === "known" ? { status: "known", value: String(value.dosage.value), unit: String(value.dosage.unit) } : { status: "unknown" },
    actualUse: isRecord(value.actualUse) && value.actualUse.status === "known" ? { status: "known", description: String(value.actualUse.description) } : { status: "unknown" },
    version: Number(value.version), updatedAt: String(value.updatedAt),
  };
}

function normalizeSymptom(value: Record<string, unknown>): SymptomRecord {
  const scores = value.scores as Record<string, unknown>;
  return {
    id: String(value.id), date: String(value.date),
    scores: { sneezing: Number(scores.sneezing), rhinorrhea: Number(scores.rhinorrhea), congestion: Number(scores.congestion), itching: Number(scores.itching) },
    totalScore: Number(value.totalScore), version: Number(value.version), updatedAt: String(value.updatedAt),
  };
}

function knowledgeValue(value: unknown): string {
  return isRecord(value) && value.status === "known" && typeof value.value === "string" ? value.value : "";
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : knowledgeValue(value);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isKnowledge(value: unknown) { return isRecord(value) && (value.status === "unknown" || (value.status === "known" && typeof value.value === "string")); }
function isKnowledgeOrText(value: unknown) { return typeof value === "string" || isKnowledge(value); }
function isApiProfile(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isRecord(value.basicInfo) && isKnowledgeOrText(value.basicInfo.displayName) && isKnowledgeOrText(value.basicInfo.birthDate) && isKnowledgeOrText(value.basicInfo.sex) && (Array.isArray(value.allergyHistory) || typeof value.allergyHistory === "string") && typeof value.version === "number" && typeof value.updatedAt === "string";
}
function isTrigger(value: unknown): value is TriggerProjection {
  return isRecord(value) && typeof value.code === "string" && typeof value.label === "string" && typeof value.group === "string" && typeof value.latestDate === "string" && typeof value.occurrenceCount === "number" && value.source === "patient_reported_exposure" && Array.isArray(value.sourceRecordIds);
}
function isApiExposure(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.id === "string" && typeof value.date === "string" && Array.isArray(value.selections) && value.selections.every((item) => isRecord(item) && typeof item.group === "string" && typeof item.code === "string") && (value.otherDescription === null || typeof value.otherDescription === "string") && typeof value.version === "number" && typeof value.updatedAt === "string";
}
function isApiMedication(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.id === "string" && typeof value.takenAt === "string" && typeof value.medicationName === "string" && isRecord(value.dosage) && (value.dosage.status === "unknown" || (value.dosage.status === "known" && typeof value.dosage.value === "string" && typeof value.dosage.unit === "string")) && isRecord(value.actualUse) && (value.actualUse.status === "unknown" || (value.actualUse.status === "known" && typeof value.actualUse.description === "string")) && typeof value.version === "number" && typeof value.updatedAt === "string";
}
function isApiSymptom(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.id === "string" && typeof value.date === "string" && isRecord(value.scores) && ["sneezing", "rhinorrhea", "congestion", "itching"].every((key) => typeof value.scores[key] === "number") && typeof value.totalScore === "number" && typeof value.version === "number" && typeof value.updatedAt === "string";
}
