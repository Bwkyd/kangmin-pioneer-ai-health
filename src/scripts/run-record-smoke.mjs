import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 只编排账本中已有的高信号断言，不复制 fixture 或改变记录业务实现。
// 每个目标独立启动一次 Node 测试进程，避免多文件筛选零命中时假绿。
const expectedCases = [
  {
    file: "application.test.js",
    name: "日历投影按日合并症状、暴露和用药，趋势只读且不填充"
  },
  {
    file: "record-production.test.js",
    name: "解密失败映射为 storage_unavailable（retryable: false），不伪装为空数据"
  },
  {
    file: "miniprogram-shell.test.js",
    name: "客户体验版真实页面链路可授权、保存症状并在日历和我的页回显"
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
  console.error("record-smoke: 拒绝把零命中、部分命中或失败进程当作通过。");
  for (const failure of failures) console.error(`record-smoke: ${failure}`);
  process.exit(1);
}

console.log(`record-smoke: PASS（已执行 ${expectedCases.length} 条症状管理行为）`);
