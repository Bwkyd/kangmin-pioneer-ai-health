export type Knowledge<T> =
  | { status: "known"; value: T }
  | { status: "unknown" };

export type BasicInfo = {
  displayName: Knowledge<string>;
  birthDate: Knowledge<string>;
  sex: Knowledge<"female" | "male" | "other">;
};

export type AllergyHistoryEntry = {
  id: string;
  allergenName: string;
  certainty: "confirmed" | "suspected" | "unknown";
  note: string | null;
};

export type HealthProfileInput = {
  basicInfo: BasicInfo;
  allergyHistory: AllergyHistoryEntry[];
  commonTriggers: string[];
};

export type HealthProfile = HealthProfileInput & {
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type MedicationInput = {
  takenAt: string;
  medicationName: string;
  dosage:
    | { status: "known"; value: string; unit: string }
    | { status: "unknown" };
  actualUse:
    | { status: "known"; description: string }
    | { status: "unknown" };
};

export type MedicationRecord = MedicationInput & {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type SymptomScores = {
  sneezing: number;
  rhinorrhea: number;
  congestion: number;
  itching: number;
};

export type SymptomRecordInput = {
  date: string;
  scores: SymptomScores;
};

export type SymptomRecord = SymptomRecordInput & {
  id: string;
  totalScore: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export const ALLERGEN_GROUPS = [
  {
    code: "environment",
    label: "环境暴露",
    options: [
      { code: "pollen", label: "花粉" },
      { code: "dust_mite", label: "尘螨" },
      { code: "mold", label: "霉菌" },
      { code: "dust", label: "灰尘" },
      { code: "smoke", label: "烟雾" },
      { code: "air_pollution", label: "空气污染" },
    ],
  },
  {
    code: "contact",
    label: "接触性物质",
    options: [
      { code: "pet_dander", label: "宠物皮屑或动物毛" },
      { code: "fragrance", label: "香水或香味产品" },
      { code: "cleaning_products", label: "清洁用品" },
      { code: "cosmetics", label: "化妆品或护肤品" },
      { code: "metal_latex", label: "金属或乳胶" },
    ],
  },
  {
    code: "diet_lifestyle",
    label: "饮食与作息",
    options: [
      { code: "alcohol", label: "饮酒" },
      { code: "spicy_food", label: "辛辣食物" },
      { code: "sleep_deprivation", label: "睡眠不足" },
      { code: "specific_food", label: "特定食物" },
    ],
  },
  {
    code: "activity",
    label: "活动相关",
    options: [
      { code: "exercise", label: "运动" },
      { code: "cold_air", label: "冷空气" },
      { code: "outdoor_activity", label: "户外活动" },
      { code: "cleaning_bedding", label: "打扫或整理床品" },
      { code: "work_study_place", label: "工作或学习场所" },
    ],
  },
  {
    code: "other",
    label: "其他",
    options: [
      { code: "other", label: "其它（请简要描述）" },
      { code: "none_identified", label: "未识别到明确因素" },
    ],
  },
] as const;

export type AllergenGroupCode = (typeof ALLERGEN_GROUPS)[number]["code"];
export type AllergenOptionCode = (typeof ALLERGEN_GROUPS)[number]["options"][number]["code"];

export type AllergenSelection = {
  group: AllergenGroupCode;
  code: AllergenOptionCode;
};

export type ExposureInput = {
  date: string;
  selections: AllergenSelection[];
  otherDescription: string | null;
  note: string | null;
};

export type ExposureRecord = ExposureInput & {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type TriggerProjection = {
  code: AllergenOptionCode;
  label: string;
  group: AllergenGroupCode;
  latestDate: string;
  occurrenceCount: number;
  source: "patient_reported_exposure";
  sourceRecordIds: string[];
};

export type IdempotentCreate<T> = {
  value: T;
  replayed: boolean;
};

export type HealthRecordErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "CLIENT_IDENTITY_FORBIDDEN"
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "PAYLOAD_TOO_LARGE"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "REQUEST_IN_PROGRESS"
  | "PRECONDITION_REQUIRED"
  | "VERSION_CONFLICT"
  | "NOT_FOUND"
  | "DATABASE_NOT_CONFIGURED"
  | "INTERNAL_ERROR";

export class HealthRecordError extends Error {
  readonly status: number;
  readonly code: HealthRecordErrorCode;
  readonly fields?: Record<string, string>;

  constructor(
    status: number,
    code: HealthRecordErrorCode,
    message: string,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "HealthRecordError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function cleanText(value: unknown, maximum: number) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= maximum ? cleaned : null;
}

function optionalText(value: unknown, maximum: number) {
  if (value === null) return null;
  return cleanText(value, maximum);
}

function validDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

function parseKnowledge<T>(
  value: unknown,
  parseKnown: (known: unknown) => T | null,
): Knowledge<T> | null {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  if (value.status === "unknown" && hasExactKeys(value, ["status"])) return { status: "unknown" };
  if (value.status !== "known" || !hasExactKeys(value, ["status", "value"])) return null;
  const known = parseKnown(value.value);
  return known === null ? null : { status: "known", value: known };
}

export function parseProfileInput(value: unknown): HealthProfileInput | null {
  if (!isRecord(value) || !Object.keys(value).every((key) => ["basicInfo", "allergyHistory"].includes(key)) || !("basicInfo" in value) || !("allergyHistory" in value)) return null;
  if (!isRecord(value.basicInfo) || !hasExactKeys(value.basicInfo, ["displayName", "birthDate", "sex"])) return null;
  const displayName = parseKnowledge(value.basicInfo.displayName, (item) => cleanText(item, 80));
  const birthDate = parseKnowledge(value.basicInfo.birthDate, validDate);
  const sex = parseKnowledge(value.basicInfo.sex, (item) =>
    item === "female" || item === "male" || item === "other" ? item : null,
  );
  if (!displayName || !birthDate || !sex || !Array.isArray(value.allergyHistory) || value.allergyHistory.length > 100) return null;
  const allergyHistory: AllergyHistoryEntry[] = [];
  for (const item of value.allergyHistory) {
    if (!isRecord(item) || !hasExactKeys(item, ["id", "allergenName", "certainty", "note"])) return null;
    const allergenName = cleanText(item.allergenName, 120);
    const note = optionalText(item.note, 500);
    const id = item.id === null ? `allergy_${crypto.randomUUID()}` : cleanText(item.id, 80);
    if (!id || !/^allergy_[A-Za-z0-9_-]+$/.test(id) || !allergenName || (item.note !== null && note === null)) return null;
    if (item.certainty !== "confirmed" && item.certainty !== "suspected" && item.certainty !== "unknown") return null;
    allergyHistory.push({ id, allergenName, certainty: item.certainty, note });
  }
  if (new Set(allergyHistory.map((item) => item.id)).size !== allergyHistory.length) return null;
  // Kept on the internal repository type for migration compatibility. It is
  // never accepted from the client and is no longer an authoritative source.
  return { basicInfo: { displayName, birthDate, sex }, allergyHistory, commonTriggers: [] };
}

function score(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
}

export function parseSymptomRecordInput(value: unknown): SymptomRecordInput | null {
  if (!isRecord(value) || !hasExactKeys(value, ["date", "scores"]) || !isRecord(value.scores) || !hasExactKeys(value.scores, ["sneezing", "rhinorrhea", "congestion", "itching"])) return null;
  const date = validDate(value.date);
  const scores = {
    sneezing: score(value.scores.sneezing),
    rhinorrhea: score(value.scores.rhinorrhea),
    congestion: score(value.scores.congestion),
    itching: score(value.scores.itching),
  };
  if (!date || Object.values(scores).some((item) => item === null)) return null;
  return { date, scores: scores as SymptomScores };
}

export function parseMedicationInput(value: unknown): MedicationInput | null {
  if (!isRecord(value) || !hasExactKeys(value, ["takenAt", "medicationName", "dosage", "actualUse"])) return null;
  const medicationName = cleanText(value.medicationName, 160);
  if (!medicationName || typeof value.takenAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.takenAt)) return null;
  if (!validDate(value.takenAt.slice(0, 10))) return null;
  const takenAt = new Date(value.takenAt);
  if (Number.isNaN(takenAt.valueOf()) || !isRecord(value.dosage) || !isRecord(value.actualUse)) return null;
  let dosage: MedicationInput["dosage"];
  if (value.dosage.status === "unknown" && hasExactKeys(value.dosage, ["status"])) {
    dosage = { status: "unknown" };
  } else if (value.dosage.status === "known" && hasExactKeys(value.dosage, ["status", "value", "unit"])) {
    const dosageValue = cleanText(value.dosage.value, 40);
    const dosageUnit = cleanText(value.dosage.unit, 40);
    if (!dosageValue || !dosageUnit) return null;
    dosage = { status: "known", value: dosageValue, unit: dosageUnit };
  } else return null;
  let actualUse: MedicationInput["actualUse"];
  if (value.actualUse.status === "unknown" && hasExactKeys(value.actualUse, ["status"])) {
    actualUse = { status: "unknown" };
  } else if (value.actualUse.status === "known" && hasExactKeys(value.actualUse, ["status", "description"])) {
    const description = cleanText(value.actualUse.description, 500);
    if (!description) return null;
    actualUse = { status: "known", description };
  } else return null;
  return { takenAt: takenAt.toISOString(), medicationName, dosage, actualUse };
}

const optionLookup = new Map<string, { group: AllergenGroupCode; label: string }>();
for (const group of ALLERGEN_GROUPS) {
  for (const option of group.options) optionLookup.set(option.code, { group: group.code, label: option.label });
}

export function allergenOption(code: string) {
  return optionLookup.get(code);
}

export function parseExposureInput(value: unknown): ExposureInput | null {
  if (!isRecord(value) || !hasExactKeys(value, ["date", "selections", "otherDescription", "note"])) return null;
  const date = validDate(value.date);
  const otherDescription = optionalText(value.otherDescription, 500);
  const note = optionalText(value.note, 1000);
  if (!date || (value.otherDescription !== null && otherDescription === null) || (value.note !== null && note === null)) return null;
  if (!Array.isArray(value.selections) || value.selections.length < 1 || value.selections.length > 30) return null;
  const selections: AllergenSelection[] = [];
  for (const item of value.selections) {
    if (!isRecord(item) || !hasExactKeys(item, ["group", "code"]) || typeof item.group !== "string" || typeof item.code !== "string") return null;
    const option = optionLookup.get(item.code);
    if (!option || option.group !== item.group) return null;
    selections.push({ group: option.group, code: item.code as AllergenOptionCode });
  }
  if (new Set(selections.map((item) => item.code)).size !== selections.length) return null;
  const codes = new Set(selections.map((item) => item.code));
  if (codes.has("none_identified") && codes.size > 1) return null;
  if (codes.has("other") !== Boolean(otherDescription)) return null;
  return { date, selections, otherDescription, note };
}

export function parseExpectedVersion(request: Request) {
  const value = request.headers.get("if-match");
  const match = value?.match(/^(?:W\/)?"?(\d+)"?$/);
  if (!match) throw new HealthRecordError(428, "PRECONDITION_REQUIRED", "请通过 If-Match 提交当前记录版本");
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 0) throw new HealthRecordError(428, "PRECONDITION_REQUIRED", "If-Match 版本无效");
  return version;
}

export function parseDateFilter(request: Request) {
  const date = new URL(request.url).searchParams.get("date");
  if (date === null) return null;
  const parsed = validDate(date);
  if (!parsed) throw new HealthRecordError(400, "INVALID_INPUT", "date 必须是有效的 YYYY-MM-DD 日期");
  return parsed;
}
