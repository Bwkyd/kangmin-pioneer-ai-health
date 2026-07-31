import type { SyndromeRegistryPort } from "../modules/agent-admin/agent-admin-ports.js";
import { FIXED_SYNDROMES } from "../modules/agent-admin/domain.js";
import type { SyndromeMeta } from "../modules/agent-admin/domain.js";

/**
 * 内置只读证型注册表（待规则内核接管）。
 * 设计 §5.6：客户只能从固定证型列表选择；当 w4-agent 的规则内核集成后，
 * 由该内核实现同一端口替换本实现，管理端命令无需改动。
 */
export class BuiltinSyndromeRegistry implements SyndromeRegistryPort {
  async list(): Promise<SyndromeMeta[]> {
    return [...FIXED_SYNDROMES];
  }

  async find(id: string): Promise<SyndromeMeta | null> {
    return FIXED_SYNDROMES.find((item) => item.id === id) ?? null;
  }
}
