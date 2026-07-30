import { SYNDROME_CODES, type SyndromeCode } from "../agent/syndromes.ts";

const BASE_SYNDROME_CODES: readonly SyndromeCode[] = ["LUNG_QI_COLD", "SPLEEN_QI_DEF", "KIDNEY_YANG_DEF", "LUNG_HEAT", "MIXED_COLD_HEAT"];

export type ClinicalCandidateDefinition = {
  code: string;
  label: string;
  issue?: number;
  syndromeCodes?: readonly string[];
  enforceSyndromeCodes?: boolean;
  requiredMethodCode?: string;
  requiredPointGroupCode?: string;
};

export const CLINICAL_CANDIDATE_DEFINITIONS: readonly ClinicalCandidateDefinition[] = [
  {
    code: "base_syndrome_mapping",
    label: "五种证型基础方案映射",
    issue: 92,
    syndromeCodes: BASE_SYNDROME_CODES,
  },
  {
    code: "shared_nose_three_line_ginger_scrape",
    label: "五种证型共同方案：鼻三线姜刮",
    issue: 88,
    syndromeCodes: BASE_SYNDROME_CODES,
    enforceSyndromeCodes: true,
    requiredMethodCode: "nose_three_line_ginger_scrape",
  },
  {
    code: "gua_sha_safety_gate",
    label: "普通刮痧安全门禁（#94–#96）",
    issue: 94,
    requiredMethodCode: "gua_sha",
  },
  {
    code: "shared_finger_pressure_yingxiang",
    label: "五种证型共同方案：指腹擦迎香（速通）",
    issue: 88,
    syndromeCodes: BASE_SYNDROME_CODES,
    enforceSyndromeCodes: true,
    requiredMethodCode: "finger_pressure_yingxiang",
    requiredPointGroupCode: "finger_pressure_yingxiang",
  },
  {
    code: "shared_ear_acupressure",
    label: "五种证型共同方案：耳穴压豆",
    issue: 89,
    syndromeCodes: BASE_SYNDROME_CODES,
    enforceSyndromeCodes: true,
    requiredMethodCode: "ear_acupressure",
    requiredPointGroupCode: "ear_shenmen_subcortex_lung_fengxi",
  },
  {
    code: "lung_qi_cold_acupoint_supplement",
    label: "肺气虚寒型补充穴位方案",
    issue: 90,
    syndromeCodes: ["LUNG_QI_COLD"],
    enforceSyndromeCodes: true,
    requiredMethodCode: "acupoint_massage",
    requiredPointGroupCode: "fengchi_fengmen_feishu_lieque_plus_taiyuan",
  },
  {
    code: "shared_moxa_dazhui_fengchi",
    label: "五种证型共同方案：艾灸大椎、风池",
    issue: 91,
    syndromeCodes: ["LUNG_QI_COLD", "SPLEEN_QI_DEF", "KIDNEY_YANG_DEF", "MIXED_COLD_HEAT"],
    enforceSyndromeCodes: true,
    requiredMethodCode: "moxa_dazhui_fengchi",
    requiredPointGroupCode: "moxa_dazhui_fengchi",
  },
  {
    code: "shared_electric_blow_dazhui_fengchi",
    label: "五种证型共同方案：电吹风吹大椎、风池",
    issue: 91,
    syndromeCodes: ["LUNG_QI_COLD", "SPLEEN_QI_DEF", "KIDNEY_YANG_DEF", "MIXED_COLD_HEAT"],
    enforceSyndromeCodes: true,
    requiredMethodCode: "electric_blow_dazhui_fengchi",
    requiredPointGroupCode: "electric_blow_dazhui_fengchi",
  },
  { code: "back_ten_zone_comorbidity", label: "背十区兼症" },
  { code: "constitution_adjustment", label: "调体" },
  { code: "bloodletting", label: "放血" },
  { code: "pediatric", label: "儿童" },
  { code: "other", label: "其他临床候选" },
];

export type ClinicalCandidateKind = (typeof CLINICAL_CANDIDATE_DEFINITIONS)[number]["code"];

export type SyndromePlanMappingStatus = "mapped" | "no_plan" | "missing";

export type SyndromePlanMapping = {
  syndromeCode: SyndromeCode;
  status: SyndromePlanMappingStatus;
  planId?: string;
  planVersion?: number;
};

function mappingRecords(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

export function normalizeSyndromePlanMappings(value: unknown): SyndromePlanMapping[] {
  const byCode = new Map<SyndromeCode, SyndromePlanMapping>();
  for (const candidate of mappingRecords(value)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const syndromeCode = typeof record.syndromeCode === "string" && SYNDROME_CODES.includes(record.syndromeCode as SyndromeCode)
      ? record.syndromeCode as SyndromeCode
      : null;
    const status = record.status === "mapped" || record.status === "no_plan" || record.status === "missing" ? record.status : null;
    if (!syndromeCode || !status || byCode.has(syndromeCode)) continue;
    const planId = typeof record.planId === "string" ? record.planId.trim().slice(0, 120) : "";
    const planVersion = typeof record.planVersion === "number" && Number.isInteger(record.planVersion) ? record.planVersion : null;
    byCode.set(syndromeCode, status === "mapped" ? { syndromeCode, status, planId, ...(planVersion === null ? {} : { planVersion }) } : { syndromeCode, status });
  }
  return BASE_SYNDROME_CODES.filter((code) => byCode.has(code)).map((code) => byCode.get(code) as SyndromePlanMapping);
}

export function isClinicalCandidateKind(value: unknown): value is ClinicalCandidateKind {
  return typeof value === "string" && CLINICAL_CANDIDATE_DEFINITIONS.some((candidate) => candidate.code === value);
}

export function clinicalCandidateLabel(value: unknown) {
  return CLINICAL_CANDIDATE_DEFINITIONS.find((candidate) => candidate.code === value)?.label ?? null;
}

export function clinicalCandidateDefinition(value: unknown) {
  return CLINICAL_CANDIDATE_DEFINITIONS.find((candidate) => candidate.code === value) ?? null;
}
