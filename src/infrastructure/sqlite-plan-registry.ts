import { KangminDatabase } from "./database.js";
import type {
  ApprovedPlan,
  PlanBundle,
  PlanRegistryPort
} from "../modules/clinical-rules/contracts.js";

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
 * 方案注册表：从统一方案表 agent_plans（0009，管理端写入）读取
 * 当前启用的方案，供规则内核的方案安全评估与结果渲染使用。
 *
 * 双方案查询（智能体设计 v4，codex P0-1）：按期别×人群精确匹配
 * - 急性期方案：phase_code='acute' 且 audience 匹配；
 * - 调体方案：phase_code IS NULL 且 syndrome 匹配且 audience 匹配。
 * 不再按证型 LIMIT 1 任意取首条（儿童会取错成人方案、ACUTE 缺失）。
 *
 * 方案方法属性键约定（规则来源：rule-package.ts 的 MSAF-01/02，
 * 依据"证型→基础方案映射表"：肺经伏热禁灸助热、皮损禁刮痧拔罐）：
 * agent_plans.method 是管理端自由文本，本 registry 负责确定性映射为
 * 规则评估的属性键——含"灸"→moxibustion（"不灸"负向识别，评审 P0-2：
 * "点揉，不灸"含"灸"子串不得误判 moxibustion=yes 阻断肺经伏热）、
 * 含"刮"或"拔罐"→guasha_cupping；method 为空或无法映射时不输出对应
 * 键（保持规则 unmatched 安全语义：未知属性按"不含该方法"处理）。
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

export class SqlitePlanRegistry implements PlanRegistryPort {
  constructor(private readonly database: KangminDatabase) {}

  async findApprovedPlanBundle(input: {
    syndromeCode: string;
    phaseCode: "acute" | "remission";
    audience: "child" | "adult";
  }): Promise<PlanBundle> {
    const { syndromeCode, phaseCode, audience } = input;
    const acuteRow = this.database.connection
      .prepare(`
        SELECT id, revision, name, method, steps_json, precautions, video_resource_id
        FROM agent_plans
        WHERE phase_code = 'acute' AND audience = ? AND status = 'enabled'
        ORDER BY display_order ASC, id ASC
        LIMIT 1
      `)
      .get(audience) as unknown as PlanRow | undefined;
    const constitutionRow = this.database.connection
      .prepare(`
        SELECT id, revision, name, method, steps_json, precautions, video_resource_id
        FROM agent_plans
        WHERE syndrome = ? AND phase_code IS NULL AND audience = ? AND status = 'enabled'
        ORDER BY display_order ASC, id ASC
        LIMIT 1
      `)
      .get(syndromeCode, audience) as unknown as PlanRow | undefined;
    return {
      acute: acuteRow === undefined ? null : toApprovedPlan(acuteRow),
      constitution:
        constitutionRow === undefined ? null : toApprovedPlan(constitutionRow)
    };
  }
}
