import { spawnSync } from "node:child_process";

const expectedTests = [
  "生产 E2E：页面 Q1-Q14、六步二次确认与分期完整闭环",
  "模型不可用降级：空候选 + 固定 system_notice，规则结果仍然有效",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readExecutedTests(tapOutput) {
  return tapOutput
    .split(/\r?\n/gu)
    .filter((line) => /^ok \d+ - /u.test(line) && !line.includes(" # SKIP "))
    .map((line) => line.replace(/^ok \d+ - /u, ""));
}

const exactPattern = `^(?:${expectedTests.map(escapeRegExp).join("|")})$`;
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-reporter=tap",
    `--test-name-pattern=${exactPattern}`,
    "dist/tests/agent-conversation.test.js",
  ],
  { encoding: "utf8" },
);

process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");

if (result.error) {
  console.error(`core-smoke: 无法启动测试：${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const executedTests = readExecutedTests(result.stdout ?? "");
const exactMatch =
  executedTests.length === expectedTests.length &&
  expectedTests.every((testName) => executedTests.includes(testName));

if (!exactMatch) {
  console.error("core-smoke: 目标测试发生漂移，拒绝把零命中或部分命中当作通过。");
  console.error(`core-smoke: 期望：${JSON.stringify(expectedTests)}`);
  console.error(`core-smoke: 实际：${JSON.stringify(executedTests)}`);
  process.exit(1);
}

console.log(`core-smoke: PASS（已执行 ${executedTests.length} 条核心行为）`);
