import { SYNDROME_LABELS } from "../clinical-rules/domain.js";

export type KnowledgeStatus =
  | "draft"
  | "processing"
  | "indexed"
  | "enabled"
  | "disabled"
  | "index_failed";

export type PlanStatus = "draft" | "enabled" | "disabled";

export interface SyndromeMeta {
  /** 规则内核的证型 code（唯一真源，UPPER_SNAKE）。 */
  id: string;
  /** 患者可读的中文短名（取自内核标签的顿号前部分）。 */
  name: string;
}

/**
 * 固定证型只读列表（设计 §2.3 / §5.6：客户不能创建或修改证型）。
 *
 * 唯一真源 = clinical-rules 规则内核的证型 code 与标签
 * （SYNDROME_LABELS），本列表由内核派生；管理端不提供任何新建/
 * 修改证型的命令。曾存在独立 kebab-case 六型常量（含“血瘀阻窍”），
 * 与内核 UPPER_SNAKE 五型互不兼容且违反客户不可建证型约束，已删除。
 */
export const FIXED_SYNDROMES: readonly SyndromeMeta[] = Object.entries(
  SYNDROME_LABELS
).map(([code, label]) => ({
  id: code,
  name: label.split("，")[0] ?? label
}));
