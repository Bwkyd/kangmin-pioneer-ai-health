import assert from "node:assert/strict";

// 测试进程以本地开发模式启动：组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为
// PlaintextEncryption（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdminApplication } from "../app/admin-composition-root.js";
import { createApplication } from "../app/composition-root.js";
import { DomainError } from "@kangmin/core/kernel/errors";
import type { CommandResult } from "@kangmin/core/kernel/result";
import type { RulePackage } from "@kangmin/core/intelligence/clinical-rules/domain";
import { DRAFT_RULE_PACKAGE } from "@kangmin/core/intelligence/clinical-rules/rule-package";
import type {
  ExtractionCandidate,
  PlanDialogueContext,
  PlanDialoguePort,
  PlanDialogueSource
} from "@kangmin/core/intelligence/agent/model-ports";
import type {
  KnowledgeRetrievalPort,
  KnowledgeSource
} from "@kangmin/core/intelligence/agent/knowledge-ports";
import type {
  ApprovedPlan,
  ClinicalVerdict,
  PlanRegistryPort
} from "@kangmin/core/intelligence/clinical-rules/contracts";
import { writeConsentForTest } from "./consent-fixture.js";
import type {
  ConversationSession,
  ConversationTurnResult
} from "@kangmin/core/intelligence/agent/conversation-contracts";
import type {
  AgentPlan,
  KnowledgeItem
} from "@kangmin/core/operations/agent-admin/contracts";
import type { CommitTurnInput } from "@kangmin/core/intelligence/agent/conversation-repository";
import { CLINICAL_FREEZE_BLOCK } from "@kangmin/core/intelligence/agent/output-validation";
import {
  AesGcmEncryption,
  parseEncryptionKeys,
  PlaintextEncryption
} from "../infrastructure/aes-gcm-encryption.js";
import { KangminDatabase } from "@kangmin/database/sqlite/database";
import { SqliteConversationRepository } from "@kangmin/database/sqlite/conversation-repository";
import { TestKnowledgeEmbedding } from "./test-knowledge-embedding.js";

const KEY_V1 = Buffer.alloc(32, 1).toString("base64");

function withoutQuestionnaireStrategy(rulePackage: RulePackage): RulePackage {
  const { questionnaireStrategy: _questionnaireStrategy, ...legacy } = rulePackage;
  return legacy;
}

/** 既有会话测试的旧流水线替身；生产装配仍使用 v3 页面问卷。 */
const LEGACY_PIPELINE_PACKAGE = withoutQuestionnaireStrategy(DRAFT_RULE_PACKAGE);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

/** 测试替身：按消息子串返回固定候选（模型职责：只提取，不做临床判断）。 */
class FixedExtraction {
  constructor(
    private readonly table: Array<{ match: string; candidate: ExtractionCandidate }>,
    private readonly failWith: DomainError | null = null
  ) {}

  async extractCandidates(input: { message: string }): Promise<ExtractionCandidate[]> {
    if (this.failWith !== null) {
      throw this.failWith;
    }
    return this.table
      .filter((entry) => input.message.includes(entry.match))
      .map((entry) => entry.candidate);
  }
}

/** 测试替身：解释永远回退固定模板。 */
class NullExplanation {
  async explain(): Promise<null> {
    return null;
  }
}

class FixedPlanDialogue implements PlanDialoguePort {
  followUpCalls = 0;

  async generatePlan(): Promise<string> {
    return "已根据规则结果整理为通俗说明，请只选择当前方案列出的操作，并先阅读注意事项。";
  }

  async answerFollowUp(input: {
    question: string;
    verdict: ClinicalVerdict;
    sources: readonly PlanDialogueSource[];
  }): Promise<string> {
    this.followUpCalls += 1;
    assert.ok(input.question.includes("迎香"));
    assert.equal(input.sources[0]?.name, "过敏性鼻炎适宜技术手册·迎香穴");
    return "迎香位于鼻翼外缘附近，具体定位请以已审核资料和操作视频为准；当前只采用方案列出的指腹擦迎香。";
  }
}

class NullPlanDialogue implements PlanDialoguePort {
  async generatePlan(): Promise<null> {
    return null;
  }

  async answerFollowUp(): Promise<null> {
    return null;
  }
}

class UnsafeHardFactPlanDialogue implements PlanDialoguePort {
  followUpCalls = 0;

  async generatePlan(): Promise<string> {
    return "已根据当前规则结果整理方案。";
  }

  async answerFollowUp(): Promise<string> {
    this.followUpCalls += 1;
    return "您没有怀孕，可以把通鼻喷剂加量使用，每天3次。";
  }
}

class CapturingPlanDialogue implements PlanDialoguePort {
  followUps: Array<{ question: string; context: PlanDialogueContext; sourceCount: number }> = [];

  async generatePlan(): Promise<string> {
    return "已根据当前评估整理方案，请继续询问不清楚的内容。";
  }

  async answerFollowUp(input: Parameters<PlanDialoguePort["answerFollowUp"]>[0]): Promise<string> {
    this.followUps.push({
      question: input.question,
      context: input.context,
      sourceCount: input.sources.length
    });
    return "我换一种简单说法：请只使用当前评估结果中已经列出的方案。";
  }
}

class EmptyKnowledgeRetrieval implements KnowledgeRetrievalPort {
  calls: Array<{ query: string; limit: number }> = [];

  async searchEnabled(query: string, limit: number): Promise<KnowledgeSource[]> {
    this.calls.push({ query, limit });
    return [];
  }
  async searchOne(): Promise<KnowledgeSource[]> { return []; }
}

class FixedKnowledgeRetrieval implements KnowledgeRetrievalPort {
  calls: Array<{ query: string; limit: number }> = [];

  async searchEnabled(query: string, limit: number): Promise<KnowledgeSource[]> {
    this.calls.push({ query, limit });
    return [{
      knowledgeId: "manual-yingxiang",
      name: "过敏性鼻炎适宜技术手册·迎香穴",
      category: null,
      source: "客户授权测试资料",
      chunkIndex: 1,
      text: "迎香位于鼻翼外缘附近。当前方案采用指腹擦迎香。",
      score: 0.92
    }];
  }
  async searchOne(query: string, _knowledgeId: string, limit: number): Promise<KnowledgeSource[]> {
    return this.searchEnabled(query, limit);
  }
}

class FixedPlanRegistry implements PlanRegistryPort {
  async findApprovedPlanBundle(): Promise<{
    acute: ApprovedPlan;
    constitution: ApprovedPlan;
  }> {
    const acute = {
      planId: "acute-yingxiang",
      planRevision: 1,
      name: "急性期迎香调理方案",
      method: "指腹擦迎香",
      steps: JSON.stringify(["指腹轻擦迎香，以皮肤温热为度"]),
      precautions: "皮肤破损时暂停操作。",
      videoResourceId: "video-yingxiang",
      attributes: {}
    };
    return {
      acute,
      constitution: {
        ...acute,
        planId: "constitution-yingxiang",
        name: "体质调理方案"
      }
    };
  }
}

interface Fixture {
  application: ReturnType<typeof createApplication>;
  extraction: FixedExtraction;
  databasePath: string;
}

async function fixture(
  extractionRules: Array<{ match: string; candidate: ExtractionCandidate }> = [],
  extractionFail: DomainError | null = null
): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-conv-"));
  const databasePath = join(directory, "conv.sqlite");
  const extraction = new FixedExtraction(extractionRules, extractionFail);
  const application = createApplication(databasePath, {
    extraction,
    explanation: new NullExplanation(),
    rulePackage: LEGACY_PIPELINE_PACKAGE
  });
  return { application, extraction, databasePath };
}

async function currentFixture(options: {
  planDialogue?: PlanDialoguePort;
  planKnowledgeRetrieval?: KnowledgeRetrievalPort;
  planRegistry?: PlanRegistryPort;
} = {}): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-conv-current-"));
  const databasePath = join(directory, "conv.sqlite");
  const extraction = new FixedExtraction([]);
  const application = createApplication(databasePath, {
    extraction,
    explanation: new NullExplanation(),
    ...options
  });
  return { application, extraction, databasePath };
}

async function completeCurrentAssessment(
  application: ReturnType<typeof createApplication>,
  token: string
): Promise<ConversationTurnResult> {
  let turn = await exec(application, { message: "开始评估" }, token);
  const answers = [
    "q1=C", "q2=B", "q3=B", "q4=C", "q5=D", "q6=B", "q7=C",
    "q8=C", "q9=A", "q10=B", "q11=D", "q8=B", "q10=A",
    "q12=C", "q13=B", "q14=B"
  ];
  for (const message of answers) {
    turn = await exec(
      application,
      { message, conversationId: turn.conversationId },
      token
    );
  }
  assert.equal(turn.verdict?.outcome, "classified");
  return turn;
}

