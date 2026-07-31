import { KangminDatabase } from "./database.js";
import type {
  ApprovedPlan,
  PlanRegistryPort,
  SeverityCode
} from "../modules/clinical-rules/contracts.js";

interface PlanRow {
  id: string;
  revision: number;
  method: string;
}

/**
 * 方案注册表：从统一方案表 agent_plans（0009，管理端写入）读取
 * 当前启用的方案，供规则内核的方案安全评估使用。
 *
 * 证型 code 已由 P0 修复统一为规则内核的 UPPER_SNAKE 常量；
 * status='enabled' 是 Agent 匹配门禁（患者浏览门禁由
 * sqlite-content-read-repository 同一列过滤）。
 */
export class SqlitePlanRegistry implements PlanRegistryPort {
  constructor(private readonly database: KangminDatabase) {}

  findApprovedPlan(input: {
    syndromeCode: string;
    severityCode: SeverityCode;
  }): ApprovedPlan | null {
    const row = this.database.connection
      .prepare(`
        SELECT id, revision, method
        FROM agent_plans
        WHERE syndrome = ? AND status = 'enabled'
        ORDER BY display_order ASC, id ASC
        LIMIT 1
      `)
      .get(input.syndromeCode) as unknown as PlanRow | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      planId: row.id,
      planRevision: row.revision,
      attributes: { method_code: row.method }
    };
  }
}
