// 评估链路基准测试（clinical-rules-v2）：真实 CLI 进程逐场景完整对话。
// 覆盖：客户六步树五类叶子与关键 B/C 分支 +
// 期别（急性/缓解）+ 人群（成人/儿童）+ 边界（确诊转介/安全阻断/感冒鉴别）。
// 用法：KANGMIN_ALLOW_DEV_SESSION=1 node scripts/benchmark-assessment.mjs <已 seed 的库>
import { execFileSync } from "node:child_process";

const databasePath = process.argv[2];
if (databasePath === undefined) {
  console.error("用法：node scripts/benchmark-assessment.mjs <已 seed 的库>");
  process.exit(2);
}
const CLI = new URL("../dist/cli/kangmin.js", import.meta.url).pathname;
const env = {
  ...process.env,
  KANGMIN_ALLOW_DEV_SESSION: "1",
  KANGMIN_DB_PATH: databasePath
};

/** 安全 6 问全否的前置片段。 */
const SAFETY_NO = ["急救：否", "高热：否", "鼻出血：否", "剧烈头痛：否", "皮肤破损：否", "怀孕：否"];
const DIAGNOSED_YES = "确诊过敏性鼻炎：是";
const SEVERITY_NO = ["影响睡眠：否", "影响日常活动：否", "影响工作学习：否", "难以忍受：否"];

const SCENARIOS = [
  {
    id: "S1-step1-a",
    name: "肺经伏热·成人·急性（第1步 Q10A 立即结束）",
    turns: [...SAFETY_NO, DIAGNOSED_YES, "未满12周岁：否", "q1=B", "感冒样表现：否", "鼻窦炎样表现：否", ...SEVERITY_NO, "q10=A"],
    expect: { outcome: "classified", phase: "急性发作期", syndrome: "肺经伏热" }
  },
  {
    id: "S2-step2-a",
    name: "脾气虚弱·成人·急性（Q10B 后 Q8A）",
    turns: [...SAFETY_NO, DIAGNOSED_YES, "未满12周岁：否", "q1=B", "感冒样表现：否", "鼻窦炎样表现：否", ...SEVERITY_NO, "q10=B", "q8=A"],
    expect: { outcome: "classified", phase: "急性发作期", syndrome: "脾气虚弱" }
  },
  {
    id: "S3-step2-a-child",
    name: "脾气虚弱·儿童·缓解（Q10C 后 Q8A）",
    turns: [...SAFETY_NO, DIAGNOSED_YES, "未满12周岁：是", "q1=C", "感冒样表现：否", "鼻窦炎样表现：否", ...SEVERITY_NO, "q10=C", "q8=A"],
    expect: { outcome: "classified", phase: "缓解期", syndrome: "脾气虚弱", child: true }
  },
  {
    id: "S4-step4-b",
    name: "肺气虚寒·成人·急性（Q9B 必须结束）",
    turns: [...SAFETY_NO, DIAGNOSED_YES, "未满12周岁：否", "q1=B", "感冒样表现：否", "鼻窦炎样表现：否", ...SEVERITY_NO, "q10=B", "q8=B", "q6=A", "q9=B"],
    expect: { outcome: "classified", phase: "急性发作期", syndrome: "肺气虚寒" }
  },
  {
    id: "S5-step4-c",
    name: "肺气虚寒·成人·缓解（Q9C 必须结束）",
    turns: [...SAFETY_NO, DIAGNOSED_YES, "未满12周岁：否", "q1=C", "感冒样表现：否", "鼻窦炎样表现：否", ...SEVERITY_NO, "q10=C", "q8=C", "q6=C", "q9=C"],
    expect: { outcome: "classified", phase: "缓解期", syndrome: "肺气虚寒" }
  },
  {
    id: "S6-step5-a",
    name: "肾阳不足·成人·缓解（第5步 Q8A）",
    turns: [...SAFETY_NO, DIAGNOSED_YES, "未满12周岁：否", "q1=C", "感冒样表现：否", "鼻窦炎样表现：否", ...SEVERITY_NO, "q10=B", "q8=B", "q6=B", "q9=A", "q8=A"],
    expect: { outcome: "classified", phase: "缓解期", syndrome: "肾阳不足" }
  },
  {
    id: "S7-step6-a",
    name: "寒热错杂·成人·急性（第6步 Q10A）",
    turns: [...SAFETY_NO, DIAGNOSED_YES, "未满12周岁：否", "q1=B", "感冒样表现：否", "鼻窦炎样表现：否", ...SEVERITY_NO, "q10=C", "q8=C", "q6=A", "q9=A", "q8=B", "q10=A"],
    expect: { outcome: "classified", phase: "急性发作期", syndrome: "寒热错杂" }
  },
  {
    id: "S8-step6-b",
    name: "肾阳不足·成人·急性（第6步 Q10B）",
    turns: [...SAFETY_NO, DIAGNOSED_YES, "未满12周岁：否", "q1=B", "感冒样表现：否", "鼻窦炎样表现：否", ...SEVERITY_NO, "q10=B", "q8=C", "q6=C", "q9=A", "q8=C", "q10=B"],
    expect: { outcome: "classified", phase: "急性发作期", syndrome: "肾阳不足" }
  },
  {
    id: "S9-diagnosed-no",
    name: "确诊否 → 转介门诊（S-01 门禁）",
    turns: [...SAFETY_NO, "确诊过敏性鼻炎：否"],
    expect: { outcome: "non_applicable", text: "确诊" }
  },
  {
    id: "S10-urgent",
    name: "急救是 → 安全阻断（SAF-01）",
    turns: ["急救：是"],
    expect: { outcome: "blocked", text: "立即就医" }
  },
  {
    id: "S11-cold",
    name: "感冒样表现 → 非适用转介（APP-02）",
    turns: [...SAFETY_NO, DIAGNOSED_YES, "未满12周岁：否", "q1=B", "感冒样表现：是"],
    expect: { outcome: "non_applicable", text: "普通感冒" }
  },
  {
    id: "S12-remission-card",
    name: "缓解期结果卡完整（S5 同路径，断言模板）",
    turns: [...SAFETY_NO, DIAGNOSED_YES, "未满12周岁：否", "q1=C", "感冒样表现：否", "鼻窦炎样表现：否", ...SEVERITY_NO, "q10=C", "q8=C", "q6=C", "q9=C"],
    expect: { outcome: "classified", phase: "缓解期", syndrome: "肺气虚寒", card: true }
  }
];