/**
 * candidate 模拟包（防御语义验证）：冻结包已 approved，但 patientVerdict/
 * summarizeDecision 的裁剪与 renderValidatedOutput 的临床阻断是保留的
 * 防御路径（防未来解冻/回滚），用本包验证裁剪逻辑仍生效。
 */
function candidatePackage(): RulePackage {
  return {
    ...LEGACY_PIPELINE_PACKAGE,
    version: "clinical-rules-test-candidate",
    status: "candidate"
  };
}

/** candidate 包装配的应用（裁剪语义测试专用）。 */
async function fixtureWithCandidate(
  extractionRules: Array<{ match: string; candidate: ExtractionCandidate }> = [],
  extractionFail: DomainError | null = null
): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-conv-"));
  const databasePath = join(directory, "conv.sqlite");
  const extraction = new FixedExtraction(extractionRules, extractionFail);
  const application = createApplication(databasePath, {
    extraction,
    explanation: new NullExplanation(),
    rulePackage: candidatePackage()
  });
  return { application, extraction, databasePath };
}

async function exec(
  application: ReturnType<typeof createApplication>,
  input: {
    message: string;
    conversationId?: string;
    saveConsent?: boolean;
    startMode?: "inherit_assessment" | "reassess";
  },
  token?: string
): Promise<ConversationTurnResult> {
  return dataOf<ConversationTurnResult>(
    await application.execute({
      command: "agent exec",
      input,
      sessionToken: token
    })
  );
}

async function advanceToSyndrome(
  application: ReturnType<typeof createApplication>,
  token?: string
): Promise<ConversationTurnResult> {
  let turn = await exec(
    application,
    {
      message:
        "急救：否 高热：否 鼻出血：否 剧烈头痛：否 皮肤破损：否 怀孕：否 确诊过敏性鼻炎：是 未满12周岁：否"
    },
    token
  );
  turn = await exec(
    application,
    { message: "q1=C", conversationId: turn.conversationId },
    token
  );
  turn = await exec(
    application,
    {
      message: "感冒样表现：否 鼻窦炎样表现：否",
      conversationId: turn.conversationId
    },
    token
  );
  turn = await exec(
    application,
    {
      message: "影响睡眠：否 影响日常活动：否 影响工作学习：否 难以忍受：否",
      conversationId: turn.conversationId
    },
    token
  );
  assert.equal(turn.verdict?.nextQuestions[0]?.fieldCode, "step1_q10");
  return turn;
}

test("未登录一次性体验：匿名对话保留期内可凭 ID 续接、不保存、不可列出", async () => {
  const { application } = await fixture();
  try {
    const first = await exec(application, { message: "我最近鼻塞" });
    assert.equal(first.state, "active");
    assert.equal(first.saveConfirmationRequired, false);
    assert.equal(first.saved, false);
    assert.ok(first.message !== null);
    assert.ok(first.message.decisionId !== null); // assistant 必须绑定 decision
    assert.ok(first.message.content.includes("为了继续评估"));

    // 匿名续接同一对话。
    const second = await exec(application, {
      message: "急救：否",
      conversationId: first.conversationId
    });
    assert.equal(second.conversationId, first.conversationId);
    assert.ok(second.message !== null);

    // 匿名不能列出会话（未登录）。
    const list = await application.execute({ command: "agent conversations list" });
    assert.equal(list.ok, false);
    if (!list.ok) {
      assert.equal(list.error.code, "authentication_required");
    }
  } finally {
    application.close();
  }
});

test("决策序号每会话独立从 1 连续递增，不与消息序号混用（评审 P2）", async () => {
  const { application } = await fixture();
  try {
    const token =
      (await application.sessions.createDevelopmentSession("conv-seq")).token;
    const first = await exec(application, { message: "我最近鼻塞" }, token);
    const second = await exec(
      application,
      { message: "急救：否", conversationId: first.conversationId },
      token
    );
    assert.equal(second.conversationId, first.conversationId);
    assert.ok(second.message !== null);

    // 两轮共产生两条决策（消息流水为 user/assistant ×2 = 1..4，
    // 曾因共用计数器出现决策序号 1、4 空洞；语义为"第 N 条决策"，
    // 必须连续 1、2）。
    const show = dataOf<{
      decisionCount: number;
      messages: Array<{ sequence: number; role: string; content: string }>;
      lastDecision: {
        decisionSequence: number;
        nextQuestions: Array<{ fieldCode: string }>;
      };
    }>(
      await application.execute({
        command: "agent conversations show",
        input: { id: first.conversationId },
        sessionToken: token
      })
    );
    assert.equal(show.decisionCount, 2);
    assert.equal(show.lastDecision.decisionSequence, 2);
    const messageSequences = show.messages.map((message) => message.sequence);
    assert.deepEqual(messageSequences, [...messageSequences].sort((left, right) => left - right));
    assert.equal(new Set(messageSequences).size, messageSequences.length);
    assert.equal(show.messages[0]?.role, "user");
    assert.equal(show.messages[0]?.content, "我最近鼻塞");
    assert.equal(show.messages[2]?.content, "急救：否");
    assert.ok(show.lastDecision.nextQuestions.length > 0);
  } finally {
    application.close();
  }
});

test("按钮内部载荷保存为患者可读中文，历史对话不显示字段编码", async () => {
  const { application } = await fixture();
  try {
    const token =
      (await application.sessions.createDevelopmentSession("conv-visible-answer")).token;
    const first = await exec(application, { message: "我想了解我的鼻炎情况" }, token);
    await exec(
      application,
      { message: "urgent_help=no", conversationId: first.conversationId },
      token
    );

    const show = dataOf<{ messages: Array<{ role: string; content: string }> }>(
      await application.execute({
        command: "agent conversations show",
        input: { id: first.conversationId },
        sessionToken: token
      })
    );
    const answers = show.messages.filter((message) => message.role === "user");
    assert.equal(answers[1]?.content, "急救：否");
    assert.equal(show.messages.some((message) => message.content.includes("urgent_help=no")), false);
  } finally {
    application.close();
  }
});

test("生产 E2E：页面 Q1-Q14、六步二次确认与分期完整闭环", async () => {
  const { application, databasePath } = await currentFixture();
  const token =
    (await application.sessions.createDevelopmentSession("conv-current-page")).token;
  try {
    let turn = await exec(application, { message: "开始评估" }, token);
    assert.equal(turn.verdict?.nextQuestions[0]?.fieldCode, "q1");

    const constitution: Array<[string, string]> = [
      ["q1=C", "q2"], ["q2=B", "q3"], ["q3=B", "q4"], ["q4=C", "q5"],
      ["q5=D", "q6"], ["q6=B", "q7"], ["q7=C", "q8"], ["q8=C", "q9"],
      ["q9=A", "q10"], ["q10=B", "q11"], ["q11=D", "step5_q8_confirm"]
    ];
    for (const [message, expectedNext] of constitution) {
      turn = await exec(
        application,
        { message, conversationId: turn.conversationId },
        token
      );
      assert.equal(turn.verdict?.nextQuestions[0]?.fieldCode, expectedNext, message);
    }

    turn = await exec(
      application,
      { message: "q8=B", conversationId: turn.conversationId },
      token
    );
    assert.equal(turn.verdict?.nextQuestions[0]?.fieldCode, "step6_q10_confirm");
    turn = await exec(
      application,
      { message: "q10=A", conversationId: turn.conversationId },
      token
    );
    assert.equal(turn.verdict?.nextQuestions[0]?.fieldCode, "q12");

    for (const [message, expectedNext] of [
      ["q12=C", "q13"],
      ["q13=B", "q14"]
    ] as const) {
      turn = await exec(
        application,
        { message, conversationId: turn.conversationId },
        token
      );
      assert.equal(turn.verdict?.nextQuestions[0]?.fieldCode, expectedNext);
    }
    turn = await exec(
      application,
      { message: "q14=B", conversationId: turn.conversationId },
      token
    );
    assert.equal(turn.closed, true);
    assert.equal(turn.verdict?.outcome, "classified");
    assert.equal(turn.verdict?.syndromeCode, "COLD_HEAT_COMPLEX");
    assert.equal(turn.verdict?.phaseCode, "remission");
  } finally {
    application.close();
  }

  const database = new KangminDatabase(databasePath);
  try {
    const fields = database.connection
      .prepare("SELECT field_code FROM agent_confirmed_answers ORDER BY confirmed_at")
      .all()
      .map((row) => (row as { field_code: string }).field_code);
    for (let index = 1; index <= 14; index += 1) {
      assert.ok(fields.includes(`q${index}`), `缺少 q${index}`);
    }
    assert.ok(fields.includes("step5_q8_confirm"));
    assert.ok(fields.includes("step6_q10_confirm"));
  } finally {
    database.close();
  }
});

