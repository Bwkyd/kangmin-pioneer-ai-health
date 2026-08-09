// 评估全链路冒烟：页面按《页面展示》Q1-Q14，跳转按《前置规则》。
// 用法：node scripts/smoke-assessment.mjs <数据库路径>
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

import { createApplication } from "../dist/app/composition-root.js";

const databasePath = process.argv[2];
if (databasePath === undefined) {
  console.error("用法：node scripts/smoke-assessment.mjs <数据库路径>");
  process.exit(2);
}

const app = createApplication(databasePath, {});
const session = await app.sessions.createDevelopmentSession("smoke-patient");

async function exec(message, conversationId) {
  const result = await app.execute({
    command: "agent exec",
    input: { message, ...(conversationId === undefined ? {} : { conversationId }) },
    sessionToken: session.token
  });
  if (!result.ok) {
    throw new Error(`agent exec 失败：${result.error.code} ${result.error.message}`);
  }
  return result.data;
}

// 寒热错杂路径：Q1-Q11 → Q8/Q10 二次确认 → Q12-Q14。
const turns = [
  "",
  "q1=B",
  "q2=A",
  "q3=C",
  "q4=B",
  "q5=D",
  "q6=B",
  "q7=C",
  "q8=C",
  "q9=A",
  "q10=B",
  "q11=D",
  "q8=B",
  "q10=A",
  "q12=A",
  "q13=A",
  "q14=A"
];

let last = null;
let conversationId;
for (let index = 0; index < turns.length; index++) {
  last = await exec(turns[index], conversationId);
  conversationId = last.conversationId;
  if (last.closed) {
    console.log(`第 ${index + 1} 轮结束（outcome=${last.verdict?.outcome}）`);
    break;
  }
}

if (last === null || last.closed !== true) {
  console.error("冒烟失败：会话未正常结束");
  process.exit(1);
}
const content = last.message?.content ?? "";
const checks = [
  ["急性发作期", content.includes("【急性发作期】")],
  ["寒热错杂", content.includes("【寒热错杂】")],
  ["急性期症状缓解方案", content.includes("【急性期症状缓解方案】")],
  ["体质调理固本方案", content.includes("【体质调理固本方案】")],
  ["执行建议", content.includes("【执行建议】")],
  ["免责声明", content.includes("不能替代专业医疗诊断")]
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) failed += 1;
}
if (failed > 0) {
  console.error("冒烟失败：结果卡缺失关键区块");
  console.error(content.slice(0, 600));
  process.exit(1);
}
console.log("冒烟通过：Q1-Q14→六步证型→分期→结果卡 全链路 ✅");
app.close();
