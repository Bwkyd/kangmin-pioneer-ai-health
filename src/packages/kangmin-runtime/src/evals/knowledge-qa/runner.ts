import type { EvaluationTask } from "./task-schema.js";
import { gradeEvaluationTrial, type DeterministicGrade } from "./deterministic-grader.js";
import type { EvaluationExecutor, EvaluationTrialRecord } from "./trial-record.js";

export interface EvaluationRunResult {
  trials: EvaluationTrialRecord[];
  grades: DeterministicGrade[];
  summary: {
    tasks: number;
    trials: number;
    deterministicPassed: number;
    deterministicFailed: number;
    pendingManualReview: number;
  };
}

export async function runEvaluationTasks(
  tasks: readonly EvaluationTask[],
  executor: EvaluationExecutor,
  options: { trialsPerTask?: number | undefined } = {}
): Promise<EvaluationRunResult> {
  const trials: EvaluationTrialRecord[] = [];
  const grades: DeterministicGrade[] = [];
  for (const task of tasks) {
    const count = options.trialsPerTask ?? task.trials;
    if (!Number.isInteger(count) || count < 1 || count > task.trials) {
      throw new Error(`${task.id}: trialsPerTask 必须在 1 到任务 trials 之间`);
    }
    for (let trial = 1; trial <= count; trial += 1) {
      const record = await executor.execute(task.id, trial);
      if (record.taskId !== task.id || record.trial !== trial) {
        throw new Error(`${task.id}: executor 返回了错误的任务或试次编号`);
      }
      trials.push(record);
      grades.push(gradeEvaluationTrial(task, record));
    }
  }
  const deterministicPassed = grades.filter((grade) => grade.deterministicPassed).length;
  return {
    trials,
    grades,
    summary: {
      tasks: tasks.length,
      trials: trials.length,
      deterministicPassed,
      deterministicFailed: grades.length - deterministicPassed,
      pendingManualReview: grades.filter((grade) => grade.manualReviewRequired).length
    }
  };
}
