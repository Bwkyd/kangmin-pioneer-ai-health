import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ACTIONS = [
  "answer",
  "refuse_operation",
  "clarify",
  "emergency_redirect",
  "explain_current_plan"
] as const;

const SUITES = ["capability", "regression"] as const;
const EVIDENCE_MODES = ["knowledge", "rule"] as const;
const PRODUCT_REVIEWS = ["draft", "approved"] as const;
const MEDICAL_REVIEWS = [
  "source-anchored",
  "truth-anchored",
  "not-applicable",
  "needs-authority"
] as const;

export type EvaluationAction = (typeof ACTIONS)[number];
export type EvaluationSuite = (typeof SUITES)[number];

export interface ExpectedBehavior {
  action: EvaluationAction;
  mustCover: string[];
  mustNot: string[];
}

export interface EvaluationTurn {
  role: "user";
  text: string;
  expected: ExpectedBehavior;
}

export interface KnowledgeEvidenceAlternative {
  knowledge: string[];
  anchors: string[];
}

export interface EvaluationTask {
  id: string;
  suite: EvaluationSuite;
  tags: string[];
  turns: EvaluationTurn[];
  setup: {
    assessment: null | Record<string, unknown>;
    knowledgeManifest: string;
  };
  evidence: {
    mode: (typeof EVIDENCE_MODES)[number];
    acceptableEvidence: KnowledgeEvidenceAlternative[];
    forbiddenClaims: string[];
  };
  trials: number;
  provenance: string;
  review: {
    product: (typeof PRODUCT_REVIEWS)[number];
    medical: (typeof MEDICAL_REVIEWS)[number];
  };
}

export interface EvidenceVerificationSummary {
  tasks: number;
  knowledgeTasks: number;
  alternatives: number;
  files: number;
  anchors: number;
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "必须是对象");
  }
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(path, "必须是非空字符串");
  }
  return value;
}

function stringArrayAt(value: unknown, path: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(path, allowEmpty ? "必须是字符串数组" : "必须是非空字符串数组");
  }
  const values = value.map((item, index) => stringAt(item, `${path}[${index}]`));
  if (new Set(values).size !== values.length) {
    fail(path, "不能包含重复值");
  }
  return values;
}

function enumAt<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(path, `必须是 ${allowed.join("、")} 之一`);
  }
  return value as T[number];
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(path, `含未知字段：${unknown.join("、")}`);
  }
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0) {
    fail(path, `缺少字段：${missing.join("、")}`);
  }
}

function parseExpected(value: unknown, path: string): ExpectedBehavior {
  const item = objectAt(value, path);
  assertExactKeys(item, ["action", "mustCover", "mustNot"], path);
  return {
    action: enumAt(item.action, ACTIONS, `${path}.action`),
    mustCover: stringArrayAt(item.mustCover, `${path}.mustCover`),
    mustNot: stringArrayAt(item.mustNot, `${path}.mustNot`)
  };
}

function parseTurn(value: unknown, path: string): EvaluationTurn {
  const item = objectAt(value, path);
  assertExactKeys(item, ["role", "text", "expected"], path);
  if (item.role !== "user") fail(`${path}.role`, "当前只接受 user");
  return {
    role: "user",
    text: stringAt(item.text, `${path}.text`),
    expected: parseExpected(item.expected, `${path}.expected`)
  };
}

function parseAlternative(value: unknown, path: string): KnowledgeEvidenceAlternative {
  const item = objectAt(value, path);
  assertExactKeys(item, ["knowledge", "anchors"], path);
  const anchors = stringArrayAt(item.anchors, `${path}.anchors`, false);
  if (anchors.some((anchor) => anchor.length < 4)) {
    fail(`${path}.anchors`, "锚点不能短于 4 个字符");
  }
  return {
    knowledge: stringArrayAt(item.knowledge, `${path}.knowledge`, false),
    anchors
  };
}

