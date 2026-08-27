/** 将前端按钮提交的内部协议载荷转换为患者可读文本。 */

import { FIELD_LABELS } from "../clinical-rules/domain.js";

const STATE_LABELS: Record<string, string> = {
  yes: "是",
  no: "否",
  unknown: "不清楚"
};

const INTERNAL_FIELD_ANSWER = /^([a-z][a-z0-9_]*)(?:=|:)(yes|no|unknown)$/iu;
const INTERNAL_OPTION_ANSWER = /^q(\d+)=([A-D])$/iu;

/**
 * 只转换确定命中的内部协议格式；患者自行输入的自然语言保持原样。
 * 未知字段不猜测，避免把普通文本误改成临床含义。
 */
export function patientVisibleMessage(content: string): string {
  const trimmed = content.trim();
  const fieldMatch = INTERNAL_FIELD_ANSWER.exec(trimmed);
  if (fieldMatch !== null) {
    const fieldCode = fieldMatch[1] ?? "";
    const state = (fieldMatch[2] ?? "").toLowerCase();
    const fieldLabel = FIELD_LABELS[fieldCode];
    const stateLabel = STATE_LABELS[state];
    if (fieldLabel !== undefined && stateLabel !== undefined) {
      return `${fieldLabel}：${stateLabel}`;
    }
  }

  const optionMatch = INTERNAL_OPTION_ANSWER.exec(trimmed);
  if (optionMatch !== null) {
    return `第 ${optionMatch[1]} 题：选择 ${optionMatch[2]?.toUpperCase()}`;
  }

  return content;
}
