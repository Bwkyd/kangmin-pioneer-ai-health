import assert from "node:assert/strict";

// 测试进程以本地开发模式启动：组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为
// PlaintextEncryption（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../app/composition-root.js";
import { DomainError } from "../kernel/errors.js";
import type { CommandResult } from "../kernel/result.js";
import type { ExtractionCandidate } from "../modules/agent/model-ports.js";
import type { ConversationTurnResult } from "../modules/agent/conversation-contracts.js";
import { CLINICAL_FREEZE_BLOCK } from "../modules/agent/output-validation.js";
import {
  AesGcmEncryption,
  parseEncryptionKeys
} from "../infrastructure/aes-gcm-encryption.js";

const KEY_V1 = Buffer.alloc(32, 1).toString("base64");

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

interface Fixture {
  application: ReturnType<typeof createApplication>;
  extraction: FixedExtraction;
}

async function fixture(
  extractionRules: Array<{ match: string; candidate: ExtractionCandidate }> = [],
  extractionFail: DomainError | null = null
): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-conv-"));
  const extraction = new FixedExtraction(extractionRules, extractionFail);
  const application = createApplication(join(directory, "conv.sqlite"), {
    extraction,
    explanation: new NullExplanation()
  });
  return { application, extraction };
}

async function exec(
  application: ReturnType<typeof createApplication>,
  input: { message: string; conversationId?: string; saveConsent?: boolean },
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

test("未登录一次性体验：匿名对话可进行但不保存、不可列出", async () => {
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

test("安全阻断：高危输入直接阻断并结束对话，输出固定文案", async () => {
  const { application } = await fixture();
  try {
    const first = await exec(application, { message: "我最近鼻塞" });
    const blocked = await exec(application, {
      message: "急救：是",
      conversationId: first.conversationId
    });
    assert.equal(blocked.closed, true);
    assert.equal(blocked.state, "completed");
    assert.equal(blocked.verdict?.outcome, "blocked");
    assert.equal(blocked.verdict?.stage, "safety");
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
  const { application } = await fixture();
  try {
    const first = await exec(application, { message: "" });
    assert.equal(first.verdict?.stage, "safety");
    assert.equal(first.verdict?.outcome, "need_more_information");

    // 回答 unknown：不通过安全阶段，继续补问。
    const unknown = await exec(application, {
      message: "急救：不知道",
      conversationId: first.conversationId
    });
    assert.equal(unknown.verdict?.outcome, "need_more_information");
    assert.equal(unknown.verdict?.stage, "safety");
    assert.equal(unknown.closed, false);

    // 全部必要安全字段都确认 unknown → 无法取得进展 → fail-closed 结束。
    const second = await exec(application, {
      message: "高热：不知道",
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
  const { application } = await fixture([
    { match: "口渴", candidate: { fieldCode: "thirst", state: "yes", justification: "测试替身" } }
  ]);
  try {
    let turn = await exec(application, {
      message: "急救：否 高热：否 鼻出血：否 剧烈头痛：否 皮肤破损：否 怀孕：否 未满12周岁：否"
    });
    assert.equal(turn.verdict?.stage, "applicability");

    turn = await exec(application, {
      message: "阵发性喷嚏：是 清水样涕：是 鼻痒：是 鼻塞：是 感冒样表现：否 鼻窦炎样表现：否",
      conversationId: turn.conversationId
    });
    assert.equal(turn.verdict?.stage, "severity");

    turn = await exec(application, {
      message: "影响睡眠：否 影响日常活动：否 影响工作学习：否 难以忍受：否",
      conversationId: turn.conversationId
    });
    assert.equal(turn.verdict?.stage, "syndrome");

    turn = await exec(application, {
      message: "口渴：是 四肢不温：否 倦怠乏力：否",
      conversationId: turn.conversationId
    });
    // 裁决为 classified（轻度 + 肺经伏热）……
    assert.equal(turn.verdict?.outcome, "classified");
    assert.equal(turn.verdict?.stage, "completed");
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
        stage: string;
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
    assert.equal(boundShow.lastDecision?.stage, "completed");
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
  const { application } = await fixture(
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
    assert.equal(
      turn.notices[0]?.content,
      "智能提取服务暂不可用，请直接回答系统提问（如“怕风：是”）。"
    );
  } finally {
    application.close();
  }
});

test("模型提取候选：只返回待确认候选，不直接进入规则输入", async () => {
  const { application } = await fixture([
    { match: "口渴", candidate: { fieldCode: "thirst", state: "yes", justification: "测试替身" } }
  ]);
  try {
    const turn = await exec(application, { message: "我最近口渴" });
    assert.equal(turn.proposedCandidates.length, 1);
    assert.equal(turn.proposedCandidates[0]?.fieldCode, "thirst");
    assert.equal(turn.proposedCandidates[0]?.state, "yes");
    // 候选未确认前不进入规则输入：内核仍处于安全补问阶段。
    assert.equal(turn.verdict?.stage, "safety");
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

test("agent test run：模拟链路只验证不修改，方案阻断中，AI 解释为模板模拟", async () => {
  const { application } = await fixture();
  try {
    const result = dataOf<{
      verdict: { outcome: string; severityCode: string | null; syndromeCode: string | null };
      planBlocked: boolean;
      explanation: { simulated: true; content: string };
      knowledge: { state: string };
    }>(
      await application.execute({
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
      })
    );
    assert.equal(result.verdict.outcome, "classified");
    assert.equal(result.verdict.severityCode, "mild");
    assert.equal(result.verdict.syndromeCode, "LUNG_HEAT");
    assert.equal(result.planBlocked, true);
    assert.equal(result.explanation.simulated, true);
    assert.equal(result.explanation.content, CLINICAL_FREEZE_BLOCK);
    assert.equal(result.knowledge.state, "not_available");
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