test("诊一诊小闭环：规则后动态生成、完成会话继续追问、方案外疗法确定性拒绝", async () => {
  const planDialogue = new FixedPlanDialogue();
  const retrieval = new FixedKnowledgeRetrieval();
  const { application } = await currentFixture({
    planDialogue,
    planKnowledgeRetrieval: retrieval,
    planRegistry: new FixedPlanRegistry()
  });
  const token =
    (await application.sessions.createDevelopmentSession("conv-plan-follow-up")).token;
  try {
    const completed = await completeCurrentAssessment(application, token);
    assert.equal(completed.state, "completed");
    assert.ok(completed.message?.content.includes("已根据规则结果整理为通俗说明"));
    assert.ok(completed.message?.content.includes("【已审核方案】"));
    assert.ok(completed.message?.content.includes("皮肤破损时暂停操作"));
    assert.ok(completed.message?.content.includes("【依据】"));

    const followUp = await exec(
      application,
      {
        message: "迎香穴具体位置在哪里？",
        conversationId: completed.conversationId
      },
      token
    );
    assert.equal(followUp.state, "completed");
    assert.equal(followUp.verdict?.outcome, "classified");
    assert.ok(followUp.message?.content.includes("迎香位于鼻翼外缘附近"));
    assert.ok(!followUp.message?.content.includes("【依据】"));
    assert.equal(planDialogue.followUpCalls, 1);
    assert.deepEqual(retrieval.calls, [{ query: "迎香穴具体位置在哪里？", limit: 3 }]);

    const refused = await exec(
      application,
      {
        message: "艾灸上火怎么办？",
        conversationId: completed.conversationId
      },
      token
    );
    assert.match(refused.message?.content ?? "", /专业操作参数|咨询医生、药师/u);
    assert.equal(planDialogue.followUpCalls, 1, "专业操作参数不得调用模型");
    assert.equal(retrieval.calls.length, 1, "专业操作参数不得触发知识搜索");

    const emergency = await exec(
      application,
      {
        message: "我现在胸闷憋气，喘不上气",
        conversationId: completed.conversationId
      },
      token
    );
    assert.match(emergency.message?.content ?? "", /立即联系急救或前往急诊/u);
    assert.ok(!emergency.message?.content.includes("【依据】"));
    assert.equal(retrieval.calls.length, 1, "急救硬门禁不得触发知识搜索");

    const show = dataOf<{ messages: Array<{ role: string; content: string }> }>(
      await application.execute({
        command: "agent conversations show",
        input: { id: completed.conversationId },
        sessionToken: token
      })
    );
    assert.ok(show.messages.some((message) => message.content.includes("迎香穴具体位置")));
    assert.ok(show.messages.some((message) => message.content.includes("艾灸上火")));
  } finally {
    application.close();
  }
});

test("患者级评估上下文：新聊天继承完整问卷，多轮承接不重复问卷，重新评估不提前覆盖", async () => {
  const planDialogue = new CapturingPlanDialogue();
  const retrieval = new EmptyKnowledgeRetrieval();
  const { application, databasePath } = await currentFixture({
    planDialogue,
    planKnowledgeRetrieval: retrieval,
    planRegistry: new FixedPlanRegistry()
  });
  const token =
    (await application.sessions.createDevelopmentSession("assessment-context-patient")).token;
  try {
    const completed = await completeCurrentAssessment(application, token);
    const greeting = await exec(application, {
      message: "你好",
      startMode: "inherit_assessment"
    }, token);
    assert.notEqual(greeting.conversationId, completed.conversationId);
    assert.match(greeting.message?.content ?? "", /已接续您最近的评估结果/u);
    assert.equal(planDialogue.followUps.length, 0, "纯寒暄不应调用千问");

    const inherited = await exec(application, {
      message: "我不明白",
      startMode: "inherit_assessment"
    }, token);
    assert.notEqual(inherited.conversationId, completed.conversationId);
    assert.equal(inherited.state, "completed");
    assert.equal(inherited.verdict?.outcome, "classified");
    assert.match(inherited.message?.content ?? "", /换一种简单说法/u);
    assert.equal(planDialogue.followUps.length, 1);
    const firstContext = planDialogue.followUps[0]?.context;
    assert.ok(firstContext);
    for (let index = 1; index <= 14; index += 1) {
      assert.ok(
        firstContext.assessment.answers.some((answer) => answer.fieldCode === `q${index}`),
        `继承上下文缺少 q${index}`
      );
    }
    assert.equal(firstContext.recentMessages.length, 0);
    assert.equal(planDialogue.followUps[0]?.sourceCount, 0, "解释当前方案不强制命中新知识");

    await exec(application, {
      message: "能再说简单一点吗？",
      conversationId: inherited.conversationId
    }, token);
    assert.equal(planDialogue.followUps.length, 2);
    assert.ok(planDialogue.followUps[1]?.context.recentMessages.some(
      (message) => message.role === "assistant" && message.content.includes("换一种简单说法")
    ));
    assert.ok(planDialogue.followUps[1]?.context.recentMessages.every(
      (message) => message.role !== "assistant" || !message.content.includes("【依据】")
    ));

    const reassessment = await exec(application, {
      message: "我想重新评估",
      startMode: "reassess"
    }, token);
    assert.equal(reassessment.state, "active");
    assert.ok(reassessment.verdict?.nextQuestions.length);

    const database = new KangminDatabase(databasePath);
    try {
      const counts = database.connection.prepare(`
        SELECT
          (SELECT COUNT(*) FROM agent_assessments WHERE status = 'current') AS current_count,
          (SELECT COUNT(*) FROM agent_assessments WHERE status = 'superseded') AS old_count
      `).get() as unknown as { current_count: number; old_count: number };
      assert.equal(counts.current_count, 1);
      assert.equal(counts.old_count, 0);
      database.connection.prepare(
        "UPDATE agent_assessments SET status = 'superseded', superseded_at = ? WHERE status = 'current'"
      ).run(new Date().toISOString());
    } finally {
      database.close();
    }

    const oldChatFollowUp = await exec(application, {
      message: "刚才那段还能继续解释吗？",
      conversationId: inherited.conversationId
    }, token);
    assert.equal(oldChatFollowUp.verdict?.outcome, "classified");
    assert.match(oldChatFollowUp.message?.content ?? "", /换一种简单说法/u);

    const symptomAddition = await exec(application, {
      message: "我今天又流鼻涕了",
      conversationId: inherited.conversationId
    }, token);
    assert.equal(symptomAddition.verdict?.syndromeCode, inherited.verdict?.syndromeCode);
    assert.equal(symptomAddition.verdict?.phaseCode, inherited.verdict?.phaseCode);
    assert.deepEqual(retrieval.calls, [
      { query: "我不明白", limit: 3 },
      { query: "能再说简单一点吗？", limit: 3 },
      { query: "刚才那段还能继续解释吗？", limit: 3 },
      { query: "我今天又流鼻涕了", limit: 3 }
    ], "普通追问统一只检索一次");
  } finally {
    application.close();
  }
});

test("诊一诊模型波动：模型不可用时不回显检索切片", async () => {
  const { application } = await currentFixture({
    planDialogue: new NullPlanDialogue(),
    planKnowledgeRetrieval: new FixedKnowledgeRetrieval(),
    planRegistry: new FixedPlanRegistry()
  });
  const token =
    (await application.sessions.createDevelopmentSession("conv-plan-evidence-fallback")).token;
  try {
    const completed = await completeCurrentAssessment(application, token);
    const followUp = await exec(
      application,
      {
        message: "迎香穴具体位置在哪里？",
        conversationId: completed.conversationId
      },
      token
    );
    assert.match(followUp.message?.content ?? "", /暂时没能生成回答/u);
    assert.ok(!followUp.message?.content.includes("迎香位于鼻翼外缘附近"));
    assert.ok(!followUp.message?.content.includes("过敏性鼻炎适宜技术手册·迎香穴"));
  } finally {
    application.close();
  }
});

