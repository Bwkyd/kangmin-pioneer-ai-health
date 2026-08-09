// 方案 seed 脚本（智能体设计 v4）：11 条客户确认方案灌入线上库。
//
// 走管理端受校验路径（评审 P0-5/P0-6 + AI 决策 A7）：
// - 专用 dev admin 会话（createDevelopmentSession）；
// - createPlan（带 phaseCode/audience，0012 迁移列）+ enablePlan 校验；
// - 幂等键稳定（seed-plan:<id>），重跑不重复创建；
// - risks/contraindications 为已确认固定安全文案，禁占位词；
// - 验收：11 行 status='enabled'。
//
// 用法：node scripts/seed-agent-plans.mjs <数据库路径> [--dry-run]
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

import { readFileSync } from "node:fs";
import { createAdminApplication } from "../dist/app/admin-composition-root.js";

const databasePath = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (databasePath === undefined) {
  console.error("用法：node scripts/seed-agent-plans.mjs <数据库路径> [--dry-run]");
  process.exit(2);
}

const PLANS = JSON.parse(
  readFileSync(new URL("./seed-plans.json", import.meta.url), "utf8")
);
const FORBIDDEN_PLACEHOLDERS = ["待医学补充", "待补充", "TODO", "占位"];

function assertNoPlaceholder(plan) {
  const text = `${plan.name} ${plan.method} ${plan.precautions} ${plan.risks} ${plan.contraindications}`;
  for (const word of FORBIDDEN_PLACEHOLDERS) {
    if (text.includes(word)) {
      throw new Error(`seed 数据含占位词 "${word}"：${plan.id}`);
    }
  }
}

for (const plan of PLANS) {
  assertNoPlaceholder(plan);
}

const app = createAdminApplication(databasePath, {});
const session = await app.sessions.createDevelopmentSession("seed-agent-plans");
const token = session.token;

async function run(command, input) {
  const result = await app.execute({ command, adminToken: token, input });
  if (!result.ok) {
    throw new Error(`${command} 失败：${result.error.code} ${result.error.message}`);
  }
  return result.data;
}

let created = 0;
let replayed = 0;
for (const plan of PLANS) {
  const idempotencyKey = `seed-plan:${plan.id}`;
  const outcome = await run("agent plan create", {
    name: plan.name,
    syndrome: plan.syndrome,
    phaseCode: plan.phaseCode,
    audience: plan.audience,
    method: plan.method,
    steps: plan.steps,
    precautions: plan.precautions,
    risks: plan.risks,
    contraindications: plan.contraindications,
    idempotencyKey
  });
  if (outcome.replayed === true) {
    replayed += 1;
  } else {
    created += 1;
  }
  if (outcome.status !== "enabled" && !dryRun) {
    await run("agent plan enable", {
      id: outcome.id,
      expectedRevision: outcome.revision,
      yes: true
    });
  }
}

const listed = await run("agent plan list", {});
const enabled = listed.items.filter((item) => item.status === "enabled");
console.log(
  `seed 完成：新建 ${created} 条、重放 ${replayed} 条；enabled ${enabled.length} 条（期望 11 条）`
);
if (enabled.length !== 11) {
  console.error(`验收失败：enabled 应为 11，实际 ${enabled.length}`);
  process.exit(1);
}
console.log("验收通过：11 条方案全部启用 ✅");
app.close();
