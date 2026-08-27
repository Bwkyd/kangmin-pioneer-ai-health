import { resolve } from "node:path";

import {
  loadEvaluationJsonl,
  verifyKnowledgeEvidence
} from "@kangmin/runtime/evals/knowledge-qa/task-schema";

async function main(): Promise<void> {
  const [taskArgument, knowledgeArgument] = process.argv.slice(2);
  const taskPath = resolve(taskArgument ?? "tests/fixtures/knowledge-qa/tasks.v1.jsonl");
  const tasks = await loadEvaluationJsonl(taskPath);
  if (knowledgeArgument === undefined) {
    process.stdout.write(`${JSON.stringify({ tasks: tasks.length, evidence: "not-checked" })}\n`);
    return;
  }
  const summary = await verifyKnowledgeEvidence(tasks, resolve(knowledgeArgument));
  process.stdout.write(`${JSON.stringify({ ...summary, evidence: "checked" })}\n`);
}

if (process.argv[1]?.endsWith("validate-agent-evals.js")) {
  await main();
}
