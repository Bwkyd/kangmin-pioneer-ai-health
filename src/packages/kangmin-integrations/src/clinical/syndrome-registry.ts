import type { SyndromeRegistryPort } from "@kangmin/core/operations/agent-admin/agent-admin-ports";
import { FIXED_SYNDROMES } from "@kangmin/core/operations/agent-admin/domain";
import type { SyndromeMeta } from "@kangmin/core/operations/agent-admin/domain";

/**
 * 内置只读证型注册表（已由规则内核证型常量派生）。
 * FIXED_SYNDROMES 派生自 clinical-rules 规则内核的证型 code 与标签
 * （见 agent-admin/domain.ts，唯一真源 = clinical-rules/domain.ts 的
 * SYNDROME_LABELS），本实现仅做只读代理。设计 §5.6：客户只能从固定
 * 证型列表选择；若未来规则内核通过同一端口直接提供服务，管理端命令
 * 无需改动。
 */
export class BuiltinSyndromeRegistry implements SyndromeRegistryPort {
  async list(): Promise<SyndromeMeta[]> {
    return [...FIXED_SYNDROMES];
  }

  async find(id: string): Promise<SyndromeMeta | null> {
    return FIXED_SYNDROMES.find((item) => item.id === id) ?? null;
  }
}