test("明确药量请求在模型前分流，危险候选不生成也不进入历史", async () => {
  const planDialogue = new UnsafeHardFactPlanDialogue();
  const retrieval = new EmptyKnowledgeRetrieval();
  const { application } = await currentFixture({
    planDialogue,
    planKnowledgeRetrieval: retrieval,
    planRegistry: new FixedPlanRegistry()
  });
  const token =
    (await application.sessions.createDevelopmentSession("hard-fact-persistence")).token;
  try {
    const completed = await completeCurrentAssessment(application, token);
    const followUp = await exec(application, {
      message: "我有一瓶不知道名字的通鼻喷剂，一天喷几次？",
      conversationId: completed.conversationId
    }, token);
    assert.match(followUp.message?.content ?? "", /药品说明书|咨询医生、药师/u);
    assert.equal(planDialogue.followUpCalls, 0);
    assert.deepEqual(retrieval.calls, []);
    assert.ok(!followUp.message?.content.includes("加量"));
    assert.ok(!followUp.message?.content.includes("每天3次"));
    assert.ok(!followUp.message?.content.includes("没有怀孕"));

    const show = dataOf<{ messages: Array<{ role: string; content: string }> }>(
      await application.execute({
        command: "agent conversations show",
        input: { id: completed.conversationId },
        sessionToken: token
      })
    );
    const stored = show.messages.map((message) => message.content).join("\n");
    assert.ok(!stored.includes("加量"));
    assert.ok(!stored.includes("每天3次"));
    assert.ok(!stored.includes("没有怀孕"));
  } finally {
    application.close();
  }
});

test("诊一诊真实 SQLite E2E：后台启用方案与知识后，患者完成评估并追问", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-plan-dialogue-e2e-"));
  const databasePath = join(directory, "e2e.sqlite");
  const mediaDirectory = join(directory, "admin-media");
  mkdirSync(mediaDirectory, { recursive: true });

  const knowledgeEmbedding = new TestKnowledgeEmbedding();
  const admin = createAdminApplication(databasePath, {
    mediaDirectory,
    knowledgeEmbedding
  });
  const adminSession = await admin.sessions.createDevelopmentSession("plan-dialogue-owner");
  const adminToken = adminSession.token;
  try {
    const createAndEnablePlan = async (input: {
      name: string;
      syndrome: string;
      phaseCode?: "acute";
      method: string;
      steps: string[];
    }): Promise<AgentPlan> => {
      const created = dataOf<AgentPlan>(await admin.execute({
        command: "agent plan create",
        adminToken,
        input: {
          ...input,
          audience: "adult",
          precautions: "仅用于自动化验证，不作为真实操作说明。",
          risks: "测试数据不替代已审核医学资料。",
          contraindications: "真实使用前必须由客户启用正式方案。"
        }
      }));
      return dataOf<AgentPlan>(await admin.execute({
        command: "agent plan enable",
        adminToken,
        input: { id: created.id, expectedRevision: created.revision, yes: true }
      }));
    };

    await createAndEnablePlan({
      name: "急性期迎香测试方案",
      syndrome: "ACUTE",
      phaseCode: "acute",
      method: "指腹擦迎香",
      steps: ["指腹擦迎香"]
    });
    await createAndEnablePlan({
      name: "寒热错杂测试调体方案",
      syndrome: "COLD_HEAT_COMPLEX",
      method: "肺俞、风门、大椎、耳穴过敏区",
      steps: ["肺俞", "风门", "大椎", "耳穴过敏区"]
    });

    const knowledgeFile = join(mediaDirectory, "迎香测试资料.md");
    writeFileSync(
      knowledgeFile,
      "# 迎香测试资料\n\n迎香位于鼻翼外缘附近。当前测试方案采用指腹擦迎香。"
    );
    const added = dataOf<KnowledgeItem>(await admin.execute({
      command: "agent knowledge add",
      adminToken,
      input: { file: knowledgeFile, source: "客户授权测试资料" }
    }));
    const named = dataOf<KnowledgeItem>(await admin.execute({
      command: "agent knowledge update",
      adminToken,
      input: {
        id: added.id,
        name: "过敏性鼻炎适宜技术手册·迎香穴",
        source: "客户授权测试资料"
      }
    }));
    const indexed = dataOf<KnowledgeItem>(await admin.execute({
      command: "agent knowledge index",
      adminToken,
      input: { id: named.id }
    }));
    dataOf<KnowledgeItem>(await admin.execute({
      command: "agent knowledge enable",
      adminToken,
      input: { id: indexed.id, yes: true }
    }));
  } finally {
    admin.close();
  }

  const planDialogue = new FixedPlanDialogue();
  const patient = createApplication(databasePath, {
    extraction: new FixedExtraction([]),
    explanation: new NullExplanation(),
    planDialogue,
    knowledgeEmbedding
  });
  const patientToken =
    (await patient.sessions.createDevelopmentSession("plan-dialogue-patient")).token;
  try {
    const completed = await completeCurrentAssessment(patient, patientToken);
    assert.equal(completed.verdict?.syndromeCode, "COLD_HEAT_COMPLEX");
    assert.ok(completed.message?.content.includes("急性期迎香测试方案"));
    assert.ok(completed.message?.content.includes("寒热错杂测试调体方案"));

    const followUp = await exec(
      patient,
      {
        message: "迎香穴具体位置在哪里？",
        conversationId: completed.conversationId
      },
      patientToken
    );
    assert.ok(followUp.message?.content.includes("迎香位于鼻翼外缘附近"));
    assert.ok(!followUp.message?.content.includes("【依据】"));
    assert.equal(planDialogue.followUpCalls, 1);

    const database = new KangminDatabase(databasePath);
    try {
      const counts = database.connection.prepare(`
        SELECT
          (SELECT COUNT(*) FROM agent_plans WHERE status = 'enabled') AS plans,
          (SELECT COUNT(*) FROM agent_knowledge_items WHERE status = 'enabled') AS knowledge,
          (SELECT COUNT(*) FROM agent_conversations WHERE state = 'completed') AS conversations
      `).get() as unknown as { plans: number; knowledge: number; conversations: number };
      assert.equal(counts.plans, 2);
      assert.equal(counts.knowledge, 1);
      assert.equal(counts.conversations, 1);
    } finally {
      database.close();
    }
  } finally {
    patient.close();
  }
});

test("六步树 E2E：严格逐节点推进、二次确认独立入库并得到寒热错杂", async () => {
  const { application, databasePath } = await fixture();
  const token =
    (await application.sessions.createDevelopmentSession("conv-six-step")).token;
  let turn = await advanceToSyndrome(application, token);
  const steps: Array<[string, string]> = [
    ["q10=B", "step2_q8"],
    ["q8=C", "step3_q6"],
    ["q6=B", "step4_q9"],
    ["q9=A", "step5_q8_confirm"],
    ["q8=B", "step6_q10_confirm"]
  ];
  try {
    for (const [message, expectedNext] of steps) {
      turn = await exec(
        application,
        { message, conversationId: turn.conversationId },
        token
      );
      assert.equal(turn.closed, false, message);
      assert.equal(turn.verdict?.nextQuestions[0]?.fieldCode, expectedNext, message);
    }
    turn = await exec(
      application,
      { message: "q10=A", conversationId: turn.conversationId },
      token
    );
    assert.equal(turn.closed, true);
    assert.equal(turn.verdict?.outcome, "classified");
    assert.equal(turn.verdict?.syndromeCode, "COLD_HEAT_COMPLEX");
    assert.ok(turn.message?.content.includes("寒热错杂"));

    const show = dataOf<{ messages: Array<{ role: string; content: string }> }>(
      await application.execute({
        command: "agent conversations show",
        input: { id: turn.conversationId },
        sessionToken: token
      })
    );
    assert.equal(
      show.messages.some((message) => /q(?:6|8|9|10)=[A-C]/u.test(message.content)),
      false
    );
  } finally {
    application.close();
  }

  const database = new KangminDatabase(databasePath);
  try {
    const rows = database.connection
      .prepare(
        `SELECT field_code, value, fact_value
         FROM agent_confirmed_answers
         WHERE field_code LIKE 'step%'
         ORDER BY confirmed_at, field_code`
      )
      .all() as Array<{ field_code: string; value: string; fact_value: string }>;
    assert.equal(rows.length, 6);
    assert.deepEqual(
      new Map(rows.map((row) => [row.field_code, [row.value, row.fact_value]])),
      new Map([
        ["step1_q10", ["value", "B"]],
        ["step2_q8", ["value", "C"]],
        ["step3_q6", ["value", "B"]],
        ["step4_q9", ["value", "A"]],
        ["step5_q8_confirm", ["value", "B"]],
        ["step6_q10_confirm", ["value", "A"]]
      ])
    );
  } finally {
    database.close();
  }
});

