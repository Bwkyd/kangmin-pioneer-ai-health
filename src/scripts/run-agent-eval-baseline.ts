import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { createAdminApplication } from "../app/admin-composition-root.js";
import { createApplication } from "../app/composition-root.js";
import { DashscopeEmbeddingAdapter } from "../infrastructure/dashscope-embedding-adapter.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { QwenPlanDialogueAdapter } from "../infrastructure/qwen-plan-dialogue-adapter.js";
import { SqliteKnowledgeRetrieval } from "../infrastructure/sqlite-knowledge-retrieval.js";
import type { CommandResult } from "../kernel/result.js";
import type { KnowledgeRetrievalPort, KnowledgeSource } from "../modules/agent/knowledge-ports.js";
import type { PlanDialoguePort } from "../modules/agent/model-ports.js";
import type { ConversationTurnResult } from "../modules/agent/conversation-contracts.js";
import type { KnowledgeItem } from "../modules/agent-admin/contracts.js";
import { runEvaluationTasks } from "../evals/knowledge-qa/runner.js";
import { loadEvaluationJsonl, type EvaluationAction, type EvaluationTask } from "../evals/knowledge-qa/task-schema.js";
import type {
  EvaluationExecutor,
  EvaluationRetrievedSource,
  EvaluationTrialRecord,
  EvaluationTurnRecord,
  ProviderOutcome
} from "../evals/knowledge-qa/trial-record.js";

interface PlanSeed {
  id: string;
  name: string;
  syndrome: string;
  phaseCode: string;
  audience: string;
  method: string;
  steps: string[];
  precautions: string;
  risks: string;
  contraindications: string;
}

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data as T;
}

class RecordingRetrieval implements KnowledgeRetrievalPort {
  calls: KnowledgeSource[][] = [];

  constructor(private readonly delegate: KnowledgeRetrievalPort) {}

  reset(): void {
    this.calls = [];
  }

  async searchEnabled(query: string, limit: number): Promise<KnowledgeSource[]> {
    const sources = await this.delegate.searchEnabled(query, limit);
    this.calls.push(sources);
    return sources;
  }
}

class RecordingPlanDialogue implements PlanDialoguePort {
  providerOutcome: ProviderOutcome = "not_called";
  modelOutputs: string[] = [];

  constructor(private readonly delegate: PlanDialoguePort) {}

  reset(): void {
    this.providerOutcome = "not_called";
    this.modelOutputs = [];
  }

  async generatePlan(input: Parameters<PlanDialoguePort["generatePlan"]>[0]) {
    return this.delegate.generatePlan(input);
  }

  async answerFollowUp(input: Parameters<PlanDialoguePort["answerFollowUp"]>[0]) {
    try {
      const answer = await this.delegate.answerFollowUp(input);
      this.providerOutcome = answer === null ? "failed" : "ok";
      if (answer !== null) this.modelOutputs.push(answer);
      return answer;
    } catch (error) {
      this.providerOutcome = "failed";
      throw error;
    }
  }
}

function inferAction(text: string): EvaluationAction {
  if (/(?:立即|马上).*(?:急救|急诊|120)|前往急诊/u.test(text)) return "emergency_redirect";
  if (/(?:(?:我|本工具).{0,12}(?:不能|无法)|不建议自行|需要由专业人员|请咨询医生|不能把.{0,20}(?:建议|做法))/u.test(text)) {
    return "refuse_operation";
  }
  if (/(?:请补充|缺少.{0,16}(?:药名|规格|医嘱)|当前资料还不够|我查了.{0,20}(?:没有找到|还没有找到).{0,12}(?:依据|资料))/u.test(text)) return "clarify";
  return "answer";
}

function retrievedSources(calls: readonly KnowledgeSource[][]): EvaluationRetrievedSource[] {
  const latest = calls.at(-1) ?? [];
  return latest.map((source) => ({ ...source, enabled: true }));
}

