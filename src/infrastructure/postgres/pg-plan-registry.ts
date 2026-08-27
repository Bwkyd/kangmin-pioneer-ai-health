import type {
  ApprovedPlan,
  PlanBundle,
  PlanRegistryPort
} from "@kangmin/core/intelligence/clinical-rules/contracts";
import { KangminPgDatabase } from "./pg-database.js";

interface PlanRow {
  id: string;
  revision: number;
  name: string;
  method: string;
  steps_json: string;
  precautions: string;
  video_resource_id: string | null;
}

/**
 * 方案注册表（PostgreSQL）：从统一方案表 agent_plans（0009，管理端写入）
 * 读取当前启用的方案，供规则内核的方案安全评估与结果渲染使用。
 *
 * 与 SQLite 版（sqlite-plan-registry.ts）语义逐条对齐：
 * - 双方案查询（智能体设计 v4）：phase_code='acute' + audience 匹配 →
 *   急性期方案；syndrome + phase_code IS NULL + audience 匹配 → 调体方案；
 * - status='enabled' 是 Agent 匹配门禁（患者浏览门禁由内容读仓储
 *   同一列过滤）；
 * - 属性映射含"不灸"负向识别（评审 P0-2："点揉，不灸"不得误判
 *   moxibustion=yes 阻断肺经伏热）。
 */
function planMethodAttributes(method: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (method.includes("灸") && !method.includes("不灸")) {
    attributes.moxibustion = "yes";
  }
  if (method.includes("刮") || method.includes("拔罐")) {
    attributes.guasha_cupping = "yes";
  }
  return attributes;
}

function toApprovedPlan(row: PlanRow): ApprovedPlan {
  return {
    planId: row.id,
    planRevision: row.revision,
    name: row.name,
    method: row.method,
    steps: row.steps_json,
    precautions: row.precautions,
    videoResourceId: row.video_resource_id,
    attributes: planMethodAttributes(row.method)
  };
}

export class PgPlanRegistry implements PlanRegistryPort {
  constructor(private readonly database: KangminPgDatabase) {}

  async findApprovedPlanBundle(input: {
    syndromeCode: string;
    phaseCode: "acute" | "remission";
    audience: "child" | "adult";
  }): Promise<PlanBundle> {
    const { syndromeCode, phaseCode, audience } = input;
    const acute = await this.database.query<PlanRow>(
      `SELECT id, revision, name, method, steps_json, precautions, video_resource_id
       FROM agent_plans
       WHERE phase_code = 'acute' AND audience = $1 AND status = 'enabled'
       ORDER BY display_order ASC, id ASC
       LIMIT 1`,
      [audience]
    );
    const constitution = await this.database.query<PlanRow>(
      `SELECT id, revision, name, method, steps_json, precautions, video_resource_id
       FROM agent_plans
       WHERE syndrome = $1 AND phase_code IS NULL AND audience = $2 AND status = 'enabled'
       ORDER BY display_order ASC, id ASC
       LIMIT 1`,
      [syndromeCode, audience]
    );
    const acuteRow = acute.rows[0];
    const constitutionRow = constitution.rows[0];
    return {
      acute: acuteRow === undefined ? null : toApprovedPlan(acuteRow),
      constitution:
        constitutionRow === undefined ? null : toApprovedPlan(constitutionRow)
    };
  }
}
