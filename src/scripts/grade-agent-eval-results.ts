import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { gradeEvaluationTrial } from "@kangmin/runtime/evals/knowledge-qa/deterministic-grader";
import { loadEvaluationJsonl } from "@kangmin/runtime/evals/knowledge-qa/task-schema";
import type { EvaluationTrialRecord } from "@kangmin/runtime/evals/knowledge-qa/trial-record";

function parseTrials(text: string, source: string): EvaluationTrialRecord[] {
  return text.split(/\r?\n/u).flatMap((line, index) => {
    if (line.trim() === "") return [];
    try {
      return [JSON.parse(line) as EvaluationTrialRecord];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${source}:${index + 1}: ${detail}`);
    }
  });
}

async function main(): Promise<void> {
  const [taskArgument, trialArgument, outputArgument] = process.argv.slice(2);
  if (taskArgument === undefined || trialArgument === undefined || outputArgument === undefined) {
    throw new Error("用法：grade-agent-eval-results <tasks.jsonl> <trials.jsonl> <输出目录>");
  }
  const taskPath = resolve(taskArgument);
  const trialPath = resolve(trialArgument);
  const outputDirectory = resolve(outputArgument);
  const tasks = await loadEvaluationJsonl(taskPath);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const trials = parseTrials(await readFile(trialPath, "utf8"), trialPath);
  const grades = trials.map((trial) => {
    const task = tasksById.get(trial.taskId);
    if (task === undefined) throw new Error(`试次引用未知任务：${trial.taskId}`);
    return gradeEvaluationTrial(task, trial);
  });
  const deterministicPassed = grades.filter((grade) => grade.deterministicPassed).length;
  const summary = {
    tasks: new Set(trials.map((trial) => trial.taskId)).size,
    trials: trials.length,
    deterministicPassed,
    deterministicFailed: grades.length - deterministicPassed,
    pendingManualReview: grades.length
  };
  const failures = grades
    .filter((grade) => !grade.deterministicPassed)
    .map((grade) => `- ${grade.taskId}: ${grade.checks.filter((item) => !item.passed).map((item) => item.id).join("、")}`);
  await writeFile(
    join(outputDirectory, "grades.jsonl"),
    `${grades.map((grade) => JSON.stringify(grade)).join("\n")}\n`,
    "utf8"
  );
  await writeFile(join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(
    join(outputDirectory, "summary.md"),
    [
      "# 患者智能体 10 题单次基线",
      "",
      `- 任务：${summary.tasks}`,
      `- 试次：${summary.trials}`,
      `- L0 确定性通过：${summary.deterministicPassed}`,
      `- L0 确定性失败：${summary.deterministicFailed}`,
      `- 待人工质量复核：${summary.pendingManualReview}`,
      "",
      "## 确定性失败",
      "",
      ...(failures.length === 0 ? ["- 无"] : failures),
      ""
    ].join("\n"),
    "utf8"
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1]?.endsWith("grade-agent-eval-results.js")) {
  await main();
}
