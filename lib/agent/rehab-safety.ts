import type { TriState } from "./rules.ts";

export const REHAB_METHODS = [
  "nose_three_line_ginger_scrape",
  "finger_pressure_yingxiang",
  "acupoint_massage",
  "ear_acupressure",
  "moxa_or_blow_dazhui",
] as const;

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

export type RehabSafetyResult =
  | {
      status: "clear";
      method: RehabMethod;
      rulePackageVersion: string;
      disclaimer: string;
    }
  | {
      status: "blocked";
      method: RehabMethod;
      blockedBy: RehabSafetyField[];
      rulePackageVersion: string;
      disclaimer: string;
    }
  | {
      status: "need_more_information";
      method: RehabMethod;
      nextQuestions: RehabSafetyField[];
      rulePackageVersion: string;
      disclaimer: string;
    };

export const REHAB_RULE_PACKAGE_VERSION = "rehab-safety-v1";
export const REHAB_SAFETY_DISCLAIMER = "这是居家健康管理的安全筛查，不是诊断；正式方案需使用当前已审核内容，并以医生意见为准。";

export function evaluateRehabSafety(method: RehabMethod, answers: RehabSafetyAnswers): RehabSafetyResult {
  const blockedBy = REHAB_SAFETY_FIELDS.filter((field) => answers[field] === "yes");
  if (method === "moxa_or_blow_dazhui" && answers.lungHeatPattern === "yes" && !blockedBy.includes("lungHeatPattern")) blockedBy.push("lungHeatPattern");
  if (blockedBy.length > 0) {
    return { status: "blocked", method, blockedBy, rulePackageVersion: REHAB_RULE_PACKAGE_VERSION, disclaimer: REHAB_SAFETY_DISCLAIMER };
  }
  const nextQuestions = REHAB_SAFETY_FIELDS.filter((field) => answers[field] === "unknown");
  if (nextQuestions.length > 0) {
    return { status: "need_more_information", method, nextQuestions, rulePackageVersion: REHAB_RULE_PACKAGE_VERSION, disclaimer: REHAB_SAFETY_DISCLAIMER };
  }
  return { status: "clear", method, rulePackageVersion: REHAB_RULE_PACKAGE_VERSION, disclaimer: REHAB_SAFETY_DISCLAIMER };
}

export function isRehabMethod(value: unknown): value is RehabMethod {
  return typeof value === "string" && (REHAB_METHODS as readonly string[]).includes(value);
}
