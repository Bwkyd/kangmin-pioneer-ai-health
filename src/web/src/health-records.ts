/**
 * 健康记录数据层：保持 legacy/app/health-records.ts 的界面侧类型与函数
 * 签名，底层改为患者命令协议（record * 命令）。乐观锁对应
 * expectedRevision（原 If-Match），幂等创建对应 idempotencyKey
 * （原 Idempotency-Key），删除命令需要 yes:true 显式确认。
 */

import { ALLERGEN_GROUPS, codeToLabel, isKnownLabel, labelToCode } from "./allergens";
import { command } from "./command-client";

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
  legacyCommonTriggers: string[];
  version: number;
  updatedAt: string;
};

export type AllergenExposure = {
  id: string;
  date: string;
  factors: string[];
  otherDescription: string;
  note: string | null;
  source: "patient";
  version: number;
  updatedAt: string;
};

export type HealthProfileDraft = Pick<HealthProfile, "basicInfo" | "allergyHistory"> & { allergyHistoryEntries?: AllergyHistoryEntry[] };
export type AllergenExposureDraft = Pick<AllergenExposure, "date" | "factors" | "otherDescription">;

export type MedicationRecord = {
  id: string;
  /** 服务端按日期记录用药（不含时分）。 */
  takenAt: string;
  medicationName: string;
  dosage: string | null;
  actualUse: string | null;
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

export const allergenGroups: AllergenGroup[] = ALLERGEN_GROUPS.map((group) => ({
  name: group.label,
  options: group.options.map((option) => option.label)
}));

export const emptyHealthProfile: HealthProfileDraft = {
  basicInfo: { displayName: "", birthDate: "", sex: "unspecified" },
  allergyHistory: "",
  allergyHistoryEntries: []
};

export const emptyMedication: MedicationDraft = {
  takenAt: "",
  medicationName: "",
  dosageValue: "",
  dosageUnit: "",
  dosageUnknown: false,
  actualUseDescription: "",
  actualUseUnknown: false
};

export const emptySymptomScores: SymptomScoreDraft = [null, null, null, null];

export function hasCompleteSymptomScores(scores: readonly (number | null)[]): scores is [number, number, number, number] {
  return scores.length === 4 && scores.every((score) => Number.isInteger(score) && score !== null && score >= 0 && score <= 3);
}

export class HealthRecordsApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealthRecordsApiError";
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
  if (draft.factors.some((factor) => !isKnownLabel(factor))) return "包含后端不支持的过敏原选项";
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

// ---- 命令协议 DTO（与 src/modules/record/contracts.ts 对应） ----

interface ProfileDto {
  displayName: string | null;
  birthDate: string | null;
  sex: BasicHealthInfo["sex"];
  allergyHistory: string | null;
  revision: number;
  updatedAt: string | null;
}

interface SymptomDto {
  id: string;
  localDate: string;
  sneezing: number;
  runnyNose: number;
  nasalCongestion: number;
  nasalItching: number;
  tnssTotal: number;
  revision: number;
  updatedAt: string;
}

interface ExposureDto {
  id: string;
  localDate: string;
  factors: string[];
  otherDescription: string | null;
  notes: string | null;
  revision: number;
  updatedAt: string;
}

interface MedicationDto {
  id: string;
  localDate: string;
  medicationName: string;
  dosage: string | null;
  actualUse: string | null;
  revision: number;
  updatedAt: string;
}

function normalizeProfile(dto: ProfileDto): HealthProfile {
  return {
    basicInfo: {
      displayName: dto.displayName ?? "",
      birthDate: dto.birthDate ?? "",
      sex: dto.sex
    },
    allergyHistory: dto.allergyHistory ?? "",
    // 新内核档案为扁平字段：结构化过敏史条目与诱因投影待后续命令提供，
    // 界面按空集合渲染（展示“暂无”而不是伪造数据）。
    allergyHistoryEntries: [],
    commonTriggers: [],
    legacyCommonTriggers: [],
    version: dto.revision,
    updatedAt: dto.updatedAt ?? ""
  };
}

function normalizeSymptom(dto: SymptomDto): SymptomRecord {
  return {
    id: dto.id,
    date: dto.localDate,
    scores: {
      sneezing: dto.sneezing,
      rhinorrhea: dto.runnyNose,
      congestion: dto.nasalCongestion,
      itching: dto.nasalItching
    },
    totalScore: dto.tnssTotal,
    version: dto.revision,
    updatedAt: dto.updatedAt
  };
}

function normalizeExposure(dto: ExposureDto): AllergenExposure {
  return {
    id: dto.id,
    date: dto.localDate,
    factors: dto.factors.map((factor) => codeToLabel(factor)),
    otherDescription: dto.otherDescription ?? "",
    note: dto.notes,
    source: "patient",
    version: dto.revision,
    updatedAt: dto.updatedAt
  };
}

function normalizeMedication(dto: MedicationDto): MedicationRecord {
  return {
    id: dto.id,
    takenAt: dto.localDate,
    medicationName: dto.medicationName,
    dosage: dto.dosage,
    actualUse: dto.actualUse,
    version: dto.revision,
    updatedAt: dto.updatedAt
  };
}

export async function getHealthProfile(): Promise<HealthProfile | null> {
  const profile = await command<ProfileDto>("record profile show");
  // revision 0 表示从未建档，界面按“暂无健康档案”处理。
  if (profile.revision === 0) return null;
  return normalizeProfile(profile);
}

export async function saveHealthProfile(draft: HealthProfileDraft, expectedVersion: number): Promise<HealthProfile> {
  const profile = await command<ProfileDto>("record profile update", {
    expectedRevision: expectedVersion,
    displayName: draft.basicInfo.displayName.trim() || null,
    birthDate: draft.basicInfo.birthDate || null,
    sex: draft.basicInfo.sex,
    allergyHistory: draft.allergyHistory.trim() || null
  });
  return normalizeProfile(profile);
}

export async function listSymptoms(date?: string): Promise<SymptomRecord[]> {
  const { items } = await command<{ items: SymptomDto[] }>("record symptom list");
  const records = items.map(normalizeSymptom);
  return date ? records.filter((record) => record.date === date) : records;
}

export async function saveSymptom(draft: SymptomDraft, current: SymptomRecord | null): Promise<SymptomRecord> {
  const scores = {
    sneezing: draft.scores.sneezing,
    runnyNose: draft.scores.rhinorrhea,
    nasalCongestion: draft.scores.congestion,
    nasalItching: draft.scores.itching
  };
  const dto = current
    ? await command<SymptomDto>("record symptom update", {
        id: current.id,
        expectedRevision: current.version,
        ...scores
      })
    : await command<SymptomDto>("record symptom add", {
        localDate: draft.date,
        ...scores,
        notes: null,
        idempotencyKey: `web-symptom-${draft.date}`
      });
  return normalizeSymptom(dto);
}

export async function listAllergenExposures(): Promise<AllergenExposure[]> {
  const { items } = await command<{ items: ExposureDto[] }>("record exposure list");
  return items.map(normalizeExposure);
}

export async function saveAllergenExposure(
  draft: AllergenExposureDraft,
  current: AllergenExposure | null,
  createIdempotencyKey: string = crypto.randomUUID()
): Promise<AllergenExposure> {
  const validation = validateExposureDraft(draft);
  if (validation) throw new HealthRecordsApiError(validation);
  const factors = draft.factors.map((label) => labelToCode(label) ?? label);
  const otherDescription = draft.factors.includes(OTHER_ALLERGEN)
    ? draft.otherDescription.trim()
    : null;
  const dto = current
    ? await command<ExposureDto>("record exposure update", {
        id: current.id,
        expectedRevision: current.version,
        factors,
        otherDescription
      })
    : await command<ExposureDto>("record exposure add", {
        localDate: draft.date,
        factors,
        otherDescription,
        notes: "患者自述当天接触",
        idempotencyKey: createIdempotencyKey
      });
  return normalizeExposure(dto);
}

export async function deleteAllergenExposure(record: AllergenExposure): Promise<void> {
  await command("record exposure delete", {
    id: record.id,
    expectedRevision: record.version,
    yes: true
  });
}

export async function listMedications(): Promise<MedicationRecord[]> {
  const { items } = await command<{ items: MedicationDto[] }>("record medication list");
  return items.map(normalizeMedication);
}

export async function saveMedication(
  draft: MedicationDraft,
  current: MedicationRecord | null,
  createIdempotencyKey: string = crypto.randomUUID()
): Promise<MedicationRecord> {
  const dosage = draft.dosageUnknown
    ? null
    : `${draft.dosageValue.trim()} ${draft.dosageUnit.trim()}`.trim();
  const actualUse = draft.actualUseUnknown
    ? null
    : draft.actualUseDescription.trim();
  const dto = current
    ? await command<MedicationDto>("record medication update", {
        id: current.id,
        expectedRevision: current.version,
        medicationName: draft.medicationName.trim(),
        dosage,
        actualUse
      })
    : await command<MedicationDto>("record medication add", {
        localDate: draft.takenAt,
        medicationName: draft.medicationName.trim(),
        dosage,
        actualUse,
        notes: null,
        idempotencyKey: createIdempotencyKey
      });
  return normalizeMedication(dto);
}

export async function deleteMedication(record: MedicationRecord): Promise<void> {
  await command("record medication delete", {
    id: record.id,
    expectedRevision: record.version,
    yes: true
  });
}
