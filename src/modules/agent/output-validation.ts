/**
 * 输出校验与固定模板渲染。
 *
 * 硬规则（患者 CLI 设计 §6.4/§13、数据库设计 §4.5）：
 * - 模型/模板输出不得新增穴位、疗程、力度、剂量、禁忌或疗效；
 * - 模型解释只允许搬运规则结果中的字段，任何新增/篡改都被拒绝，
 *   回退到固定模板（规则结果仍然有效）；
 * - assistant 消息只能绑定已完成的 decision，content_hash 必须等于
 *   已校验输出；失败时只允许代码生成的固定 system_notice。
 *
 * 本模块是唯一允许生成患者可见正文的代码路径：
 * 所有输出都从固定模板 + 规则结果字段渲染，模型不写自由文本。
 */

import { createHash } from "node:crypto";

import type {
  ClinicalVerdict,
  RulePackageStatus
} from "../clinical-rules/contracts.js";
import {
  SEVERITY_LABELS,
  SYNDROME_LABELS,
  FIELD_LABELS
} from "../clinical-rules/domain.js";
import type { ExplanationFields } from "./model-ports.js";

export interface ValidatedOutput {
  templateId: string;
  content: string;
  contentHash: string;
  /** 模型提供的字段（校验通过时）；null 表示固定模板回退。 */
  fields: ExplanationFields | null;
}

/** 临床冻结前的正式输出阻断文案（红线）。 */
export const CLINICAL_FREEZE_BLOCK = "当前规则包未完成临床冻结，暂不输出个性化方案。";

const CONFLICT_MESSAGE =
  "您的回答同时符合多个证型特征，当前信息不足以确定证型。本工具不做猜测，请以门诊诊断为准。";
const NO_MATCH_MESSAGE =
  "根据您的回答，未匹配到明确的证型。本工具不做猜测，请以门诊诊断为准。";

/** 补问信息无法取得进展时的 fail-closed 固定文案（unknown 不等于 no）。 */
export const FAIL_CLOSED_SAFETY_NOTICE =
  "关键安全信息您表示无法确认。本工具按最高风险处理：unknown 不等于 no。请立即线下就医确认，本工具暂不提供调理建议。";
export const FAIL_CLOSED_INFO_NOTICE =
  "您对必要问题表示无法确认，当前信息不足，无法继续评估。本工具不做猜测，请以门诊诊断为准。";

/** 模型提取不可用时的固定 system_notice（代码生成，不绑定决策）。 */
export const EXTRACTION_UNAVAILABLE_NOTICE =
  "智能提取服务暂不可用，请直接回答系统提问（如“怕风：是”）。";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 校验模型解释字段：只允许与规则结果完全一致的字段，
 * 任何新增、缺失或篡改都视为非法，返回 null（回退固定模板）。
 */
export function validateExplanationFields(
  fields: ExplanationFields | null,
  verdict: ClinicalVerdict
): ExplanationFields | null {
  if (fields === null) {
    return null;
  }
  if (fields.outcome !== verdict.outcome) {
    return null;
  }
  if ((fields.severityCode ?? null) !== (verdict.severityCode ?? null)) {
    return null;
  }
  if ((fields.syndromeCode ?? null) !== (verdict.syndromeCode ?? null)) {
    return null;
  }
  const modelRules = [...fields.matchedRuleIds].sort();
  const verdictRules = [...verdict.matchedRuleIds].sort();
  if (
    modelRules.length !== verdictRules.length ||
    modelRules.some((rule, index) => rule !== verdictRules[index])
  ) {
    return null;
  }
  if ((fields.message ?? null) !== (verdict.message ?? null)) {
    return null;
  }
  return fields;
}

function questionText(verdict: ClinicalVerdict): string {
  const lines = verdict.nextQuestions.map((question, index) => {
    const label = FIELD_LABELS[question.fieldCode];
    const suffix = label === undefined ? "" : `（${label}）`;
    return `${index + 1}. ${question.prompt}${suffix}`;
  });
  return `为了继续评估，请回答以下问题：\n${lines.join("\n")}`;
}

/**
 * 渲染某次裁决的最终患者可见输出。
 * modelFields 传入时先校验，非法则回退固定模板。
 */
export function renderValidatedOutput(
  verdict: ClinicalVerdict,
  packageStatus: RulePackageStatus,
  modelFields: ExplanationFields | null
): ValidatedOutput {
  const validated = validateExplanationFields(modelFields, verdict);
  const fields = validated;

  switch (verdict.outcome) {
    case "blocked":
      return output("blocked", verdict.message ?? "安全阻断，请线下就医。", fields);
    case "non_applicable":
      return output(
        "non_applicable",
        verdict.message ?? "当前情况不属于本工具适用范围，请线下明确诊断。",
        fields
      );
    case "need_more_information":
      return output("questions", questionText(verdict), fields);
    case "conflict":
      return output("conflict", CONFLICT_MESSAGE, fields);
    case "no_match":
      return output("no_match", NO_MATCH_MESSAGE, fields);
    case "classified": {
      // 临床红线：规则包未 approved 前，正式输出路径一律阻断。
      if (packageStatus !== "approved") {
        return output("clinical_freeze", CLINICAL_FREEZE_BLOCK, fields);
      }
      const severity = SEVERITY_LABELS[verdict.severityCode ?? ""] ?? "未定";
      const syndrome = SYNDROME_LABELS[verdict.syndromeCode ?? ""] ?? "未定";
      const content =
        `根据您的确认：严重度【${severity}】，证型【${syndrome}】。` +
        `本结果由固定规则产生，仅供参考，最终方案请以门诊诊断为准。`;
      return output("classified_summary", content, fields);
    }
  }
}

function output(
  templateId: string,
  content: string,
  fields: ExplanationFields | null
): ValidatedOutput {
  return {
    templateId,
    content,
    contentHash: sha256(content),
    fields
  };
}

/** 固定 system_notice：代码生成的降级提示，不绑定任何决策。 */
export function systemNotice(templateId: string, content: string): ValidatedOutput {
  return output(`system_notice_${templateId}`, content, null);
}
