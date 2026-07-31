/**
 * 消息驱动 Agent 对话服务：会话状态机 + 规则内核编排 + 决策凭证。
 *
 * 流水线（患者 CLI 设计 §6.3）：
 *   结构化回答/模型提取 → 患者确认 → 固定安全规则 → 适用范围 →
 *   严重度 → 证型 → 方案安全 → 解释 → 输出校验 → 保存决策凭证
 *
 * 临床红线：
 * - 规则包 status=candidate 时，即使裁决为 classified，输出必须是固定
 *   阻断文案，绝不输出正式个性化方案；
 * - unknown 不等于 no；补问无法取得进展时 fail-closed；
 * - 冲突/无命中不猜测；
 * - 模型失败只降级（空候选/固定模板），固定规则结果始终有效；
 * - assistant 消息只绑定已完成的 decision，content_hash 等于已校验输出；
 * - 日志不含聊天正文、输入快照明文与令牌。
 */

import { createHash, randomUUID } from "node:crypto";

import type {
  ClinicalRuleKernelPort,
  ClinicalVerdict,
  ConfirmedFact,
  NextQuestion
} from "../clinical-rules/contracts.js";
import { DomainError } from "../../kernel/errors.js";
import type { EncryptionPort } from "../../kernel/encryption.js";
import { parseStructuredAnswers } from "./answer-parser.js";
import type { ConversationRepository } from "./conversation-repository.js";
import type {
  CandidateRow,
  ConfirmedAnswerRow,
  ConversationMessage,
  ConversationSession,
  ConversationShowResult,
  ConversationTurnInput,
  ConversationTurnResult,
  ConversationTestRunInput,
  ConversationTestRunResult,
  DecisionRow,
  DecisionSummary,
  EncryptedContent,
  ProposedCandidateView
} from "./conversation-contracts.js";
import type {
  ExplanationFields,
  ExtractionCandidate,
  ModelExplanationPort,
  ModelExtractionPort
} from "./model-ports.js";
import {
  EXTRACTION_UNAVAILABLE_NOTICE,
  FAIL_CLOSED_INFO_NOTICE,
  FAIL_CLOSED_SAFETY_NOTICE,
  renderValidatedOutput,
  systemNotice
} from "./output-validation.js";

