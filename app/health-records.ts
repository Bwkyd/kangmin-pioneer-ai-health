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

export type HealthProfile = {
  basicInfo: BasicHealthInfo;
  allergyHistory: string;
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

export type HealthProfileDraft = Pick<HealthProfile, "basicInfo" | "allergyHistory">;
export type AllergenExposureDraft = Pick<AllergenExposure, "date" | "factors" | "otherDescription">;

export type AllergenGroup = {
  name: string;
  options: string[];
};

export const OTHER_ALLERGEN = "其它（请简要描述）";
export const NONE_IDENTIFIED = "未识别到明确因素";

const optionContract = [
  { group: "environment", name: "环境暴露", options: [["pollen", "花粉"], ["dust_mite", "尘螨"], ["mold", "霉菌"], ["dust", "灰尘"], ["smoke", "烟雾"]] },
  { group: "contact", name: "接触性物质", options: [["pet_dander", "宠物皮屑或动物毛"], ["fragrance", "香水或香味产品"], ["cleaning_products", "清洁用品"]] },
  { group: "diet_lifestyle", name: "饮食与作息", options: [["alcohol", "饮酒"], ["spicy_food", "辛辣食物"], ["sleep_deprivation", "睡眠不足"]] },
  { group: "activity", name: "活动相关", options: [["exercise", "运动"], ["cold_air", "冷空气"]] },
  { group: "other", name: "其他", options: [["other", OTHER_ALLERGEN], ["none_identified", NONE_IDENTIFIED]] },
] as const;

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
};

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
  if (!isRecord(data) || !(data.profile === null || isApiProfile(data.profile)) || !Array.isArray(data.triggers) || !data.triggers.every(isTrigger)) {
    throw new HealthRecordsApiError("健康档案接口返回格式不正确", 502);
  }
  if (data.profile === null) return null;
  return normalizeProfile(data.profile, data.triggers);
}

export async function saveHealthProfile(draft: HealthProfileDraft, expectedVersion: number, fetcher: Fetcher = fetch): Promise<HealthProfile> {
  const data = await requestData(fetcher, "/api/v1/health-records/profile", {
    method: "PATCH",
    headers: { "if-match": `"${expectedVersion}"` },
    body: JSON.stringify(profilePayload(draft)),
  });
  if (!isRecord(data) || !isApiProfile(data.profile) || !Array.isArray(data.triggers) || !data.triggers.every(isTrigger)) {
    throw new HealthRecordsApiError("健康档案接口返回格式不正确", 502);
  }
  return normalizeProfile(data.profile, data.triggers);
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
  if (!isRecord(payload) || payload.ok !== true || !("data" in payload)) throw new HealthRecordsApiError("健康记录接口返回格式不正确", 502);
  return payload.data;
}

function profilePayload(draft: HealthProfileDraft) {
  const knowledge = (value: string) => value.trim() ? { status: "known" as const, value: value.trim() } : { status: "unknown" as const };
  return {
    basicInfo: {
      displayName: knowledge(draft.basicInfo.displayName),
      birthDate: knowledge(draft.basicInfo.birthDate),
      sex: draft.basicInfo.sex === "unspecified" ? { status: "unknown" as const } : { status: "known" as const, value: draft.basicInfo.sex },
    },
    allergyHistory: draft.allergyHistory.trim() ? [{ id: null, allergenName: draft.allergyHistory.trim(), certainty: "unknown", note: null }] : [],
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

function normalizeProfile(profile: Record<string, unknown>, triggers: TriggerProjection[]): HealthProfile {
  const basic = profile.basicInfo as Record<string, unknown>;
  const history = profile.allergyHistory as Array<Record<string, unknown>>;
  return {
    basicInfo: {
      displayName: knowledgeValue(basic.displayName),
      birthDate: knowledgeValue(basic.birthDate),
      sex: knowledgeValue(basic.sex) as BasicHealthInfo["sex"] || "unspecified",
    },
    allergyHistory: history.map((item) => String(item.allergenName)).join("、"),
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

function knowledgeValue(value: unknown): string {
  return isRecord(value) && value.status === "known" && typeof value.value === "string" ? value.value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isKnowledge(value: unknown) { return isRecord(value) && (value.status === "unknown" || (value.status === "known" && typeof value.value === "string")); }
function isApiProfile(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isRecord(value.basicInfo) && isKnowledge(value.basicInfo.displayName) && isKnowledge(value.basicInfo.birthDate) && isKnowledge(value.basicInfo.sex) && Array.isArray(value.allergyHistory) && typeof value.version === "number" && typeof value.updatedAt === "string";
}
function isTrigger(value: unknown): value is TriggerProjection {
  return isRecord(value) && typeof value.code === "string" && typeof value.label === "string" && typeof value.group === "string" && typeof value.latestDate === "string" && typeof value.occurrenceCount === "number" && value.source === "patient_reported_exposure" && Array.isArray(value.sourceRecordIds);
}
function isApiExposure(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.id === "string" && typeof value.date === "string" && Array.isArray(value.selections) && value.selections.every((item) => isRecord(item) && typeof item.group === "string" && typeof item.code === "string") && (value.otherDescription === null || typeof value.otherDescription === "string") && typeof value.version === "number" && typeof value.updatedAt === "string";
}