async function seedFixture(databasePath: string, knowledgeDirectory: string): Promise<void> {
  const admin = createAdminApplication(databasePath);
  try {
    const token = (await admin.sessions.createDevelopmentSession("agent-eval-seed")).token;
    const run = async <T>(command: string, input: Record<string, unknown>): Promise<T> =>
      dataOf<T>(await admin.execute({ command, adminToken: token, input }));
    const seeds = JSON.parse(
      await readFile(resolve("scripts/seed-plans.json"), "utf8")
    ) as PlanSeed[];
    for (const plan of seeds) {
      const created = await run<{ id: string; status: string; revision: number }>("agent plan create", {
        name: plan.name,
        syndrome: plan.syndrome,
        phaseCode: plan.phaseCode,
        audience: plan.audience,
        method: plan.method,
        steps: plan.steps,
        precautions: plan.precautions,
        risks: plan.risks,
        contraindications: plan.contraindications,
        idempotencyKey: `eval-seed-plan:${plan.id}`
      });
      if (created.status !== "enabled") {
        await run("agent plan enable", {
          id: created.id,
          expectedRevision: created.revision,
          yes: true
        });
      }
    }

    const files = (await readdir(knowledgeDirectory))
      .filter((name) => /^\d{2}-.+\.md$/u.test(name))
      .sort();
    if (files.length !== 17) throw new Error(`评测知识准备稿必须是 17 份，实际 ${files.length}`);
    for (const name of files) {
      const added = await run<KnowledgeItem>("agent knowledge add", {
        file: join(knowledgeDirectory, name),
        source: "《福建省中医药适宜技术手册》评测隔离快照"
      });
      const indexed = await run<KnowledgeItem>("agent knowledge index", { id: added.id });
      await run("agent knowledge enable", { id: indexed.id, yes: true });
    }
  } finally {
    admin.close();
  }
}

async function executeAgentTurn(
  application: ReturnType<typeof createApplication>,
  token: string,
  input: { message: string; conversationId?: string | undefined; startMode?: "inherit_assessment" | undefined }
): Promise<ConversationTurnResult> {
  return dataOf<ConversationTurnResult>(await application.execute({
    command: "agent exec",
    sessionToken: token,
    input
  }));
}

async function completeAssessment(
  application: ReturnType<typeof createApplication>,
  token: string
): Promise<void> {
  let turn = await executeAgentTurn(application, token, { message: "开始评估" });
  for (const message of [
    "q1=C", "q2=B", "q3=B", "q4=C", "q5=D", "q6=B", "q7=C",
    "q8=C", "q9=A", "q10=B", "q11=D", "q8=B", "q10=A",
    "q12=C", "q13=B", "q14=B"
  ]) {
    turn = await executeAgentTurn(application, token, {
      message,
      conversationId: turn.conversationId
    });
  }
  if (turn.verdict?.outcome !== "classified") throw new Error("隔离评估没有得到 classified");
}

class ApplicationEvaluationExecutor implements EvaluationExecutor {
  private readonly tasksById: Map<string, EvaluationTask>;

  constructor(
    tasks: readonly EvaluationTask[],
    private readonly application: ReturnType<typeof createApplication>,
    private readonly token: string,
    private readonly dialogue: RecordingPlanDialogue,
    private readonly retrieval: RecordingRetrieval,
    private readonly snapshot: EvaluationTrialRecord["snapshot"]
  ) {
    this.tasksById = new Map(tasks.map((task) => [task.id, task]));
  }

  async execute(taskId: string, trial: number): Promise<EvaluationTrialRecord> {
    const task = this.tasksById.get(taskId);
    if (task === undefined) throw new Error(`未知任务：${taskId}`);
    const records: EvaluationTurnRecord[] = [];
    let conversationId: string | undefined;
    for (const [index, turn] of task.turns.entries()) {
      this.dialogue.reset();
      this.retrieval.reset();
      const started = performance.now();
      const result = await executeAgentTurn(this.application, this.token, {
        message: turn.text,
        ...(index === 0 ? { startMode: "inherit_assessment" as const } : { conversationId })
      });
      conversationId = result.conversationId;
      const finalText = result.message?.content ?? result.notices.map((notice) => notice.content).join("\n");
      const show = dataOf<{ messages: Array<{ role: string; content: string }> }>(
        await this.application.execute({
          command: "agent conversations show",
          sessionToken: this.token,
          input: { id: result.conversationId }
        })
      );
      const persistedText = [...show.messages].reverse().find((message) => message.role === "assistant")?.content ?? null;
      const retrieved = retrievedSources(this.retrieval.calls);
      records.push({
        input: turn.text,
        observedAction: inferAction(finalText),
        finalText,
        retrieved,
        returnedSources: retrieved
          .filter((source) => finalText.includes(source.name))
          .map(({ knowledgeId, name, source }) => ({ knowledgeId, name, source })),
        providerOutcome: this.dialogue.providerOutcome,
        modelOutput: this.dialogue.modelOutputs.at(-1) ?? null,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        streamedText: null,
        persistedText
      });
    }
    return {
      taskId,
      trial,
      startedAt: new Date().toISOString(),
      snapshot: this.snapshot,
      turns: records
    };
  }
}

