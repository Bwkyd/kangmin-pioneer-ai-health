import type {
  ApprovedPlan,
  PlanRegistryPort,
  SeverityCode
} from "../../modules/clinical-rules/contracts.js";
import { KangminPgDatabase } from "./pg-database.js";

interface PlanRow {
  id: string;
  revision: number;
  method: string;
}

/**
 * 方案注册表（PostgreSQL）：从统一方案表 agent_plans（0009，管理端写入）
 * 读取当前启用的方案，供规则内核的方案安全评估使用。
 *
 * 与 SQLite 版（sqlite-plan-registry.ts）语义逐条对齐：
 * 证型 code 已由 P0 修复统一为规则内核的 UPPER_SNAKE 常量；
 * status='enabled' 是 Agent 匹配门禁（患者浏览门禁由内容读仓储
 * 同一列过滤）。
 *
 * 方案方法属性键约定（规则来源：rule-package.ts 的 MSAF-01/02，
 * 依据“证型→基础方案映射表”：肺经伏热禁灸助热、皮损禁刮痧拔罐）：
 * agent_plans.method 是管理端自由文本，本 registry 负责确定性映射为
 * 规则评估的属性键——含“灸”→moxibustion，含“刮”或“拔罐”→
 * guasha_cupping；method 为空或无法映射时不输出对应键（保持规则
 * 的 unmatched 安全语义：未知属性按“不含该方法”处理，绝不猜测）。
 *
 * 注：MSAF-02（皮损处只排除刮痧拔罐）与 SAF-05（皮损整体阻断外治）
 * 存在语义重叠矛盾，需临床裁决后统一，本次不改变两条规则现状。
 *
 * 端口已统一异步化（PlanRegistryPort.findApprovedPlan 返回 Promise），
 * 本实现直接 implements 该端口；查询条件、排序与属性映射与 SQLite 版一致。
 */
function planMethodAttributes(method: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (method.includes("灸")) {
    attributes.moxibustion = "yes";
  }
  if (method.includes("刮") || method.includes("拔罐")) {
    attributes.guasha_cupping = "yes";
  }
  return attributes;
}

export class PgPlanRegistry implements PlanRegistryPort {
  constructor(private readonly database: KangminPgDatabase) {}

  async findApprovedPlan(input: {
    syndromeCode: string;
    severityCode: SeverityCode;
  }): Promise<ApprovedPlan | null> {
    const { rows } = await this.database.query<PlanRow>(
      `SELECT id, revision, method
       FROM agent_plans
       WHERE syndrome = $1 AND status = 'enabled'
       ORDER BY display_order ASC, id ASC
       LIMIT 1`,
      [input.syndromeCode]
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      planId: row.id,
      planRevision: row.revision,
      attributes: planMethodAttributes(row.method)
    };
  }
}