function runCli(args) {
  const raw = execFileSync("node", [CLI, ...args], { env, encoding: "utf8" });
  return JSON.parse(raw);
}

let pass = 0;
let fail = 0;
const failures = [];
for (const scenario of SCENARIOS) {
  let cid;
  let last;
  let earlyClosed = false;
  for (const message of scenario.turns) {
    const result = runCli(["agent", "exec", message, "--json", ...(cid ? ["--conversation", cid] : [])]);
    if (!result.ok) {
      failures.push(`${scenario.id}: CLI 错误 ${result.error.code}`);
      fail += 1;
      earlyClosed = true;
      break;
    }
    last = result.data;
    cid = last.conversationId;
    if (last.closed && message !== scenario.turns[scenario.turns.length - 1]) {
      earlyClosed = true;
      break;
    }
  }
  if (earlyClosed) {
    if (last?.closed === true) {
      fail += 1;
      failures.push(`${scenario.id}: 在预期终点前提前结束`);
    }
    continue;
  }

  const v = last.verdict ?? {};
  const content = last.message?.content ?? "";
  const checks = [];
  checks.push(["outcome", v.outcome === scenario.expect.outcome, v.outcome]);
  if (scenario.expect.phase !== undefined) {
    checks.push(["期别", content.includes(scenario.expect.phase), `缺【${scenario.expect.phase}】`]);
  }
  if (scenario.expect.syndrome !== null && scenario.expect.syndrome !== undefined) {
    checks.push(["证型", content.includes(scenario.expect.syndrome), `缺【${scenario.expect.syndrome}】`]);
  }
  if (scenario.expect.syndrome === null) {
    checks.push(["no_match 文案", content.includes("门诊"), "缺门诊提示"]);
  }
  if (scenario.expect.text !== undefined) {
    checks.push(["文案", content.includes(scenario.expect.text), `缺「${scenario.expect.text}」`]);
  }
  if (scenario.expect.child === true) {
    checks.push(["儿童方案", content.includes("儿童") || content.includes("小儿"), "缺儿童方案"]);
  }
  if (scenario.expect.card === true) {
    checks.push(["结果卡完整", ["【体质调理固本方案】", "【执行建议】", "不能替代专业医疗诊断"].every((t) => content.includes(t)), "缺区块"]);
  }
  const allOk = checks.every(([, ok]) => ok);
  if (allOk) {
    pass += 1;
    console.log(`✅ ${scenario.id} ${scenario.name}`);
  } else {
    fail += 1;
    const detail = checks.filter(([, ok, msg]) => !ok).map(([, , msg]) => msg).join("; ");
    failures.push(`${scenario.id}: ${detail}`);
    console.log(`❌ ${scenario.id} ${scenario.name}（${detail}）`);
  }
}

console.log(`\n=== 基准结果：${pass}/${SCENARIOS.length} 通过 ===`);
if (failures.length > 0) {
  console.log("失败明细：");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