test("旧规则未完成会话不能混入六步树继续", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-rule-upgrade-"));
  const databasePath = join(directory, "upgrade.sqlite");
  const legacy = createApplication(databasePath, {
    extraction: new FixedExtraction([]),
    explanation: new NullExplanation(),
    rulePackage: {
      ...DRAFT_RULE_PACKAGE,
      version: "clinical-rules-v1-legacy",
      checksum: "legacy-rule-package-hash"
    }
  });
  const first = await exec(legacy, { message: "开始旧评估" });
  legacy.close();

  const current = createApplication(databasePath, {
    extraction: new FixedExtraction([]),
    explanation: new NullExplanation()
  });
  try {
    const result = await current.execute({
      command: "agent exec",
      input: { message: "急救：否", conversationId: first.conversationId }
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "protocol_incompatible");
      assert.match(result.error.message, /新建对话/u);
    }
    const database = new KangminDatabase(databasePath);
    try {
      const row = database.connection
        .prepare("SELECT state FROM agent_conversations WHERE id = ?")
        .get(first.conversationId) as { state: string };
      assert.equal(row.state, "abandoned");
    } finally {
      database.close();
    }
  } finally {
    current.close();
  }
});

test("匿名会话登录后必须再次确认保存，不能自动绑定", async () => {
  const { application } = await fixture();
  try {
    const anonymous = await exec(application, { message: "我最近鼻塞" });

    const tokenA =
      (await application.sessions.createDevelopmentSession("conv-a")).token;
    const tokenB =
      (await application.sessions.createDevelopmentSession("conv-b")).token;

    // 登录后继续匿名会话但未确认保存：不能自动绑定。
    const pending = await exec(
      application,
      { message: "急救：否", conversationId: anonymous.conversationId },
      tokenA
    );
    assert.equal(pending.saveConfirmationRequired, true);
    assert.equal(pending.saved, false);

    const listBefore = dataOf<{ items: unknown[] }>(
      await application.execute({
        command: "agent conversations list",
        sessionToken: tokenA
      })
    );
    assert.equal(listBefore.items.length, 0);

    // 其他患者不能看到该匿名对话。
    const cross = await application.execute({
      command: "agent conversations show",
      input: { id: anonymous.conversationId },
      sessionToken: tokenB
    });
    assert.equal(cross.ok, false);
    if (!cross.ok) {
      assert.equal(cross.error.code, "resource_not_found");
    }

    // 明确确认保存后才绑定。
    const bound = await exec(
      application,
      {
        message: "口渴：是",
        conversationId: anonymous.conversationId,
        saveConsent: true
      },
      tokenA
    );
    assert.equal(bound.saved, true);
    assert.equal(bound.saveConfirmationRequired, false);

    const listAfter = dataOf<{ items: Array<{ id: string; patientId: string | null }> }>(
      await application.execute({
        command: "agent conversations list",
        sessionToken: tokenA
      })
    );
    assert.equal(listAfter.items.length, 1);
    assert.equal(listAfter.items[0]?.id, anonymous.conversationId);
    assert.equal(listAfter.items[0]?.patientId !== null, true);
  } finally {
    application.close();
  }
});

test("匿名调用者只能访问匿名会话：绑定患者后原匿名 id 不可再续接", async () => {
  const { application } = await fixture();
  try {
    const first = await exec(application, { message: "我最近鼻塞" });
    const token =
      (await application.sessions.createDevelopmentSession("conv-anon-owner")).token;
    const bound = await exec(
      application,
      { message: "", conversationId: first.conversationId, saveConsent: true },
      token
    );
    assert.equal(bound.saved, true);

    // 匿名调用者（未登录）用同一 conversationId 续接 → 会话已绑定患者，
    // 匿名分支必须走 patient_id IS NULL 过滤（评审 P1 codex #7）。
    const stale = await application.execute({
      command: "agent exec",
      input: { message: "急救：否", conversationId: first.conversationId }
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.error.code, "resource_not_found");
    }
  } finally {
    application.close();
  }
});

test("绑定匿名会话必须推进 revision：绑定只做所有权变更，CAS 生效", async () => {
  const { application } = await fixture();
  try {
    // 一轮内走到 completed（revision 1→2），随后只绑定不产生新轮次，
    // 便于直接观察绑定本身的 revision 推进（评审 P1 codex #8）。
    const first = await exec(application, { message: "急救：是" });
    assert.equal(first.closed, true);

    const token =
      (await application.sessions.createDevelopmentSession("conv-rev")).token;
    const bound = await exec(
      application,
      { message: "", conversationId: first.conversationId, saveConsent: true },
      token
    );
    assert.equal(bound.saved, true);

    const shown = dataOf<{ session: { revision: number } }>(
      await application.execute({
        command: "agent conversations show",
        input: { id: first.conversationId },
        sessionToken: token
      })
    );
    // 轮次提交后 revision=2；绑定必须推进到 3。修复前绑定保留原
    // revision（仍为 2），并发旧请求可用相同 expectedRevision 通过 CAS。
    assert.equal(shown.session.revision, 3);
  } finally {
    application.close();
  }
});

test("安全阻断：高危输入直接阻断并结束对话，输出固定文案", async () => {
  const { application } = await fixtureWithCandidate();
  try {
    const first = await exec(application, { message: "我最近鼻塞" });
    const blocked = await exec(application, {
      message: "急救：是",
      conversationId: first.conversationId
    });
    assert.equal(blocked.closed, true);
    assert.equal(blocked.state, "completed");
    assert.equal(blocked.verdict?.outcome, "blocked");
    // 评审 R2：candidate 状态下 stage 侧信道同样裁剪（阶段进展不可确认）。
    assert.equal(blocked.verdict?.stage, null);
    // 评审 P0-2：candidate 状态下患者侧 verdict 不暴露命中规则 ID。
    assert.deepEqual(blocked.verdict?.matchedRuleIds, []);
    assert.ok(blocked.message !== null);
    assert.ok(blocked.message.content.includes("立即就医"));
    assert.equal(blocked.message.contentHash, sha256(blocked.message.content));
    assert.equal(blocked.verdict?.rulePackageStatus, "candidate");

    // 已结束对话不能继续。
    const resumed = await application.execute({
      command: "agent exec",
      input: { message: "急救：否", conversationId: first.conversationId }
    });
    assert.equal(resumed.ok, false);
    if (!resumed.ok) {
      assert.equal(resumed.error.code, "validation_failed");
    }
  } finally {
    application.close();
  }
});

test("unknown 不等于 no：安全字段 unknown 走补问，无法进展时 fail-closed", async () => {
  const { application } = await fixtureWithCandidate();
  try {
    const first = await exec(application, { message: "" });
    // 评审 R2：candidate 下 stage 归一为 null（不暴露"处于安全阶段"）。
    assert.equal(first.verdict?.stage, null);
    assert.equal(first.verdict?.outcome, "need_more_information");

    // 回答 unknown：不通过安全阶段，继续补问。
    const unknown = await exec(application, {
      message: "急救：不知道",
      conversationId: first.conversationId
    });
    assert.equal(unknown.verdict?.outcome, "need_more_information");
    assert.equal(unknown.verdict?.stage, null);
    assert.equal(unknown.closed, false);

    // 只答 2 问 unknown 不 fail-closed：安全阶段待答全集 7 问，剩余
    // 问题本可完成分类（评审 P1 kimi P1-6：截断不影响进展判定）。
    const partial = await exec(application, {
      message: "高热：不知道",
      conversationId: first.conversationId
    });
    assert.equal(partial.closed, false);

    // 全部必要安全字段都确认 unknown → 无法取得进展 → fail-closed 结束。
    const second = await exec(application, {
      message: "鼻出血：不知道 剧烈头痛：不知道 皮肤破损：不知道 怀孕：不知道 未满12周岁：不知道",
      conversationId: first.conversationId
    });
    assert.equal(second.closed, true);
    assert.ok(second.message !== null);
    assert.ok(second.message.content.includes("unknown 不等于 no"));
  } finally {
    application.close();
  }
});

