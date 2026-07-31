/**
 * 确定性结构化问答解析（模型降级路径）。
 *
 * 服务端规则是 nextQuestions 的唯一来源；患者对补问的回答
 * 用本解析器从自然语言中提取，不经过模型（模型无权决定临床分支）。
 * 解析结果只写入 agent_confirmed_answers（患者确认事实），
 * 再由规则内核评估——解析器不做任何临床判断。
 */

import { FIELD_LABELS } from "../clinical-rules/domain.js";

export interface StructuredAnswer {
  fieldCode: string;
  state: "yes" | "no" | "unknown";
}

const YES_TOKENS = new Set(["是", "有", "yes", "y"]);
const NO_TOKENS = new Set(["否", "没有", "无", "不", "no", "n"]);
const UNKNOWN_TOKENS = new Set(["不知道", "不清楚", "不确定", "unknown"]);
const SEPARATORS = /[，,;；、\s]+/u;

function stateOf(token: string): "yes" | "no" | "unknown" | null {
  const normalized = token.trim().toLowerCase();
  if (YES_TOKENS.has(normalized)) {
    return "yes";
  }
  if (NO_TOKENS.has(normalized)) {
    return "no";
  }
  if (UNKNOWN_TOKENS.has(normalized)) {
    return "unknown";
  }
  return null;
}

/**
 * 解析患者回答。支持形式（全部大小写不敏感）：
 * - "怕风：是" / "thirst=no" / "口渴：不知道"
 * - "有口渴" / "没有口渴" / "不知道口渴"
 * - 整句只有一个 "是/否/不知道" 时，作用于第一个补问（targets[0]）
 * 未命中的字段不产生任何解析结果（不猜测）。
 */
export function parseStructuredAnswers(
  message: string,
  targets: readonly { fieldCode: string }[]
): StructuredAnswer[] {
  const trimmed = message.trim();
  if (trimmed === "") {
    return [];
  }

  const answers: StructuredAnswer[] = [];
  const answeredFields = new Set<string>();

  // 形式一：字段编码或中文标签 + 分隔符 + 状态。
  const segments = trimmed.split(SEPARATORS).filter((part) => part !== "");
  for (const segment of segments) {
    const separatorIndex = Math.max(
      segment.indexOf("："),
      segment.indexOf(":"),
      segment.indexOf("=")
    );
    if (separatorIndex <= 0) {
      continue;
    }
    const fieldPart = segment.slice(0, separatorIndex).trim();
    const stateToken = segment.slice(separatorIndex + 1).trim();
    const state = stateOf(stateToken);
    if (state === null) {
      continue;
    }
    const fieldCode = findFieldCode(fieldPart);
    if (fieldCode === null || answeredFields.has(fieldCode)) {
      continue;
    }
    answeredFields.add(fieldCode);
    answers.push({ fieldCode, state });
  }

  // 形式二：有/没有/不知道 + 标签（如 "有口渴"、"没有怕风"）。
  for (const [fieldCode, label] of Object.entries(FIELD_LABELS)) {
    if (answeredFields.has(fieldCode)) {
      continue;
    }
    const index = trimmed.indexOf(label);
    if (index < 0) {
      continue;
    }
    const prefix = trimmed.slice(0, index);
    const state = stateOf(prefix);
    if (state !== null) {
      answeredFields.add(fieldCode);
      answers.push({ fieldCode, state });
    }
  }

  // 形式三：整句只有一个答案词 → 第一个补问。
  if (answers.length === 0 && targets.length > 0) {
    const state = stateOf(trimmed);
    if (state !== null) {
      const first = targets[0];
      if (first !== undefined && !answeredFields.has(first.fieldCode)) {
        answers.push({ fieldCode: first.fieldCode, state });
      }
    }
  }

  return answers;
}

function findFieldCode(fieldPart: string): string | null {
  if (Object.hasOwn(FIELD_LABELS, fieldPart)) {
    return fieldPart;
  }
  for (const [fieldCode, label] of Object.entries(FIELD_LABELS)) {
    if (fieldPart === label) {
      return fieldCode;
    }
  }
  return null;
}
