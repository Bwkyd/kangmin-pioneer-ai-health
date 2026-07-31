export type KnowledgeStatus =
  | "draft"
  | "processing"
  | "indexed"
  | "enabled"
  | "disabled"
  | "index_failed";

export type PlanStatus = "draft" | "enabled" | "disabled";

export interface SyndromeMeta {
  id: string;
  name: string;
}

/**
 * 固定证型只读列表（设计 §2.3 / §5.6：客户不能创建或修改证型）。
 *
 * 决策记录：w4-agent 的规则内核（输出证型的固定规则引擎）尚未集成到本
 * 工作树，因此先以内置只读常量表提供，后续由 w4 规则内核通过
 * SyndromeRegistryPort 接管；管理端不提供任何新建/修改证型的命令。
 */
export const FIXED_SYNDROMES: readonly SyndromeMeta[] = [
  { id: "feiqi-xuhan", name: "肺气虚寒" },
  { id: "pixu-weiruo", name: "脾气虚弱" },
  { id: "shenyang-buzu", name: "肾阳不足" },
  { id: "feijing-fure", name: "肺经伏热" },
  { id: "hanre-cuocuo", name: "寒热错杂" },
  { id: "xueyu-zuqiao", name: "血瘀阻窍" }
];