test("正式输出阻断：candidate 规则包即使裁决 classified 也不输出个性化方案", async () => {
  const { application } = await fixtureWithCandidate([
    { match: "口渴", candidate: { fieldCode: "thirst", state: "yes", justification: "测试替身" } }
  ]);
  try {
    let turn = await exec(application, {
      message: "急救：否 高热：否 鼻出血：否 剧烈头痛：否 皮肤破损：否 怀孕：否 确诊过敏性鼻炎：是 未满12周岁：否"
    });
    // 评审 R2：candidate 下 stage 归一为 null（进展侧信道裁剪），
    // 流程位置改由 outcome/nextQuestions 确认。
    assert.equal(turn.verdict?.stage, null);
    assert.equal(turn.verdict?.outcome, "need_more_information");

    turn = await exec(application, {
      message: "阵发性喷嚏：是 清水样涕：是 鼻痒：是 鼻塞：是 感冒样表现：否 鼻窦炎样表现：否",
      conversationId: turn.conversationId
    });
    assert.equal(turn.verdict?.stage, null);

    turn = await exec(application, {
      message: "影响睡眠：否 影响日常活动：否 影响工作学习：否 难以忍受：否",
      conversationId: turn.conversationId
    });
    assert.equal(turn.verdict?.stage, null);

    turn = await exec(application, {
      message: "q10=A",
      conversationId: turn.conversationId
    });
    // 裁决为 classified（轻度 + 肺经伏热）……
    assert.equal(turn.verdict?.outcome, "classified");
    assert.equal(turn.verdict?.stage, null);
    // 评审 P0-2：candidate 状态下对患者裁剪临床结构化字段——证型/
    // 严重度/命中规则/方案 ID 一律不输出，杜绝拼装完整方案的侧信道。
    assert.equal(turn.verdict?.severityCode, null);
    assert.equal(turn.verdict?.syndromeCode, null);
    assert.deepEqual(turn.verdict?.matchedRuleIds, []);
    assert.ok(!("planId" in (turn.verdict ?? {})), "verdict 不应携带 planId");
    // ……但正式输出是固定阻断文案，绝不输出个性化方案。
    assert.ok(turn.message !== null);
    assert.equal(turn.message.content, CLINICAL_FREEZE_BLOCK);
    assert.equal(turn.message.contentHash, sha256(CLINICAL_FREEZE_BLOCK));
    assert.ok(turn.message.decisionId !== null);
    assert.equal(turn.closed, true);

    // 决策凭证已保存：conversations show 返回决策元数据。
    const token =
      (await application.sessions.createDevelopmentSession("conv-classified")).token;
    // 未绑定的匿名对话对患者不可见（不列出、不可读取）。
    const invisible = await application.execute({
      command: "agent conversations show",
      input: { id: turn.conversationId },
      sessionToken: token
    });
    assert.equal(invisible.ok, false);
    if (!invisible.ok) {
      assert.equal(invisible.error.code, "resource_not_found");
    }
    // 登录后明确确认保存（绑定）才能读取。
    await exec(
      application,
      { message: "", conversationId: turn.conversationId, saveConsent: true },
      token
    );
    const boundShow = dataOf<{
      decisionCount: number;
      lastDecision: {
        outcome: string;
        stage: string | null;
        severityCode: string | null;
        syndromeCode: string | null;
        matchedRuleIds: string[];
        planId: string | null;
      };
    }>(
      await application.execute({
        command: "agent conversations show",
        input: { id: turn.conversationId },
        sessionToken: token
      })
    );
    assert.ok(boundShow.decisionCount >= 4);
    assert.equal(boundShow.lastDecision?.outcome, "classified");
    // 评审 R2：决策摘要的 stage 与临床字段一样裁剪（置 null）。
    assert.equal(boundShow.lastDecision?.stage, null);
    // 评审 P0-2：candidate 状态下决策摘要同样裁剪临床字段（无证型、
    // 无严重度、无命中规则、无 planId），患者无法借此拼装方案。
    assert.equal(boundShow.lastDecision?.severityCode, null);
    assert.equal(boundShow.lastDecision?.syndromeCode, null);
    assert.deepEqual(boundShow.lastDecision?.matchedRuleIds, []);
    assert.equal(boundShow.lastDecision?.planId, null);
  } finally {
    application.close();
  }
});

test("模型不可用降级：空候选 + 固定 system_notice，规则结果仍然有效", async () => {
  const { application } = await fixtureWithCandidate(
    [],
    new DomainError("provider_unavailable", "DeepSeek 模型服务未配置")
  );
  try {
    const turn = await exec(application, { message: "我最近鼻塞，晚上比较严重" });
    assert.ok(turn.message !== null);
    // 规则结果仍然有效：给出补问而不是空回答。
    assert.equal(turn.verdict?.outcome, "need_more_information");
    assert.ok(turn.message.content.includes("为了继续评估"));
    // 固定 system_notice 出现，且不绑定决策。
    assert.equal(turn.notices.length, 1);
    // 客户可读文案（评审 P0-9：不暴露"智能提取服务"内部术语）。
    assert.equal(
      turn.notices[0]?.content,
      "未识别到您的回答，请点击下方选项按钮回答，或直接输入“是 / 否 / 不清楚”。"
    );
  } finally {
    application.close();
  }
});

test("模型提取候选：只返回待确认候选，不直接进入规则输入", async () => {
  const { application } = await fixtureWithCandidate([
    { match: "口渴", candidate: { fieldCode: "thirst", state: "yes", justification: "测试替身" } }
  ]);
  try {
    const turn = await exec(application, { message: "我最近口渴" });
    assert.equal(turn.proposedCandidates.length, 1);
    assert.equal(turn.proposedCandidates[0]?.fieldCode, "thirst");
    assert.equal(turn.proposedCandidates[0]?.state, "yes");
    // 评审 P1 codex #9：模型原始 justification 不透传给患者。
    const view = turn.proposedCandidates[0] ?? {};
    assert.equal("value" in view, false);
    assert.equal("justification" in view, false);
    assert.ok(!JSON.stringify(turn).includes("测试替身"));
    // 候选未确认前不进入规则输入：内核仍处于安全补问阶段
    //（评审 R2：candidate 下 stage 裁剪为 null，不暴露阶段位置）。
    assert.equal(turn.verdict?.stage, null);
  } finally {
    application.close();
  }
});

test("模型候选 value/justification 绝不透传：患者只拿到 fieldCode 与 state", async () => {
  const { application } = await fixture([
    {
      match: "体温",
      candidate: {
        fieldCode: "fever_temp",
        state: "value",
        value: "39.5",
        justification: "模型推断的体温数值"
      }
    }
  ]);
  try {
    const turn = await exec(application, { message: "我最近体温 39.5 度" });
    assert.equal(turn.proposedCandidates.length, 1);
    const view = turn.proposedCandidates[0];
    assert.ok(view !== undefined);
    assert.equal(view.fieldCode, "fever_temp");
    assert.equal(view.state, "value");
    // 返回结构整体不携带模型原始 value/justification 文本：
    // 模型无法借此绕过 renderValidatedOutput 向患者输出任意文本。
    assert.equal("value" in view, false);
    assert.equal("justification" in view, false);
    const serialized = JSON.stringify(turn);
    assert.ok(!serialized.includes("39.5"));
    assert.ok(!serialized.includes("模型推断的体温数值"));
  } finally {
    application.close();
  }
});

test("fail-closed 基于未截断补问全集：4 问只答 2 问 unknown 不关闭，继续补问", async () => {
  const { application } = await fixtureWithCandidate();
  try {
    let turn = await exec(application, {
      message: "急救：否 高热：否 鼻出血：否 剧烈头痛：否 皮肤破损：否 怀孕：否 确诊过敏性鼻炎：是 未满12周岁：否"
    });
    assert.equal(turn.verdict?.stage, null);

    turn = await exec(application, {
      message: "阵发性喷嚏：是 清水样涕：是 鼻痒：是 鼻塞：是 感冒样表现：否 鼻窦炎样表现：否",
      conversationId: turn.conversationId
    });
    assert.equal(turn.verdict?.outcome, "need_more_information");
    assert.equal(turn.verdict?.stage, null);
    // 单次只展示 1 问（逐题一问），但严重度待答全集为 4 问。
    assert.equal(turn.verdict?.nextQuestions.length, 1);

    // 患者只对本轮展示的 1 问答 unknown：全集尚有 3 问可问 →
    // 不得 fail-closed（评审 P1 kimi P1-6：截断不影响进展判定）。
    const partial = await exec(application, {
      message: "影响睡眠：不知道",
      conversationId: turn.conversationId
    });
    assert.equal(partial.closed, false);
    assert.equal(partial.verdict?.outcome, "need_more_information");
    assert.equal(partial.verdict?.stage, null);
    assert.ok(partial.message !== null);
    assert.ok(partial.message.content.includes("为了继续评估"));

    // 剩余 3 问也答 unknown：全集 4 问全部 unknown → fail-closed。
    const exhausted = await exec(application, {
      message: "影响日常活动：不知道 影响工作学习：不知道 难以忍受：不知道",
      conversationId: turn.conversationId
    });
    assert.equal(exhausted.closed, true);
    assert.ok(exhausted.message !== null);
    assert.ok(exhausted.message.content.includes("无法继续评估"));
  } finally {
    application.close();
  }
});

test("反馈：helpful/unhelpful 可记录，非法评分被拒绝，原因加密存储", async () => {
  const { application } = await fixture();
  try {
    const turn = await exec(application, { message: "我最近鼻塞" });
    const helpful = dataOf<{ id: string; rating: string }>(
      await application.execute({
        command: "agent feedback",
        input: {
          conversationId: turn.conversationId,
          rating: "helpful",
          reason: "解释清楚"
        }
      })
    );
    assert.equal(helpful.rating, "helpful");
    assert.ok(helpful.id.length > 0);

    const unhelpful = dataOf<{ id: string; rating: string }>(
      await application.execute({
        command: "agent feedback",
        input: { conversationId: turn.conversationId, rating: "unhelpful" }
      })
    );
    assert.equal(unhelpful.rating, "unhelpful");

    const invalid = await application.execute({
      command: "agent feedback",
      input: { conversationId: turn.conversationId, rating: "neutral" }
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.error.code, "validation_failed");
    }

    const missing = await application.execute({
      command: "agent feedback",
      input: { conversationId: "no-such-conversation", rating: "helpful" }
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.error.code, "resource_not_found");
    }
  } finally {
    application.close();
  }
});