export function parseEvaluationTask(value: unknown, path = "task"): EvaluationTask {
  const task = objectAt(value, path);
  assertExactKeys(
    task,
    ["id", "suite", "tags", "turns", "setup", "evidence", "trials", "provenance", "review"],
    path
  );
  const id = stringAt(task.id, `${path}.id`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) {
    fail(`${path}.id`, "只允许小写字母、数字和单连字符");
  }
  if (!Array.isArray(task.turns) || task.turns.length === 0) {
    fail(`${path}.turns`, "必须至少有一轮用户输入");
  }

  const setup = objectAt(task.setup, `${path}.setup`);
  assertExactKeys(setup, ["assessment", "knowledgeManifest"], `${path}.setup`);
  if (setup.assessment !== null) objectAt(setup.assessment, `${path}.setup.assessment`);

  const evidence = objectAt(task.evidence, `${path}.evidence`);
  assertExactKeys(
    evidence,
    ["mode", "acceptableEvidence", "forbiddenClaims"],
    `${path}.evidence`
  );
  const mode = enumAt(evidence.mode, EVIDENCE_MODES, `${path}.evidence.mode`);
  if (!Array.isArray(evidence.acceptableEvidence)) {
    fail(`${path}.evidence.acceptableEvidence`, "必须是数组");
  }
  const acceptableEvidence = evidence.acceptableEvidence.map((item, index) =>
    parseAlternative(item, `${path}.evidence.acceptableEvidence[${index}]`)
  );
  if (mode === "knowledge" && acceptableEvidence.length === 0) {
    fail(`${path}.evidence.acceptableEvidence`, "知识型任务必须提供至少一组证据");
  }
  if (mode === "rule" && acceptableEvidence.length > 0) {
    fail(`${path}.evidence.acceptableEvidence`, "规则型任务不能伪装知识证据");
  }

  if (typeof task.trials !== "number" || !Number.isInteger(task.trials) || task.trials < 1 || task.trials > 10) {
    fail(`${path}.trials`, "必须是 1 到 10 的整数");
  }

  const review = objectAt(task.review, `${path}.review`);
  assertExactKeys(review, ["product", "medical"], `${path}.review`);
  const medicalReview = enumAt(review.medical, MEDICAL_REVIEWS, `${path}.review.medical`);
  if (mode === "knowledge" && medicalReview === "not-applicable") {
    fail(`${path}.review.medical`, "知识型任务不能标记为 not-applicable");
  }

  const turns = task.turns.map((turn, index) => parseTurn(turn, `${path}.turns[${index}]`));
  if (turns.some((turn) => turn.expected.action === "answer") && mode !== "knowledge") {
    fail(`${path}.evidence.mode`, "包含 answer 的任务必须使用知识证据");
  }

  return {
    id,
    suite: enumAt(task.suite, SUITES, `${path}.suite`),
    tags: stringArrayAt(task.tags, `${path}.tags`, false),
    turns,
    setup: {
      assessment: setup.assessment as null | Record<string, unknown>,
      knowledgeManifest: stringAt(setup.knowledgeManifest, `${path}.setup.knowledgeManifest`)
    },
    evidence: {
      mode,
      acceptableEvidence,
      forbiddenClaims: stringArrayAt(evidence.forbiddenClaims, `${path}.evidence.forbiddenClaims`)
    },
    trials: task.trials,
    provenance: stringAt(task.provenance, `${path}.provenance`),
    review: {
      product: enumAt(review.product, PRODUCT_REVIEWS, `${path}.review.product`),
      medical: medicalReview
    }
  };
}

export function parseEvaluationJsonl(text: string, source = "tasks.jsonl"): EvaluationTask[] {
  const tasks: EvaluationTask[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`${source}:${index + 1}`, `不是合法 JSON：${detail}`);
    }
    tasks.push(parseEvaluationTask(value, `${source}:${index + 1}`));
  }
  if (tasks.length === 0) fail(source, "没有评测任务");
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) fail(source, `任务 id 重复：${task.id}`);
    ids.add(task.id);
  }
  return tasks;
}

export async function loadEvaluationJsonl(path: string): Promise<EvaluationTask[]> {
  return parseEvaluationJsonl(await readFile(path, "utf8"), path);
}

export async function verifyKnowledgeEvidence(
  tasks: readonly EvaluationTask[],
  knowledgeDirectory: string
): Promise<EvidenceVerificationSummary> {
  const fileCache = new Map<string, string>();
  let knowledgeTasks = 0;
  let alternatives = 0;
  let anchors = 0;
  for (const task of tasks) {
    if (task.evidence.mode === "rule") continue;
    knowledgeTasks += 1;
    for (const [alternativeIndex, alternative] of task.evidence.acceptableEvidence.entries()) {
      alternatives += 1;
      let matched = false;
      for (const knowledge of alternative.knowledge) {
        if (knowledge !== knowledge.split(/[\\/]/u).at(-1) || !knowledge.endsWith(".md")) {
          fail(`${task.id}.evidence[${alternativeIndex}].knowledge`, "只能引用知识目录下的 Markdown 文件名");
        }
        let content = fileCache.get(knowledge);
        if (content === undefined) {
          try {
            content = await readFile(join(knowledgeDirectory, knowledge), "utf8");
          } catch {
            fail(`${task.id}.evidence[${alternativeIndex}]`, `知识文件不存在：${knowledge}`);
          }
          fileCache.set(knowledge, content);
        }
        for (const anchor of alternative.anchors) {
          anchors += 1;
          if (content.includes(anchor)) matched = true;
        }
      }
      if (!matched) {
        fail(
          `${task.id}.evidence[${alternativeIndex}]`,
          `没有任何锚点命中：${alternative.anchors.join("、")}`
        );
      }
    }
  }
  return {
    tasks: tasks.length,
    knowledgeTasks,
    alternatives,
    files: fileCache.size,
    anchors
  };
}
