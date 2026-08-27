import { DomainError } from "../../kernel/errors.js";

/**
 * 暴露因素固定词汇表，移植自 legacy/lib/health-records/domain.ts。
 * 患者只能从固定列表选择，不允许自由填写新因素。
 */
export const ALLERGEN_FACTORS = [
  "pollen",
  "dust_mite",
  "mold",
  "dust",
  "smoke",
  "air_pollution",
  "pet_dander",
  "fragrance",
  "cleaning_products",
  "cosmetics",
  "metal_latex",
  "alcohol",
  "spicy_food",
  "sleep_deprivation",
  "specific_food",
  "exercise",
  "cold_air",
  "outdoor_activity",
  "cleaning_bedding",
  "work_study_place",
  "other",
  "none_identified"
] as const;

export type AllergenFactor = (typeof ALLERGEN_FACTORS)[number];

export const OTHER_FACTOR = "other";
export const NONE_IDENTIFIED_FACTOR = "none_identified";

const FACTOR_SET = new Set<string>(ALLERGEN_FACTORS);

export const SEX_OPTIONS = ["female", "male", "other", "unspecified"] as const;
export type Sex = (typeof SEX_OPTIONS)[number];

export function sexOf(value: unknown): Sex {
  if (typeof value === "string" && SEX_OPTIONS.includes(value as Sex)) {
    return value as Sex;
  }
  throw new DomainError(
    "validation_failed",
    "性别必须是 female、male、other 或 unspecified",
    { details: { field: "sex" } }
  );
}

/**
 * 校验患者自述暴露因素组合，规则移植自 legacy 的 validateExposureDraft：
 * - 至少选择一个因素；
 * - 只能选择固定词汇；
 * - "未识别到明确因素" 与具体因素互斥；
 * - 选择 "其它" 必须提供简要描述；
 * - 提供了 "其它" 描述但没有选择 "其它" 因素时拒绝。
 */
export function validateFactors(
  factors: readonly string[],
  otherDescription: string | null | undefined
): void {
  if (factors.length === 0) {
    throw new DomainError(
      "validation_failed",
      "至少选择一项患者自述暴露因素"
    );
  }
  if (new Set(factors).size !== factors.length) {
    throw new DomainError(
      "validation_failed",
      "暴露因素不能重复"
    );
  }
  const unsupported = factors.filter((factor) => !FACTOR_SET.has(factor));
  if (unsupported.length > 0) {
    throw new DomainError(
      "validation_failed",
      "包含不支持的暴露因素",
      { details: { factors: unsupported } }
    );
  }
  if (
    factors.includes(NONE_IDENTIFIED_FACTOR) &&
    factors.length > 1
  ) {
    throw new DomainError(
      "validation_failed",
      "未识别到明确因素不能与其它选项同时选择"
    );
  }
  const description = otherDescription?.trim() ?? "";
  if (factors.includes(OTHER_FACTOR) && description === "") {
    throw new DomainError(
      "validation_failed",
      "选择“其它”因素时需补充简要描述"
    );
  }
  if (!factors.includes(OTHER_FACTOR) && description !== "") {
    throw new DomainError(
      "validation_failed",
      "请先选择“其它”因素再填写描述"
    );
  }
}
