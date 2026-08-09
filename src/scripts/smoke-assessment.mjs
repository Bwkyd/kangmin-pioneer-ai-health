// 评估全链路冒烟（智能体设计 v4，与流水线顺序一致）：
// 急救→确诊→人群→喷嚏→症状→严重度→证型→结果卡
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

// 对话序列：逐题一问，混合字段标签与问卷选项载荷（qN=选项）。
const turns = [
  "",
  "急救：否",
  "高热：否",
  "鼻出血：否",
  "剧烈头痛：否",
  "皮肤破损：否",
  "怀孕：否",
  "确诊过敏性鼻炎：是",
  "未满12周岁：否",
  "q1=B",
  "感冒样表现：否",
  "鼻窦炎样表现：否",
  "影响睡眠：否",
  "影响日常活动：否",
  "影响工作学习：否",
  "难以忍受：否",
  "q10=B",
  "q8=C",
  "q6=B",
  "q9=A",
  "q8=B",
  "q10=A"
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
console.log("冒烟通过：急救→确诊→人群→喷嚏→症状→严重度→证型→结果卡 全链路 ✅");
app.close();