/** 匿名会话保留期（一次性体验，未绑定患者的短保留）。 */
const ANONYMOUS_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 绑定会话保留期：保留期限未书面确认前的占位值，不得在生产承诺。 */
const BOUND_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 稳定序列化的输入快照：键排序，保证同事实同哈希。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalJson(entry)}`
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function answersToFacts(answers: readonly ConfirmedAnswerRow[]): ConfirmedFact[] {
  return answers.map((answer) => ({
    fieldCode: answer.fieldCode,
    state: answer.value as ConfirmedFact["state"],
    value: answer.factValue ?? undefined,
    source: answer.source
  }));
}

export class ConversationService {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly kernel: ClinicalRuleKernelPort,
    private readonly extraction: ModelExtractionPort,
    private readonly explanation: ModelExplanationPort,
    private readonly encryption: EncryptionPort
  ) {}

  /** 单轮对话：创建或续接会话、评估、校验输出、保存决策凭证。 */
  async execTurn(input: ConversationTurnInput): Promise<ConversationTurnResult> {
    const timestamp = now();
    const message = input.message.trim();

    const existing =
      input.conversationId === undefined
        ? null
        : await this.findSessionForCaller(input.conversationId, input.patientId);
    let session: ConversationSession;
    if (existing === null) {
      session = this.createSession(input.patientId, timestamp);
      await this.repository.createSession(session);
    } else {
      session = existing;
    }

    let saved = false;
    let saveConfirmationRequired = false;
    if (session.patientId === null && input.patientId !== null) {
      // 匿名会话被已登录患者继续：必须再次确认保存，绝不自动绑定。
      if (input.saveConsent === true) {
        const bound: ConversationSession = {
          ...session,
          patientId: input.patientId,
          saveConsentId: randomUUID(),
          retentionUntil: this.boundRetention(timestamp),
          // 绑定是所有权变更：必须推进 revision，CAS 才会拒绝并发旧请求
          // （评审 P1 codex #8：保留原 revision 时，旧请求可用相同
          // expectedRevision 通过 CAS，把已绑定会话写回匿名状态）。
          revision: session.revision + 1,
          updatedAt: timestamp
        };
        await this.updateSession(session, bound);
        session = bound;
        saved = true;
      } else {
        saveConfirmationRequired = true;
      }
    }

    if (session.state !== "active") {
      if (saved) {
        // 已结束的匿名对话仍可确认保存（只绑定，不再产生新轮次）。
        return {
          conversationId: session.id,
          state: session.state,
          message: null,
          notices: [],
          verdict: null,
          proposedCandidates: [],
          saveConfirmationRequired: false,
          saved: true,
          closed: true
        };
      }
      throw new DomainError(
        "validation_failed",
        "对话已结束，不能继续回答"
      );
    }

    const decisions = await this.repository.listDecisions(session.id);
    const lastDecision = decisions[decisions.length - 1] ?? null;
    const lastQuestions: NextQuestion[] =
      lastDecision === null
        ? []
        : (JSON.parse(lastDecision.nextQuestionsJson) as NextQuestion[]);

    const confirmedAnswers = await this.repository.listConfirmedAnswers(session.id);
    const unknownAnswered = new Set(
      confirmedAnswers
        .filter((answer) => answer.value === "unknown")
        .map((answer) => answer.fieldCode)
    );

    // 1. 确定性结构化回答（模型降级路径）：先收集，随轮次单事务提交
    //    （评审 B P1-2 原子化：不再逐条独立事务写库）。
    const pendingAnswers: ConfirmedAnswerRow[] = [];
    for (const answer of parseStructuredAnswers(message, lastQuestions)) {
      const row: ConfirmedAnswerRow = {
        sessionId: session.id,
        fieldCode: answer.fieldCode,
        value: answer.state,
        factValue: null,
        source: "patient_confirmation",
        rulePackageVersion: session.rulePackageVersion,
        rulePackageHash: session.rulePackageHash,
        revision: session.revision,
        confirmedAt: timestamp
      };
      pendingAnswers.push(row);
      if (answer.state === "unknown") {
        unknownAnswered.add(answer.fieldCode);
      } else {
        unknownAnswered.delete(answer.fieldCode);
      }
    }
    // 内存合并：已存答案 + 本轮新答案（新值按 field_code 覆盖旧值，
    // 与 SQL UPSERT 语义一致）。
    const mergedAnswers = [...confirmedAnswers];
    for (const answer of pendingAnswers) {
      const index = mergedAnswers.findIndex(
        (existing) => existing.fieldCode === answer.fieldCode
      );
      if (index >= 0) {
        mergedAnswers[index] = answer;
      } else {
        mergedAnswers.push(answer);
      }
    }
    const facts = answersToFacts(mergedAnswers);

    // 2. 模型提取待确认候选（失败只降级，绝不宽松解析）。
    let extractionFailed = false;
    let extracted: ExtractionCandidate[] = [];
    if (message !== "") {
      try {
        extracted = await this.extraction.extractCandidates({
          message,
          askedQuestions: lastQuestions,
          confirmedFacts: facts
        });
      } catch {
        extractionFailed = true;
      }
    }
    const proposedViews: ProposedCandidateView[] = [];
    const pendingCandidates: CandidateRow[] = [];
    for (const candidate of extracted) {
      const encrypted =
        candidate.state === "value" && candidate.value !== undefined
          ? this.encryption.encrypt(String(candidate.value))
          : null;
      const candidateId = randomUUID();
      pendingCandidates.push({
        id: candidateId,
        sessionId: session.id,
        fieldCode: candidate.fieldCode,
        proposedValueEncrypted: encrypted,
        encryptionKeyVersion: encrypted?.keyVersion ?? "none",
        sourceMessageId: null,
        state: "proposed",
        createdAt: timestamp,
        decidedAt: null
      });
      // 患者可见视图只暴露 fieldCode/state（评审 P1 codex #9）：
      // 模型原始 value/justification 只入密文库，绝不透传——否则模型
      // 可在这些字段输出诊断/药物/疗程文本，绕过 renderValidatedOutput
      // 的固定输出校验。患者确认流程凭 fieldCode 进行。
      proposedViews.push({
        id: candidateId,
        fieldCode: candidate.fieldCode,
        state: candidate.state
      });
    }

    // 3. 固定规则内核评估（唯一临床裁决来源）。
    const verdict = this.kernel.evaluate(facts);

    // 4. 补问无法取得进展 → fail-closed（unknown 不等于 no）。
    const escalated = this.failClosedIfNoProgress(verdict, unknownAnswered);

    // 5. 解释阶段：只有规则包 approved 时才调用模型解释；
    //    candidate 包正式输出被硬阻断，绝不输出个性化方案。
    let modelFields: ExplanationFields | null = null;
    if (
      verdict.outcome === "classified" &&
      this.kernel.rulePackageStatus === "approved"
    ) {
      try {
        modelFields = await this.explanation.explain(
          verdict,
          this.kernel.rulePackageStatus
        );
      } catch {
        modelFields = null;
      }
    }
    const validated = renderValidatedOutput(
      verdict,
      this.kernel.rulePackageStatus,
      modelFields
    );
    const finalOutput =
      escalated ?? validated;

    // 6-8. 决策凭证 + 消息 + 会话状态：构造后单事务提交
    //      （评审 B P1-2 原子化：任何一步失败整轮回滚；
    //      并发轮次因 CAS 版本不匹配被拒绝，不产生部分写入）。
    const snapshotJson = canonicalJson(facts);
    const snapshotEncrypted = this.encryption.encrypt(snapshotJson);
    const decisionId = randomUUID();
    const decision: DecisionRow = {
      id: decisionId,
      sessionId: session.id,
      decisionSequence: session.lastSequence + 1,
      sessionRevision: session.revision,
      inputSnapshotEncrypted: snapshotEncrypted,
      inputSnapshotHash: sha256(snapshotJson),
      outcome: verdict.outcome,
      stage: verdict.stage,
      severityCode: verdict.severityCode,
      syndromeCode: verdict.syndromeCode,
      nextQuestionsJson: JSON.stringify(verdict.nextQuestions),
      matchedRuleIdsJson: JSON.stringify(verdict.matchedRuleIds),
      rulePackageVersion: session.rulePackageVersion,
      rulePackageHash: session.rulePackageHash,
      planId: verdict.planId,
      planRevision: verdict.planRevision,
      createdAt: timestamp
    };

    let sequence = session.lastSequence + 1;
    const messages: ConversationMessage[] = [];
    if (message !== "") {
      messages.push({
        id: randomUUID(),
        sessionId: session.id,
        sequence,
        role: "user",
        decisionId: null,
        contentEncrypted: this.encryption.encrypt(message),
        contentHash: sha256(message),
        createdAt: timestamp
      });
      sequence += 1;
    }
    messages.push({
      id: randomUUID(),
      sessionId: session.id,
      sequence,
      role: "assistant",
      decisionId,
      contentEncrypted: this.encryption.encrypt(finalOutput.content),
      contentHash: finalOutput.contentHash,
      createdAt: timestamp
    });
    sequence += 1;
    const notices: Array<{ content: string; contentHash: string }> = [];
    if (extractionFailed && message !== "") {
      const notice = systemNotice("extraction_unavailable", EXTRACTION_UNAVAILABLE_NOTICE);
      messages.push({
        id: randomUUID(),
        sessionId: session.id,
        sequence,
        role: "system_notice",
        decisionId: null,
        contentEncrypted: this.encryption.encrypt(notice.content),
        contentHash: notice.contentHash,
        createdAt: timestamp
      });
      sequence += 1;
      notices.push({ content: notice.content, contentHash: notice.contentHash });
    }

    const closed =
      escalated !== null ||
      verdict.outcome === "blocked" ||
      verdict.outcome === "non_applicable" ||
      verdict.outcome === "conflict" ||
      verdict.outcome === "no_match" ||
      verdict.outcome === "classified";
    const next: ConversationSession = {
      ...session,
      revision: session.revision + 1,
      lastSequence: sequence,
      state: closed ? "completed" : "active",
      closedAt: closed ? timestamp : null,
      updatedAt: timestamp
    };

    const outcome = await this.repository.commitTurn({
      sessionId: session.id,
      expectedRevision: session.revision,
      answers: pendingAnswers,
      candidates: pendingCandidates,
      decision,
      messages,
      next
    });
    if (outcome.kind === "version_conflict") {
      throw new DomainError("version_conflict", "对话已更新，请重新读取", {
        details: {
          expectedRevision: session.revision,
          currentRevision: outcome.currentRevision
        }
      });
    }

    return {
      conversationId: session.id,
      state: next.state,
      message: {
        role: "assistant",
        content: finalOutput.content,
        contentHash: finalOutput.contentHash,
        decisionId
      },
      notices,
      verdict: this.patientVerdict(verdict),
      proposedCandidates: proposedViews,
      saveConfirmationRequired,
      saved,
      closed
    };
  }

  async listForPatient(patientId: string): Promise<ConversationSession[]> {
    return this.repository.listPatientSessions(patientId);
  }

  async showForPatient(
    patientId: string,
    conversationId: string
  ): Promise<ConversationShowResult> {
    const session = await this.repository.findPatientSession(
      patientId,
      conversationId
    );
    if (session === null) {
      throw new DomainError("resource_not_found", "对话不存在");
    }
    const decisions = await this.repository.listDecisions(session.id);
    const last = decisions[decisions.length - 1] ?? null;
    return {
      session,
      decisionCount: decisions.length,
      lastDecision: last === null ? null : this.summarizeDecision(last)
    };
  }

  private summarizeDecision(decision: DecisionRow): DecisionSummary {
    const trimmed =
      this.kernel.rulePackageStatus !== "approved";
    return {
      id: decision.id,
      decisionSequence: decision.decisionSequence,
      outcome: decision.outcome,
      stage: decision.stage,
      // 未临床冻结（candidate）时对患者裁剪临床字段：绝不通过
      // 结构化字段侧信道拼装完整方案（评审 P0-2，见 patientVerdict）。
      severityCode: trimmed ? null : decision.severityCode,
      syndromeCode: trimmed ? null : decision.syndromeCode,
      matchedRuleIds: trimmed ? [] : (JSON.parse(decision.matchedRuleIdsJson) as string[]),
      rulePackageVersion: decision.rulePackageVersion,
      planId: trimmed ? null : decision.planId,
      createdAt: decision.createdAt
    };
  }

  /**
   * 患者侧 verdict 裁剪（评审 P0-2）：
   * 规则包未临床冻结（candidate）时，execTurn 返回的 verdict 只保留
   * outcome/stage/nextQuestions 与规则包元数据，severityCode/
   * syndromeCode/matchedRuleIds 置空——避免患者用 agent exec --json
   * 拿到证型/严重度/命中规则后拼出完整调理方案，违反 HELP“Agent 不
   * 输出证型、穴位、疗程或调理方案”承诺。
   *
   * 边界与决策记录：
   * - `agent test run`（模拟链路）与管理员侧不受裁剪：testRun 返回
   *   完整 ClinicalVerdict，供开发/临床验证规则包（结构独立，不经过
   *   本方法）；
   * - `browse plan show` 保持只读可用：它是后台明确发布
   *   （agent_plans.status='enabled'）的内容浏览，不是 agent 判定。
   *   本方法裁剪掉 planId 后，患者第一步就拿不到 planId，无法发起
   *   “exec 拿证型 → conversations show 拿 planId → browse 拼步骤”
   *   三步拼装，侧信道被切断。
   */
  private patientVerdict(
    verdict: ClinicalVerdict
  ): ConversationTurnResult["verdict"] {
    const trimmed = this.kernel.rulePackageStatus !== "approved";
    return {
      outcome: verdict.outcome,
      stage: verdict.stage,
      severityCode: trimmed ? null : verdict.severityCode,
      syndromeCode: trimmed ? null : verdict.syndromeCode,
      nextQuestions: verdict.nextQuestions,
      matchedRuleIds: trimmed ? [] : verdict.matchedRuleIds,
      rulePackageVersion: verdict.rulePackageVersion,
      rulePackageHash: verdict.rulePackageHash,
      rulePackageStatus: this.kernel.rulePackageStatus
    };
  }

  /** 反馈用于产品质量分析，不自动修改临床规则或发布状态。 */
  async addFeedback(input: {
    conversationId: string;
    rating: "helpful" | "unhelpful";
    reason: string | null;
    patientId: string | null;
  }): Promise<{ id: string; rating: string }> {
    if (input.rating !== "helpful" && input.rating !== "unhelpful") {
      throw new DomainError("validation_failed", "反馈评分必须是 helpful 或 unhelpful");
    }
    // 匿名反馈只允许命中匿名会话，不得写已绑定患者的会话（评审 B P2）。
    const session =
      input.patientId === null
        ? await this.repository.findAnonymousSession(input.conversationId)
        : await this.repository.findPatientSession(
            input.patientId,
            input.conversationId
          );
    if (session === null) {
      throw new DomainError("resource_not_found", "对话不存在");
    }
    const decisions = await this.repository.listDecisions(session.id);
    const lastDecision = decisions[decisions.length - 1] ?? null;
    const reasonEncrypted: EncryptedContent | null =
      input.reason === null ? null : this.encryption.encrypt(input.reason);
    const id = randomUUID();
    await this.repository.addFeedback({
      id,
      sessionId: session.id,
      decisionId: lastDecision?.id ?? null,
      rating: input.rating,
      reasonEncrypted,
      createdAt: now()
    });
    return { id, rating: input.rating };
  }

  /**
   * 患者侧模拟链路（agent test run）：输入测试答案 → 规则结果 →
   * 方案（阻断中）→ 知识（未接入）→ AI 解释（固定模板模拟）。
   * 只验证不修改规则，不持久化，不调用模型。
   */
  async testRun(input: ConversationTestRunInput): Promise<ConversationTestRunResult> {
    const verdict = this.kernel.evaluate(input.answers);
    const validated = renderValidatedOutput(
      verdict,
      this.kernel.rulePackageStatus,
      null
    );
    return {
      verdict,
      planBlocked: verdict.outcome === "classified",
      explanation: {
        templateId: validated.templateId,
        content: validated.content,
        contentHash: validated.contentHash,
        simulated: true
      },
      knowledge: { state: "not_available" }
    };
  }

  private createSession(patientId: string | null, timestamp: string): ConversationSession {
    return {
      id: randomUUID(),
      patientId,
      state: "active",
      saveConsentId: null,
      rulePackageVersion: this.kernel.rulePackageVersion,
      rulePackageHash: this.kernel.rulePackageHash,
      revision: 1,
      lastSequence: 0,
      closedAt: null,
      retentionUntil:
        patientId === null
          ? new Date(Date.now() + ANONYMOUS_RETENTION_MS).toISOString()
          : this.boundRetention(timestamp),
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  private boundRetention(timestamp: string): string {
    return new Date(Date.parse(timestamp) + BOUND_RETENTION_MS).toISOString();
  }

  private async findSessionForCaller(
    conversationId: string,
    patientId: string | null
  ): Promise<ConversationSession> {
    if (patientId === null) {
      // 匿名调用者只能访问匿名会话（评审 P1 codex #7）：用
      // findAnonymousSession（patient_id IS NULL 过滤），绑定患者后
      // 原匿名 id 对匿名调用者不可再访问。
      const anonymous = await this.repository.findAnonymousSession(conversationId);
      if (anonymous === null) {
        throw new DomainError("resource_not_found", "对话不存在");
      }
      return anonymous;
    }
    // 已登录患者：先查自己的会话；再允许按 id 认领未绑定的匿名会话
    // （绑定必须再次显式确认，绝不自动绑定；匿名 id 不可枚举）。
    const owned = await this.repository.findPatientSession(patientId, conversationId);
    if (owned !== null) {
      return owned;
    }
    const anonymous = await this.repository.findAnonymousSession(conversationId);
    if (anonymous === null) {
      throw new DomainError("resource_not_found", "对话不存在");
    }
    return anonymous;
  }

  private async updateSession(
    expected: ConversationSession,
    next: ConversationSession
  ): Promise<void> {
    const outcome = await this.repository.updateSession(
      expected.revision,
      next
    );
    if (outcome.kind === "not_found") {
      throw new DomainError("resource_not_found", "对话不存在");
    }
    if (outcome.kind === "version_conflict") {
      throw new DomainError("version_conflict", "对话已更新，请重新读取", {
        details: {
          expectedRevision: expected.revision,
          currentRevision: outcome.currentRevision
        }
      });
    }
  }

  /**
   * 补问全部待答字段都已确认 unknown → 无法取得进展 → fail-closed。
   * 进展判定基于未截断的全集（verdict.allQuestions）：截断只影响本轮
   * 展示数量，患者对已展示的 2 问答 unknown 不代表其余问题无法回答
   * （评审 P1 kimi P1-6）。
   */
  private failClosedIfNoProgress(
    verdict: ReturnType<ClinicalRuleKernelPort["evaluate"]>,
    unknownAnswered: ReadonlySet<string>
  ): { content: string; contentHash: string } | null {
    if (verdict.outcome !== "need_more_information") {
      return null;
    }
    if (verdict.allQuestions.length === 0) {
      return null;
    }
    const allUnknown = verdict.allQuestions.every((question) =>
      unknownAnswered.has(question.fieldCode)
    );
    if (!allUnknown) {
      return null;
    }
    const content =
      verdict.stage === "safety"
        ? FAIL_CLOSED_SAFETY_NOTICE
        : FAIL_CLOSED_INFO_NOTICE;
    return { content, contentHash: sha256(content) };
  }
}