async function main(): Promise<void> {
  const [taskArgument, knowledgeArgument, databaseArgument, outputArgument] = process.argv.slice(2);
  if ([taskArgument, knowledgeArgument, databaseArgument, outputArgument].some((value) => value === undefined)) {
    throw new Error("用法：run-agent-eval-baseline <tasks.jsonl> <准备稿目录> <隔离数据库> <输出目录>");
  }
  process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
  process.env.KANGMIN_APP_ENV = "local";
  const taskPath = resolve(taskArgument!);
  const knowledgeDirectory = resolve(knowledgeArgument!);
  const databasePath = resolve(databaseArgument!);
  const outputDirectory = resolve(outputArgument!);
  try {
    await stat(databasePath);
    throw new Error("隔离数据库路径已经存在，拒绝覆盖");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(outputDirectory, { recursive: false });
  const tasks = await loadEvaluationJsonl(taskPath);
  await seedFixture(databasePath, knowledgeDirectory);

  const rawDialogue = new QwenPlanDialogueAdapter({
    apiKey: process.env.KANGMIN_QWEN_API_KEY,
    model: process.env.KANGMIN_QWEN_MODEL
  });
  const dialogue = new RecordingPlanDialogue(rawDialogue);
  const evaluationDatabase = new KangminDatabase(databasePath);
  const embedding = new DashscopeEmbeddingAdapter({
    apiKey: process.env.KANGMIN_QWEN_API_KEY,
    model: process.env.KANGMIN_EMBEDDING_MODEL,
    baseUrl: process.env.KANGMIN_EMBEDDING_BASE_URL
  });
  const retrieval = new RecordingRetrieval(
    new SqliteKnowledgeRetrieval(evaluationDatabase, embedding)
  );
  const application = createApplication(databasePath, {
    planDialogue: dialogue,
    planKnowledgeRetrieval: retrieval
  });
  try {
    const token = (await application.sessions.createDevelopmentSession("agent-eval-patient")).token;
    await completeAssessment(application, token);
    const codeSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolve(".."),
      encoding: "utf8"
    }).trim();
    const snapshot: EvaluationTrialRecord["snapshot"] = {
      codeSha: `working-tree:${codeSha}`,
      taskSet: basename(taskPath),
      knowledgeManifest: tasks[0]!.setup.knowledgeManifest,
      rulePackage: "clinical-rules-v3",
      model: process.env.KANGMIN_QWEN_MODEL?.trim() || "qwen3.7-flash",
      embeddingModel: embedding.modelName
    };
    const executor = new ApplicationEvaluationExecutor(
      tasks,
      application,
      token,
      dialogue,
      retrieval,
      snapshot
    );
    const result = await runEvaluationTasks(tasks, executor, { trialsPerTask: 1 });
    await writeFile(
      join(outputDirectory, "trials.jsonl"),
      `${result.trials.map((trial) => JSON.stringify(trial)).join("\n")}\n`,
      "utf8"
    );
    await writeFile(
      join(outputDirectory, "grades.jsonl"),
      `${result.grades.map((grade) => JSON.stringify(grade)).join("\n")}\n`,
      "utf8"
    );
    await writeFile(join(outputDirectory, "summary.json"), `${JSON.stringify(result.summary, null, 2)}\n`, "utf8");
    const failures = result.grades
      .filter((grade) => !grade.deterministicPassed)
      .map((grade) => `- ${grade.taskId}: ${grade.checks.filter((item) => !item.passed).map((item) => item.id).join("、")}`);
    await writeFile(
      join(outputDirectory, "summary.md"),
      [
        "# 患者智能体 10 题单次基线",
        "",
        `- 任务：${result.summary.tasks}`,
        `- 试次：${result.summary.trials}`,
        `- L0 确定性通过：${result.summary.deterministicPassed}`,
        `- L0 确定性失败：${result.summary.deterministicFailed}`,
        `- 待人工质量复核：${result.summary.pendingManualReview}`,
        "",
        "## 确定性失败",
        "",
        ...(failures.length === 0 ? ["- 无"] : failures),
        ""
      ].join("\n"),
      "utf8"
    );
    process.stdout.write(`${JSON.stringify(result.summary)}\n`);
  } finally {
    application.close();
    evaluationDatabase.close();
  }
}

if (process.argv[1]?.endsWith("run-agent-eval-baseline.js")) {
  await main();
}
