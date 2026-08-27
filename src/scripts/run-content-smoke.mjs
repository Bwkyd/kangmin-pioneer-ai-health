import { spawnSync } from "node:child_process";

// 只编排账本中已有的高信号测试，不复制 fixture 或改变内容业务实现。
// 每个目标单独启动一次 Node 测试进程，避免多文件 --test-name-pattern 零命中时假绿。
const expectedCases = [
  {
    file: "admin-agent.test.js",
    name: "知识状态机：add→index→enable→search-test→disable"
  },
  {
    file: "semantic-knowledge-retrieval.test.js",
    name: "语义检索按余弦排序，返回来源与分类，并排除停用知识"
  }
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

const failures = [];
for (const testCase of expectedCases) {
  const exactPattern = `^${escapeRegExp(testCase.name)}$`;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      `--test-name-pattern=${exactPattern}`,
      `dist/tests/${testCase.file}`
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
  console.error("content-smoke: 拒绝把零命中、部分命中或失败进程当作通过。");
  for (const failure of failures) console.error(`content-smoke: ${failure}`);
  process.exit(1);
}

console.log(`content-smoke: PASS（已执行 ${expectedCases.length} 条内容行为）`);