test("患者侧 agent test run 关闭：capability_unavailable（模拟链路属于管理端）", async () => {
  const { application } = await fixture();
  try {
    // 评审 R2 P0：患者 CLI 设计 §6 没有 test run 命令，模拟链路属于
    // 管理端（kangmin-admin agent test run，管理侧已有 capability_
    // unavailable 桩）。患者侧 `agent test run` 是 w4 擅自添加——修复
    // 为返回 capability_unavailable，绝不向匿名患者返回完整
    // ClinicalVerdict（severityCode/syndromeCode/matchedRuleIds/
    // planId/allQuestions 可一步枚举决策表，配合 browse plan show 拼
    // 出方案，P0-2 侧信道修复失效）。
    const result = await application.execute({
      command: "agent test run",
      input: {
        answers: [
          { fieldCode: "urgent_help", state: "no" },
          { fieldCode: "high_fever", state: "no" },
          { fieldCode: "epistaxis_foul_discharge", state: "no" },
          { fieldCode: "severe_neuro_symptoms", state: "no" },
          { fieldCode: "skin_lesion", state: "no" },
          { fieldCode: "pregnancy", state: "no" },
          { fieldCode: "child_under_12", state: "no" },
          { fieldCode: "paroxysmal_sneezing", state: "yes" },
          { fieldCode: "watery_rhinorrhea", state: "yes" },
          { fieldCode: "nasal_itching", state: "yes" },
          { fieldCode: "nasal_congestion", state: "yes" },
          { fieldCode: "cold_like_symptoms", state: "no" },
          { fieldCode: "sinusitis_like_symptoms", state: "no" },
          { fieldCode: "sleep_affected", state: "no" },
          { fieldCode: "daily_activity_affected", state: "no" },
          { fieldCode: "work_study_affected", state: "no" },
          { fieldCode: "symptoms_intolerable", state: "no" },
          { fieldCode: "thirst", state: "yes" },
          { fieldCode: "limbs_not_warm", state: "no" }
        ]
      }
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "capability_unavailable");
      assert.match(result.error.message, /kangmin-admin/u);
    }
    // 任何成功数据（verdict/planBlocked/explanation/knowledge）都不得出现。
    assert.equal("data" in result, false);
  } finally {
    application.close();
  }
});

test("test run 校验非法答案输入", async () => {
  const { application } = await fixture();
  try {
    const invalid = await application.execute({
      command: "agent test run",
      input: { answers: [{ fieldCode: "thirst", state: "maybe" }] }
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.error.code, "validation_failed");
    }
  } finally {
    application.close();
  }
});

test("加密策略：生产环境未配置密钥启动失败 config_missing；配置后正常", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-enc-"));
  const databasePath = join(directory, "enc.sqlite");

  assert.throws(
    () => createApplication(databasePath, { appEnvironment: "production" }),
    (error: unknown) =>
      error instanceof DomainError && error.code === "config_missing"
  );

  const keys = new AesGcmEncryption(parseEncryptionKeys(`v1:${KEY_V1}`));
  const production = createApplication(databasePath, {
    appEnvironment: "production",
    encryption: keys,
    extraction: new FixedExtraction([]),
    explanation: new NullExplanation()
  });
  try {
    const turn = await exec(production, { message: "我最近鼻塞" });
    assert.ok(turn.message !== null);
  } finally {
    production.close();
  }

  // local 未配置密钥：明文开发实现可启动（生产语义不可用于正式数据）。
  const local = createApplication(databasePath, {
    extraction: new FixedExtraction([]),
    explanation: new NullExplanation()
  });
  try {
    const turn = await exec(local, { message: "我最近鼻塞" });
    assert.ok(turn.message !== null);
  } finally {
    local.close();
  }
});

test("commitTurn 并发 CAS：旧 revision 提交返回 version_conflict 且无部分写入", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-conv-cas-"));
  const databasePath = join(directory, "conv.sqlite");
  const database = new KangminDatabase(databasePath);
  const repository = new SqliteConversationRepository(database);
  const encryption = new PlaintextEncryption();
  const timestamp = "2026-08-01T00:00:00.000Z";
  try {
    const session: ConversationSession = {
      id: "conv-cas-1",
      patientId: null,
      state: "active",
      saveConsentId: null,
      assessmentId: null,
      rulePackageVersion: "draft-2026-07",
      rulePackageHash: "rule-hash",
      revision: 1,
      lastSequence: 0,
      closedAt: null,
      retentionUntil: "2026-09-01T00:00:00.000Z",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await repository.createSession(session);

    const commitInput = (expectedRevision: number, next: ConversationSession): CommitTurnInput => ({
      sessionId: session.id,
      expectedRevision,
      answers: [],
      candidates: [],
      decision: {
        id: "decision-1",
        sessionId: session.id,
        decisionSequence: 1,
        sessionRevision: 1,
        inputSnapshotEncrypted: encryption.encrypt("快照"),
        inputSnapshotHash: "snapshot-hash",
        outcome: "need_more_information",
        stage: "safety",
        severityCode: null,
        syndromeCode: null,
        phaseCode: null,
        audience: null,
        rulePackageStatus: null,
        nextQuestionsJson: "[]",
        matchedRuleIdsJson: "[]",
        rulePackageVersion: "draft-2026-07",
        rulePackageHash: "rule-hash",
        planId: null,
        planRevision: null,
        createdAt: timestamp
      },
      messages: [
        {
          id: "message-1",
          sessionId: session.id,
          sequence: 1,
          role: "assistant",
          decisionId: "decision-1",
          contentEncrypted: encryption.encrypt("回复"),
          contentHash: "content-hash",
          createdAt: timestamp
        }
      ],
      next
    });

    // 第一轮：读到的 revision=1 提交成功（revision 1→2）。
    const first = await repository.commitTurn(
      commitInput(1, {
        ...session,
        revision: 2,
        lastSequence: 1,
        updatedAt: timestamp
      })
    );
    assert.deepEqual(first, { kind: "committed" });

    // 第二轮以旧 revision（1）提交：模拟并发窗口内另一轮已提交，
    // 本请求读到的会话 revision 已过期 → 整轮拒绝（CAS 乐观锁），
    // 不产生任何部分写入（决策/消息计数不变，revision 不推进）。
    const second = await repository.commitTurn(
      commitInput(1, {
        ...session,
        revision: 2,
        lastSequence: 3,
        updatedAt: timestamp
      })
    );
    assert.deepEqual(second, { kind: "version_conflict", currentRevision: 2 });

    const counts = database.connection.prepare(`
      SELECT
        (SELECT COUNT(*) FROM agent_decisions WHERE session_id = ?) AS decisions,
        (SELECT COUNT(*) FROM agent_messages WHERE session_id = ?) AS messages,
        (SELECT revision FROM agent_conversations WHERE id = ?) AS revision
    `).get(session.id, session.id, session.id) as unknown as {
      decisions: number;
      messages: number;
      revision: number;
    };
    assert.equal(counts.decisions, 1);
    assert.equal(counts.messages, 1);
    assert.equal(counts.revision, 2);
  } finally {
    database.close();
  }
});

test("agent start --message 走消息驱动对话；裸 agent 仍为安全外壳", async () => {
  const { application } = await fixture();
  try {
    const started = dataOf<ConversationTurnResult>(
      await application.execute({
        command: "agent start",
        input: { message: "我最近鼻塞" }
      })
    );
    assert.ok(started.conversationId.length > 0);
    assert.ok(started.message !== null);

    const token =
      (await application.sessions.createDevelopmentSession("conv-shell")).token;
    const shell = await application.execute({
      command: "agent start",
      sessionToken: token
    });
    assert.equal(shell.ok, true);
    const shellData = shell as { ok: true; data: { nextQuestion: { key: string } } };
    assert.equal(shellData.data.nextQuestion.key, "urgentHelp");
  } finally {
    application.close();
  }
});

