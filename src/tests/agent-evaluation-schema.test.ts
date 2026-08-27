import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  loadEvaluationJsonl,
  parseEvaluationTask,
  verifyKnowledgeEvidence
} from "@kangmin/runtime/evals/knowledge-qa/task-schema";

const taskPath = resolve("tests/fixtures/knowledge-qa/tasks.v1.jsonl");

test("首批评测集包含 10 条合法任务，并覆盖知识、规则和多轮任务", async () => {
  const tasks = await loadEvaluationJsonl(taskPath);
  assert.equal(tasks.length, 10);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 10);
  assert.ok(tasks.some((task) => task.evidence.mode === "knowledge"));
  assert.ok(tasks.some((task) => task.evidence.mode === "rule"));
  assert.ok(tasks.some((task) => task.turns.length > 1));
  assert.ok(
    tasks.some((task) =>
      task.turns.some((turn) => turn.expected.action === "emergency_redirect")
    )
  );
});

test("规则型任务不能用 answer 动作绕过知识证据", () => {
  assert.throws(
    () => parseEvaluationTask({
      id: "invalid-rule-answer",
      suite: "regression",
      tags: ["boundary"],
      turns: [{
        role: "user",
        text: "直接回答",
        expected: { action: "answer", mustCover: [], mustNot: [] }
      }],
      setup: { assessment: null, knowledgeManifest: "fixture" },
      evidence: { mode: "rule", acceptableEvidence: [], forbiddenClaims: [] },
      trials: 1,
      provenance: "测试",
      review: { product: "draft", medical: "truth-anchored" }
    }),
    /包含 answer 的任务必须使用知识证据/u
  );
});

test("证据校验要求每个候选组至少有一个真实文件锚点命中", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kangmin-eval-evidence-"));
  try {
    await writeFile(join(directory, "fixture.md"), "正文包含：免疫球蛋白 E（IgE）。\n", "utf8");
    const task = parseEvaluationTask({
      id: "fixture-knowledge",
      suite: "capability",
      tags: ["fixture"],
      turns: [{
        role: "user",
        text: "IgE 是什么？",
        expected: { action: "answer", mustCover: ["解释 IgE"], mustNot: [] }
      }],
      setup: { assessment: null, knowledgeManifest: "fixture" },
      evidence: {
        mode: "knowledge",
        acceptableEvidence: [{
          knowledge: ["fixture.md"],
          anchors: ["免疫球蛋白 E（IgE）"]
        }],
        forbiddenClaims: []
      },
      trials: 1,
      provenance: "测试",
      review: { product: "draft", medical: "source-anchored" }
    });
    const summary = await verifyKnowledgeEvidence([task], directory);
    assert.deepEqual(summary, {
      tasks: 1,
      knowledgeTasks: 1,
      alternatives: 1,
      files: 1,
      anchors: 1
    });

    task.evidence.acceptableEvidence[0]!.anchors = ["不存在的锚点"];
    await assert.rejects(
      verifyKnowledgeEvidence([task], directory),
      /没有任何锚点命中/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
