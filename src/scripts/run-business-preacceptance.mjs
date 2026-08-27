import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");
const distTestsDir = resolve(workspaceRoot, "dist/tests");

const exactCases = [
  {
    group: "内容运营",
    file: "admin-cli.e2e.test.js",
    name: "真实 CLI 全流程：引导→登录→发布→患者可见→退出码与 JSON 契约"
  },
  {
    group: "内容运营",
    file: "http.e2e.test.js",
    name: "Browse 通过无身份 HTTP 命令契约只返回已发布内容"
  },
  {
    group: "AI 知识",
    file: "admin-cli.e2e.test.js",
    name: "CLI 用户敏感详情权限与知识状态机走真实进程"
  },
  {
    group: "患者核心",
    file: "agent-conversation.test.js",
    name: "诊一诊真实 SQLite E2E：后台启用方案与知识后，患者完成评估并追问"
  },
  {
    group: "患者核心",
    file: "http.e2e.test.js",
    name: "患者 Agent 流式药量前置分流：危险候选不进入分片、done 或历史"
  },
  {
    group: "持续管理与交付",
    file: "http.e2e.test.js",
    name: "HTTP 适配器使用同一应用服务并执行真实身份和持久化"
  },
  {
    group: "持续管理与交付",
    file: "http.e2e.test.js",
    name: "record 写入缺 health_data 授权：HTTP 403 + consent_required"
  }
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function executedTests(tapOutput) {
  return tapOutput
    .split(/\r?\n/gu)
    .filter(
      (line) =>
        /^ok \d+ - /u.test(line) &&
        !line.includes(" # SKIP ") &&
        !line.includes(" # TODO ")
    )
    .map((line) => line.replace(/^ok \d+ - /u, ""));
}

function isExactHit(tapOutput, expectedName) {
  const actual = executedTests(tapOutput);
  return actual.length === 1 && actual[0] === expectedName;
}

function selfTest() {
  const target = "目标行为";
  const hit = "ok 1 - 目标行为\n";
  const zeroHit = "ok 1 - 其他行为 # SKIP test name does not match pattern\n";
  const partialHit = "ok 1 - 目标行为\nok 2 - 意外行为\n";
  if (!isExactHit(hit, target) || isExactHit(zeroHit, target) || isExactHit(partialHit, target)) {
    throw new Error("严格命中自检失败：无法可靠识别零命中或多命中");
  }
  console.log("business-preacceptance self-test: PASS（零命中与多命中均会失败）");
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: process.env
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw new Error(`${label} 无法启动：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} 退出 ${result.status ?? 1}`);
  return result.stdout ?? "";
}

selfTest();
if (process.argv.includes("--self-test")) process.exit(0);

run("npm", ["run", "build", "--silent"], "构建");

for (const script of [
  "run-core-smoke.mjs",
  "run-content-smoke.mjs",
  "run-record-smoke.mjs",
  "run-shell-smoke.mjs"
]) {
  run(process.execPath, [resolve(scriptDir, script)], script);
}

for (const testCase of exactCases) {
  const exactPattern = `^${escapeRegExp(testCase.name)}$`;
  const output = run(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      `--test-name-pattern=${exactPattern}`,
      resolve(distTestsDir, testCase.file)
    ],
    `${testCase.group}/${testCase.name}`
  );
  if (!isExactHit(output, testCase.name)) {
    throw new Error(
      `${testCase.group}/${testCase.name} 未逐字且唯一命中；实际 ${JSON.stringify(executedTests(output))}`
    );
  }
}

run(process.execPath, [resolve(scriptDir, "web-browser-e2e.mjs")], "管理后台真实浏览器 E2E");

const groups = [...new Set(exactCases.map((testCase) => testCase.group))];
console.log(
  `business-preacceptance: PASS（${groups.length} 组、${exactCases.length} 条真实入口、4 组冒烟、桌面与移动浏览器）`
);