test("过期匿名会话凭 ID 恢复被拒绝：匿名续接与登录认领均 resource_not_found", async () => {
  const { application, databasePath } = await fixture();
  try {
    // 保留期内凭 ID 续接成功（24h 匿名保留期语义，issue-155）。
    const first = await exec(application, { message: "我最近鼻塞" });
    assert.equal(first.state, "active");

    // 直接把 retention_until 调到过去，模拟超过 24h 保留期。
    const database = new KangminDatabase(databasePath);
    try {
      database.connection
        .prepare(
          "UPDATE agent_conversations SET retention_until = ? WHERE id = ?"
        )
        .run("2026-08-01T00:00:00.000Z", first.conversationId);
    } finally {
      database.close();
    }

    // 匿名续接：过期视为不存在。
    const resumed = await application.execute({
      command: "agent exec",
      input: { message: "急救：否", conversationId: first.conversationId }
    });
    assert.equal(resumed.ok, false);
    if (!resumed.ok) {
      assert.equal(resumed.error.code, "resource_not_found");
    }

    // 登录患者认领过期匿名会话：同样不存在（过期不可认领绑定）。
    const token =
      (await application.sessions.createDevelopmentSession("conv-expired"))
        .token;
    const claimed = await application.execute({
      command: "agent exec",
      input: {
        message: "",
        conversationId: first.conversationId,
        saveConsent: true
      },
      sessionToken: token
    });
    assert.equal(claimed.ok, false);
    if (!claimed.ok) {
      assert.equal(claimed.error.code, "resource_not_found");
    }
  } finally {
    application.close();
  }
});

/** 构造会话行（保留期/归属可变），供清理与过滤用例直接落库。 */
function sessionRow(
  id: string,
  patientId: string | null,
  retentionUntil: string
): ConversationSession {
  return {
    id,
    patientId,
    state: "active",
    saveConsentId: null,
    assessmentId: null,
    rulePackageVersion: "draft-2026-07",
    rulePackageHash: "rule-hash",
    revision: 1,
    lastSequence: 0,
    closedAt: null,
    retentionUntil,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z"
  };
}

test("清理过期匿名会话：级联删除 5 子表 + 主表，保留期内匿名与绑定会话不受影响", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-conv-cleanup-"));
  const databasePath = join(directory, "conv.sqlite");
  const database = new KangminDatabase(databasePath);
  const repository = new SqliteConversationRepository(database);
  const encryption = new PlaintextEncryption();
  const past = "2026-08-01T00:00:00.000Z";
  const future = "2099-01-01T00:00:00.000Z";
  try {
    // 绑定会话需要 patients 行支撑外键。
    database.connection
      .prepare("INSERT INTO patients(id, created_at) VALUES (?, ?)")
      .run("patient-bound", past);

    await repository.createSession(sessionRow("conv-expired", null, past));
    await repository.createSession(sessionRow("conv-fresh", null, future));
    // 绑定会话（90 天占位保留期）：即使 retention_until 已过也不得被
    // 匿名清理触碰。
    await repository.createSession(
      sessionRow("conv-bound", "patient-bound", past)
    );

    // 给过期匿名会话补齐 5 子表行。
    const timestamp = "2026-08-01T00:00:00.000Z";
    await repository.setConfirmedAnswer({
      sessionId: "conv-expired",
      fieldCode: "urgent_help",
      value: "no",
      factValue: null,
      source: "patient_confirmation",
      rulePackageVersion: "draft-2026-07",
      rulePackageHash: "rule-hash",
      revision: 1,
      confirmedAt: timestamp
    });
    await repository.addCandidate({
      id: "candidate-1",
      sessionId: "conv-expired",
      fieldCode: "thirst",
      proposedValueEncrypted: null,
      encryptionKeyVersion: "none",
      sourceMessageId: null,
      state: "proposed",
      createdAt: timestamp,
      decidedAt: null
    });
    await repository.saveDecision({
      id: "decision-1",
      sessionId: "conv-expired",
      decisionSequence: 1,
      sessionRevision: 1,
      inputSnapshotEncrypted: encryption.encrypt("快照"),
      inputSnapshotHash: "snapshot-hash",
      outcome: "need_more_information",
      stage: "safety",
      severityCode: null,
      syndromeCode: null,
      phaseCode: null,
      audience: null,
      rulePackageStatus: null,
      nextQuestionsJson: "[]",
      matchedRuleIdsJson: "[]",
      rulePackageVersion: "draft-2026-07",
      rulePackageHash: "rule-hash",
      planId: null,
      planRevision: null,
      createdAt: timestamp
    });
    await repository.appendMessage({
      id: "message-1",
      sessionId: "conv-expired",
      sequence: 1,
      role: "assistant",
      decisionId: "decision-1",
      contentEncrypted: encryption.encrypt("回复"),
      contentHash: "content-hash",
      createdAt: timestamp
    });
    await repository.addFeedback({
      id: "feedback-1",
      sessionId: "conv-expired",
      decisionId: "decision-1",
      rating: "helpful",
      reasonEncrypted: null,
      createdAt: timestamp
    });

    const deleted = await repository.deleteExpiredAnonymousSessions(
      new Date().toISOString()
    );
    assert.equal(deleted, 1);

    // 主表：过期匿名删除；保留期内匿名与绑定会话保留。
    assert.equal(await repository.findSession("conv-expired"), null);
    assert.ok((await repository.findSession("conv-fresh")) !== null);
    assert.ok((await repository.findSession("conv-bound")) !== null);

    // 5 子表无过期残留。
    for (const table of [
      "agent_messages",
      "agent_confirmed_answers",
      "agent_candidates",
      "agent_decisions",
      "agent_feedback"
    ]) {
      const row = database.connection
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
        .get("conv-expired") as unknown as { count: number };
      assert.equal(row.count, 0, table);
    }

    // findAnonymousSession 保留期过滤：过期查不到，保留期内可查。
    assert.equal(await repository.findAnonymousSession("conv-expired"), null);
    assert.ok((await repository.findAnonymousSession("conv-fresh")) !== null);
  } finally {
    database.close();
  }
});

test("组合根启动时 best-effort 清理过期匿名会话", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-conv-startup-"));
  const databasePath = join(directory, "conv.sqlite");
  // 预置过期匿名会话后关闭，模拟上次运行留下的过期数据。
  const seed = new KangminDatabase(databasePath);
  await new SqliteConversationRepository(seed).createSession(
    sessionRow("conv-startup-expired", null, "2026-08-01T00:00:00.000Z")
  );
  seed.close();

  const application = createApplication(databasePath, {
    extraction: new FixedExtraction([]),
    explanation: new NullExplanation()
  });
  try {
    // SQLite 驱动同步执行：启动清理在 createApplication 返回前已落库。
    const verify = new KangminDatabase(databasePath);
    try {
      const row = verify.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_conversations WHERE id = ?"
        )
        .get("conv-startup-expired") as unknown as { count: number };
      assert.equal(row.count, 0);
    } finally {
      verify.close();
    }
  } finally {
    application.close();
  }
});

test("绑定保存写入真实 agent_session_save 授权记录，save_consent_id 指向该记录", async () => {
  const { application, databasePath } = await fixture();
  try {
    const anonymous = await exec(application, { message: "我最近鼻塞" });
    const session = await application.sessions.createDevelopmentSession(
      "conv-consent"
    );
    const bound = await exec(
      application,
      {
        message: "",
        conversationId: anonymous.conversationId,
        saveConsent: true
      },
      session.token
    );
    assert.equal(bound.saved, true);

    const database = new KangminDatabase(databasePath);
    try {
      const conversation = database.connection
        .prepare("SELECT save_consent_id FROM agent_conversations WHERE id = ?")
        .get(anonymous.conversationId) as unknown as {
        save_consent_id: string | null;
      };
      const consents = database.connection
        .prepare(
          `SELECT id, decision FROM patient_consents
           WHERE patient_id = ? AND consent_type = 'agent_session_save'`
        )
        .all(session.patientId) as unknown as Array<{
        id: string;
        decision: string;
      }>;
      // 不再写随机 UUID：save_consent_id 等于真实授权记录 id。
      assert.equal(consents.length, 1);
      assert.equal(consents[0]?.decision, "granted");
      assert.equal(conversation.save_consent_id, consents[0]?.id);
    } finally {
      database.close();
    }
  } finally {
    application.close();
  }
});

test("agent_session_save 撤回后绑定被拒绝（consent_required）", async () => {
  const { application, databasePath } = await fixture();
  try {
    const anonymous = await exec(application, { message: "我最近鼻塞" });
    const session = await application.sessions.createDevelopmentSession(
      "conv-withdrawn"
    );
    await writeConsentForTest(
      databasePath,
      session.patientId,
      "agent_session_save",
      "withdrawn"
    );
    const denied = await application.execute({
      command: "agent exec",
      input: {
        message: "",
        conversationId: anonymous.conversationId,
        saveConsent: true
      },
      sessionToken: session.token
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.error.code, "consent_required");
      assert.match(denied.error.message, /account consent update/u);
    }
  } finally {
    application.close();
  }
});
