import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 只编排基础壳层已有的会话、导航、失败、传输与环境门禁断言，不复制 fixture。
// 每个目标独立启动一次 Node 测试进程，避免多文件筛选零命中时假绿。
const expectedCases = [
  {
    file: "miniprogram-shell.test.js",
    name: "小程序公共请求免登录，患者记录经 wx.login 换取 Bearer 会话"
  },
  {
    file: "miniprogram-shell.test.js",
    name: "患者命令遇到 401 清理旧令牌并只重登重试一次"
  },
  {
    file: "miniprogram-shell.test.js",
    name: "微信登录未配置时患者命令安全拒绝且不发出身份请求"
  },
  {
    file: "miniprogram-shell.test.js",
    name: "小程序首页只读取记录概览，并保持四条患者入口"
  },
  {
    file: "miniprogram-shell.test.js",
    name: "小程序流式请求按 NDJSON 增量输出，并正确还原跨 chunk 的中文 UTF-8"
  },
  {
    file: "config-gates.test.js",
    name: "环境门禁：production 与未设 APP_ENV 且未显式开发降级同样 fail-closed"
  }
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readExecutedTests(tapOutput) {
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

const scriptDir = dirname(fileURLToPath(import.meta.url));
const distTestsDir = resolve(scriptDir, "../dist/tests");
const failures = [];

for (const testCase of expectedCases) {
  const exactPattern = `^${escapeRegExp(testCase.name)}$`;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      `--test-name-pattern=${exactPattern}`,
      resolve(distTestsDir, testCase.file)
    ],
    { encoding: "utf8" }
  );

  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");

  if (result.error) {
    failures.push(`${testCase.file}: 无法启动测试：${result.error.message}`);
    continue;
  }
  if (result.status !== 0) {
    failures.push(`${testCase.file}: 测试进程退出 ${result.status ?? 1}`);
    continue;
  }

  const executedTests = readExecutedTests(result.stdout ?? "");
  const exactMatch =
    executedTests.length === 1 && executedTests[0] === testCase.name;
  if (!exactMatch) {
    failures.push(
      `${testCase.file}: 目标测试未逐字且唯一命中；实际执行 ${JSON.stringify(executedTests)}`
    );
  }
}

if (failures.length > 0) {
  console.error("shell-smoke: 拒绝把零命中、部分命中或失败进程当作通过。");
  for (const failure of failures) console.error(`shell-smoke: ${failure}`);
  process.exit(1);
}

console.log(`shell-smoke: PASS（已执行 ${expectedCases.length} 条基础壳行为）`);
