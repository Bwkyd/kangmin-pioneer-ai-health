import type { TriState } from "./rules.ts";
import type { RehabMethodCode } from "./rehab-methods.ts";

export const REHAB_METHODS = [
  "nose_three_line_ginger_scrape",
  "gua_sha",
  "finger_pressure_yingxiang",
  "acupoint_massage",
  "ear_acupressure",
  "moxa_dazhui_fengchi",
  "electric_blow_dazhui_fengchi",
] as const satisfies readonly RehabMethodCode[];

export type RehabMethod = (typeof REHAB_METHODS)[number];

export const REHAB_SAFETY_FIELDS = [
  "acuteColdRhinitis",
  "feverOrInfection",
  "acuteAllergicFlare",
  "skinDamageOrInflammation",
  "bleedingRisk",
  "anticoagulantUse",
  "severeChronicDisease",
  "specialPhysicalState",
  "mediumAllergy",
  "lungHeatPattern",
] as const;

export type RehabSafetyField = (typeof REHAB_SAFETY_FIELDS)[number];
export type RehabSafetyAnswers = Record<RehabSafetyField, TriState>;

/**
 * 普通刮痧使用独立的安全字段和规则包，不能复用鼻三线姜刮的风险边界。
 * 字段顺序同时定义了 unknown 补问的优先级：先完成急性发热/感染筛查。
 */
export const GUA_SHA_SAFETY_FIELDS = [
  "feverOrInfection",
  "acuteColdRhinitis",
  "acuteAllergicFlare",
  "lungHeatPattern",
  "skinDamageOrInflammation",
  "skinAllergyAtSite",
  "bleedingRisk",
  "anticoagulantUse",
  "severeChronicDisease",
  "specialPhysicalState",
] as const;

export type GuaShaSafetyField = (typeof GUA_SHA_SAFETY_FIELDS)[number];
export type GuaShaSafetyAnswers = Record<GuaShaSafetyField, TriState>;
export type RehabSafetyFieldForMethod = RehabSafetyField | GuaShaSafetyField;
export type RehabSafetyAnswersForMethod = RehabSafetyAnswers | GuaShaSafetyAnswers;
export type RehabSafetyInput =
  | { method: "gua_sha"; answers: GuaShaSafetyAnswers }
  | { method: Exclude<RehabMethod, "gua_sha">; answers: RehabSafetyAnswers };

export type RehabSafetyResult =
  | {
      status: "clear";
      method: RehabMethod;
      rulePackageVersion: string;
      ruleSource: string;
      disclaimer: string;
    }
  | {
      status: "blocked";
      method: RehabMethod;
      blockedBy: RehabSafetyFieldForMethod[];
      blockedReasons: string[];
      rulePackageVersion: string;
      ruleSource: string;
      disclaimer: string;
    }
  | {
      status: "need_more_information";
      method: RehabMethod;
      nextQuestions: RehabSafetyFieldForMethod[];
      nextQuestionPrompts: string[];
      rulePackageVersion: string;
      ruleSource: string;
      disclaimer: string;
    };

export const REHAB_RULE_PACKAGE_VERSION = "rehab-safety-v1";
export const REHAB_RULE_SOURCE = "客户临床待确认资料 · Issue #88–#91";
export const GUA_SHA_RULE_PACKAGE_VERSION = "gua-sha-safety-v1";
export const GUA_SHA_RULE_SOURCE = "客户临床待确认资料 · Issue #94–#96";
export const REHAB_SAFETY_DISCLAIMER = "这是居家健康管理的安全筛查，不是诊断；正式方案需使用当前已审核内容，并以医生意见为准。";

const REHAB_SAFETY_FIELD_LABELS: Readonly<Record<RehabSafetyField, string>> = {
  acuteColdRhinitis: "感冒引起的急性鼻炎或正在发热",
  feverOrInfection: "发热、感染或明显头痛",
  acuteAllergicFlare: "严重过敏性鼻炎急性发作",
  skinDamageOrInflammation: "操作部位破损、感染、炎症、湿疹或疱疹",
  bleedingRisk: "血小板减少、血友病或严重贫血等出血风险",
  anticoagulantUse: "正在使用抗凝或影响出血风险的药物",
  severeChronicDisease: "严重心脑血管、肝肾等慢性疾病",
  specialPhysicalState: "过饱、过饿、过渴、过劳、醉酒、孕期或经期",
  mediumAllergy: "对姜、油、乳液等操作介质过敏",
  lungHeatPattern: "鼻涕黄稠、口干怕热或已知肺经蕴热",
};

const GUA_SHA_SAFETY_FIELD_LABELS: Readonly<Record<GuaShaSafetyField, string>> = {
  feverOrInfection: "发热、感染或明显头痛",
  acuteColdRhinitis: "感冒引起的急性鼻炎或正在发热",
  acuteAllergicFlare: "严重过敏性鼻炎急性发作",
  lungHeatPattern: "鼻涕黄稠、口干怕热或已知肺经蕴热",
  skinDamageOrInflammation: "操作部位破损、感染、炎症、湿疹或疱疹",
  skinAllergyAtSite: "操作部位过敏或皮疹",
  bleedingRisk: "血小板减少、血友病或严重贫血等出血风险",
  anticoagulantUse: "正在使用抗凝或影响出血风险的药物",
  severeChronicDisease: "严重心脑血管、肝肾等慢性疾病",
  specialPhysicalState: "过饱、过饿、过渴、过劳、醉酒、孕期或经期",
};

function evaluateByFields(
  method: RehabMethod,
  answers: RehabSafetyAnswersForMethod,
  fields: readonly RehabSafetyFieldForMethod[],
  labels: Readonly<Record<string, string>>,
  rulePackageVersion: string,
  ruleSource: string,
): RehabSafetyResult {
  const answerMap = answers as Record<string, TriState>;
  const blockedBy = fields.filter((field) => answerMap[field] === "yes");
  if (blockedBy.length > 0) {
    return {
      status: "blocked",
      method,
      blockedBy,
      blockedReasons: blockedBy.map((field) => labels[field] ?? field),
      rulePackageVersion,
      ruleSource,
      disclaimer: REHAB_SAFETY_DISCLAIMER,
    };
  }
  const nextQuestions = fields.filter((field) => answerMap[field] === "unknown");
  if (nextQuestions.length > 0) {
    return {
      status: "need_more_information",
      method,
      nextQuestions,
      nextQuestionPrompts: nextQuestions.map((field) => labels[field] ?? field),
      rulePackageVersion,
      ruleSource,
      disclaimer: REHAB_SAFETY_DISCLAIMER,
    };
  }
  return { status: "clear", method, rulePackageVersion, ruleSource, disclaimer: REHAB_SAFETY_DISCLAIMER };
}

export function evaluateRehabSafety(method: RehabMethod, answers: RehabSafetyAnswersForMethod): RehabSafetyResult {
  if (method === "gua_sha") {
    return evaluateByFields(
      method,
      answers,
      GUA_SHA_SAFETY_FIELDS,
      GUA_SHA_SAFETY_FIELD_LABELS,
      GUA_SHA_RULE_PACKAGE_VERSION,
      GUA_SHA_RULE_SOURCE,
    );
  }

  return evaluateByFields(
    method,
    answers,
    REHAB_SAFETY_FIELDS,
    REHAB_SAFETY_FIELD_LABELS,
    REHAB_RULE_PACKAGE_VERSION,
    REHAB_RULE_SOURCE,
  );
}

export function isRehabMethod(value: unknown): value is RehabMethod {
  return typeof value === "string" && (REHAB_METHODS as readonly string[]).includes(value);
}
