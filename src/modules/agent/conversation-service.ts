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
import type { ConsentGatePort } from "../account/consent-ports.js";
import { parseStructuredAnswers } from "./answer-parser.js";
import { parseOptionPayload } from "./option-mapping.js";
import { patientVisibleMessage } from "./patient-visible-message.js";
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
  PatientAssessmentRow,
  ProposedCandidateView
} from "./conversation-contracts.js";
import type {
  ExplanationFields,
  ExtractionCandidate,
  ModelExplanationPort,
  ModelExtractionPort,
  PlanDialoguePort,
  PlanDialogueSource
} from "./model-ports.js";
import type { KnowledgeRetrievalPort } from "./knowledge-ports.js";
import {
  EXTRACTION_UNAVAILABLE_NOTICE,
  FAIL_CLOSED_INFO_NOTICE,
  FAIL_CLOSED_SAFETY_NOTICE,
  questionWithinApprovedPlan,
  renderAssessmentGreeting,
  renderEmergencyFollowUp,
  renderFixedFollowUp,
  renderGeneratedFollowUpOutput,
  renderContextualPlanFollowUp,
  renderGeneratedPlanOutput,
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

function planRefs(verdict: ClinicalVerdict): Array<{ id: string; revision: number }> {
  return [verdict.planBundle?.acute, verdict.planBundle?.constitution]
    .filter((plan): plan is NonNullable<typeof plan> => plan !== null && plan !== undefined)
    .map((plan) => ({ id: plan.planId, revision: plan.planRevision }));
}

/** 仅匹配不携带其他问题的纯寒暄，避免误截获“你好，方案是什么意思”。 */
function isSimpleGreeting(message: string): boolean {
  return /^(?:你好|您好|嗨|哈喽|hello|hi)[！!。,.，？?\s]*$/iu.test(message);
}

/** 完成评估后的自由追问也必须保留急救硬门禁，不能依赖模型成功返回。 */
function isEmergencyFollowUp(message: string): boolean {
  return /呼吸困难|喘不上气|胸闷憋气|口唇发紫|意识不清|意识异常|昏迷/u.test(message);
}

export class ConversationService {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly kernel: ClinicalRuleKernelPort,
    private readonly extraction: ModelExtractionPort,
    private readonly explanation: ModelExplanationPort,
    private readonly encryption: EncryptionPort,
    private readonly consentGate: ConsentGatePort,
    private readonly planDialogue: PlanDialoguePort | null = null,
    private readonly knowledgeRetrieval: KnowledgeRetrievalPort | null = null
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
      let inheritedAssessment: PatientAssessmentRow | null = null;
      if (input.patientId !== null && input.startMode !== "reassess") {
        const current = await this.currentOrBackfilledAssessment(input.patientId);
        if (current !== null && (await this.assessmentVerdict(current)) !== null) {
          inheritedAssessment = current;
        }
      }
      session = this.createSession(
        input.patientId,
        timestamp,
        inheritedAssessment?.id ?? null,
        inheritedAssessment === null ? "active" : "completed"
      );
      await this.repository.createSession(session);
    } else {
      session = existing;
      if (
        session.rulePackageVersion !== this.kernel.rulePackageVersion ||
        session.rulePackageHash !== this.kernel.rulePackageHash
      ) {
        const abandoned: ConversationSession = {
          ...session,
          state: "abandoned",
          revision: session.revision + 1,
          closedAt: timestamp,
          updatedAt: timestamp
        };
        await this.updateSession(session, abandoned);
        throw new DomainError(
          "protocol_incompatible",
          "评估规则已经更新，旧对话不能继续判定。请新建对话后重新评估。",
          {
            details: {
              conversationRulePackageVersion: session.rulePackageVersion,
              currentRulePackageVersion: this.kernel.rulePackageVersion
            }
          }
        );
      }
    }

    let saved = false;
    let saveConfirmationRequired = false;
    if (session.patientId === null && input.patientId !== null) {
      // 匿名会话被已登录患者继续：必须再次确认保存，绝不自动绑定。
      if (input.saveConsent === true) {
        // Agent 会话保存授权前置（issue-155）：最新 agent_session_save
        // 决策为 withdrawn 时拒绝绑定（fail-closed）。
        const saveDecision = await this.consentGate.latestDecision(
          input.patientId,
          "agent_session_save"
        );
        if (saveDecision === "withdrawn") {
          throw new DomainError(
            "consent_required",
            "Agent 会话保存授权已撤回：请先执行 account consent update --type agent_session_save --decision granted"
          );
        }
        // 追加真实授权记录，save_consent_id 指向该记录 id
        //（修复前写随机 UUID，从不落 patient_consents）。
        const consent = await this.consentGate.appendGranted({
          patientId: input.patientId,
          consentType: "agent_session_save",
          requestId: `agent-session-save:${session.id}`
        });
        const bound: ConversationSession = {
          ...session,
          patientId: input.patientId,
          saveConsentId: consent.id,
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
      if (session.state === "completed" && message !== "") {
        return this.execCompletedFollowUp({
          session,
          message,
          saved,
          saveConfirmationRequired,
          timestamp
        });
      }
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

    // 决策序号语义（评审 P2 核实）：decision_sequence 是"本会话第 N 条
    // 决策凭证"（每会话从 1 连续递增，UNIQUE(session_id, decision_sequence)），
    // 与 agent_messages.sequence（消息流水号）相互独立——两者曾共用
    // session.lastSequence 计数，导致每轮 user+assistant 两条消息后
    // decision_sequence 出现 1、4、6…空洞（被消息序号吃掉）。现改为
    // 独立计数（lastDecision.decisionSequence + 1）：新会话从 1 连续
    // 递增；对修复前已存在的会话（历史序号可能有空洞）则基于最大值
    // 续号，避免与新序号撞 UNIQUE(session_id, decision_sequence)。
    // commitTurn 受 session revision CAS 保护，并发轮次在提交时被拒绝，
    // 读到的 decisions 与 revision 一致。
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
    //    问卷选项载荷（q1=B，多选题保真）与字段标签解析并列：选项载荷
    //    命中时确定性映射（option-mapping.ts），严禁 message=""（空串解析
    //    返回 [] 死循环，评审二轮 P0-1）。
    const pendingAnswers: ConfirmedAnswerRow[] = [];
    const optionHit = parseOptionPayload(message, lastQuestions);
    if (optionHit !== null && optionHit.field !== null && optionHit.state !== null) {
      pendingAnswers.push({
        sessionId: session.id,
        fieldCode: optionHit.field,
        value: optionHit.state,
        factValue: optionHit.factValue,
        source: "patient_confirmation",
        rulePackageVersion: session.rulePackageVersion,
        rulePackageHash: session.rulePackageHash,
        revision: session.revision,
        confirmedAt: timestamp
      });
      unknownAnswered.delete(optionHit.field);
    }
    const parsedAnswers = parseStructuredAnswers(message, lastQuestions);
    for (const answer of parsedAnswers) {
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
    //    确定性解析命中（选项载荷或字段标签）时跳过 extraction：
    //    避免每轮降级 notice 噪音（评审二轮 #3）。
    let extractionFailed = false;
    let extracted: ExtractionCandidate[] = [];
    const deterministicHit = optionHit !== null || parsedAnswers.length > 0;
    if (!deterministicHit && message !== "") {
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
    const verdict = await this.kernel.evaluate(facts);

    // 3b. 已答 unknown 的字段不再追问（评审并发 P2-2）：逐题一问（MAX=1）
    // 下，unknown 字段的问题每轮重出会形成同题无限循环。展示与
    // fail-closed 判定基于过滤后的补问集；决策凭证仍存原始全集。
    const displayVerdict: ClinicalVerdict =
      verdict.outcome === "need_more_information"
        ? {
            ...verdict,
            nextQuestions: verdict.nextQuestions.filter(
              (question) => !unknownAnswered.has(question.fieldCode)
            ),
            allQuestions: verdict.allQuestions.filter(
              (question) => !unknownAnswered.has(question.fieldCode)
            )
          }
        : verdict;

    // 4. 补问无法取得进展 → fail-closed（unknown 不等于 no）。
    //    过滤后 allQuestions 为空（全部字段已答 unknown）→ every() 对
    //    空集为 true → 立即 fail-closed 收尾，不再循环。
    const escalated = this.failClosedIfNoProgress(displayVerdict, unknownAnswered);

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
    // 补问渲染用过滤后的展示集（已答 unknown 字段不再追问，P2-2）；
    // 非补问裁决两版一致。
    const validated = renderValidatedOutput(
      displayVerdict,
      this.kernel.rulePackageStatus,
      modelFields
    );
    let generatedPlan = null;
    if (
      escalated === null &&
      verdict.outcome === "classified" &&
      verdict.planBundle !== null &&
      this.kernel.rulePackageStatus === "approved" &&
      this.planDialogue !== null
    ) {
      try {
        generatedPlan = renderGeneratedPlanOutput(
          await this.planDialogue.generatePlan(verdict),
          verdict
        );
      } catch {
        generatedPlan = null;
      }
    }
    const finalOutput =
      escalated ?? generatedPlan ?? validated;

    // 6-8. 决策凭证 + 消息 + 会话状态：构造后单事务提交
    //      （评审 B P1-2 原子化：任何一步失败整轮回滚；
    //      并发轮次因 CAS 版本不匹配被拒绝，不产生部分写入）。
    const snapshotJson = canonicalJson(facts);
    const snapshotEncrypted = this.encryption.encrypt(snapshotJson);
    const decisionId = randomUUID();
    const decision: DecisionRow = {
      id: decisionId,
      sessionId: session.id,
      // 独立决策计数：见上方"决策序号语义"注释（不再与消息序列混用；
      // listDecisions 按 decision_sequence ASC 排序，末条即最大值）。
      decisionSequence: (lastDecision?.decisionSequence ?? 0) + 1,
      sessionRevision: session.revision,
      inputSnapshotEncrypted: snapshotEncrypted,
      inputSnapshotHash: sha256(snapshotJson),
      outcome: verdict.outcome,
      stage: verdict.stage,
      severityCode: verdict.severityCode,
      syndromeCode: verdict.syndromeCode,
      phaseCode: verdict.phaseCode,
      audience: verdict.audience,
      rulePackageStatus: this.kernel.rulePackageStatus,
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
      const visibleMessage = patientVisibleMessage(message);
      messages.push({
        id: randomUUID(),
        sessionId: session.id,
        sequence,
        role: "user",
        decisionId: null,
        contentEncrypted: this.encryption.encrypt(visibleMessage),
        contentHash: sha256(visibleMessage),
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
    const completedAssessment =
      verdict.outcome === "classified" &&
      verdict.planBundle !== null &&
      verdict.syndromeCode !== null &&
      verdict.phaseCode !== null &&
      verdict.audience !== null &&
      session.patientId !== null
        ? {
            id: randomUUID(),
            patientId: session.patientId,
            sourceSessionId: session.id,
            decisionId,
            status: "current" as const,
            answersSnapshotEncrypted: this.encryption.encrypt(snapshotJson),
            answersSnapshotHash: sha256(snapshotJson),
            severityCode: verdict.severityCode,
            syndromeCode: verdict.syndromeCode,
            phaseCode: verdict.phaseCode,
            audience: verdict.audience,
            planRefsJson: JSON.stringify(planRefs(verdict)),
            rulePackageVersion: verdict.rulePackageVersion,
            rulePackageHash: verdict.rulePackageHash,
            completedAt: timestamp,
            supersededAt: null
          } satisfies PatientAssessmentRow
        : undefined;
    const next: ConversationSession = {
      ...session,
      assessmentId: completedAssessment?.id ?? session.assessmentId,
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
      next,
      completedAssessment
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

  async currentAssessmentForPatient(patientId: string): Promise<{
    id: string;
    completedAt: string;
    severityCode: string | null;
    syndromeCode: string;
    phaseCode: "acute" | "remission";
    audience: "child" | "adult";
  } | null> {
    const assessment = await this.currentOrBackfilledAssessment(patientId);
    if (assessment === null || (await this.assessmentVerdict(assessment)) === null) {
      return null;
    }
    return {
      id: assessment.id,
      completedAt: assessment.completedAt,
      severityCode: assessment.severityCode,
      syndromeCode: assessment.syndromeCode,
      phaseCode: assessment.phaseCode,
      audience: assessment.audience
    };
  }

  async showForPatient(
    patientId: string,
    conversationId: string
  ): Promise<ConversationShowResult> {
    let session = await this.repository.findPatientSession(
      patientId,
      conversationId
    );
    if (session === null) {
      throw new DomainError("resource_not_found", "对话不存在");
    }
    if (
      session.state === "active" &&
      (
        session.rulePackageVersion !== this.kernel.rulePackageVersion ||
        session.rulePackageHash !== this.kernel.rulePackageHash
      )
    ) {
      const timestamp = now();
      const abandoned: ConversationSession = {
        ...session,
        state: "abandoned",
        revision: session.revision + 1,
        closedAt: timestamp,
        updatedAt: timestamp
      };
      await this.updateSession(session, abandoned);
      session = abandoned;
    }
    const decisions = await this.repository.listDecisions(session.id);
    const encryptedMessages = await this.repository.listMessages(session.id);
    const last = decisions[decisions.length - 1] ?? null;
    const messages = encryptedMessages.map((message) => {
      let content: string;
      try {
        content = this.encryption.decrypt(message.contentEncrypted);
      } catch (cause) {
        throw new DomainError("storage_unavailable", "对话记录暂时无法读取", {
          cause
        });
      }
      if (sha256(content) !== message.contentHash) {
        throw new DomainError("storage_unavailable", "对话记录完整性校验失败");
      }
      return {
        id: message.id,
        sequence: message.sequence,
        role: message.role,
        decisionId: message.decisionId,
        content,
        contentHash: message.contentHash,
        createdAt: message.createdAt
      };
    });
    return {
      session,
      messages,
      decisionCount: decisions.length,
      lastDecision: last === null ? null : this.summarizeDecision(last)
    };
  }

  /** 已完成且成功分类的评估可在同一会话内继续追问当前方案。 */
  private async execCompletedFollowUp(input: {
    session: ConversationSession;
    message: string;
    saved: boolean;
    saveConfirmationRequired: boolean;
    timestamp: string;
  }): Promise<ConversationTurnResult> {
    const { session, message, timestamp } = input;
    const inherited =
      session.patientId !== null && session.assessmentId !== null
        ? await this.repository.findAssessment(session.patientId, session.assessmentId)
        : null;
    const inheritedVerdict = inherited === null
      ? null
      : await this.assessmentVerdict(inherited, true);
    const answers = inherited === null
      ? await this.repository.listConfirmedAnswers(session.id)
      : [];
    const facts = inherited === null
      ? answersToFacts(answers)
      : this.assessmentFacts(inherited);
    const verdict = inheritedVerdict ?? await this.kernel.evaluate(facts);
    if (
      verdict.outcome !== "classified" ||
      verdict.planBundle === null ||
      this.kernel.rulePackageStatus !== "approved"
    ) {
      throw new DomainError(
        "validation_failed",
        "只有已完成并取得有效方案的评估才能继续追问"
      );
    }

    const planQuestion = questionWithinApprovedPlan(message, verdict);
    const recentMessages = (await this.readVerifiedMessages(session.id))
      .filter((entry) => entry.role === "user" || entry.role === "assistant")
      .slice(-6)
      .map((entry) => ({
        role: entry.role as "user" | "assistant",
        content: entry.role === "assistant"
          ? entry.content.replace(/\n\n【依据】[\s\S]*$/u, "")
          : entry.content
      }));
    const dialogueContext = {
      assessment: {
        completedAt: inherited?.completedAt ?? session.closedAt ?? timestamp,
        answers: facts
      },
      recentMessages
    };

    let finalOutput: ReturnType<typeof renderFixedFollowUp>;
    if (isEmergencyFollowUp(message)) {
      finalOutput = renderEmergencyFollowUp();
    } else if (isSimpleGreeting(message)) {
      finalOutput = renderAssessmentGreeting();
    } else if (!planQuestion) {
      finalOutput = renderFixedFollowUp(
        "follow_up_out_of_plan",
        "您问到的穴位或疗法不在当前方案中，本工具不能新增操作建议。请咨询专业医生。",
        verdict
      );
    } else {
      let decision: Awaited<ReturnType<PlanDialoguePort["decideFollowUp"]>> = null;
      if (this.planDialogue !== null) {
        try {
          decision = await this.planDialogue.decideFollowUp({
            question: message,
            verdict,
            context: dialogueContext
          });
        } catch {
          decision = null;
        }
      }
      if (decision?.action === "search") {
        let sources: PlanDialogueSource[] = [];
        let searchAvailable = this.knowledgeRetrieval !== null;
        if (this.knowledgeRetrieval !== null) {
          try {
            sources = (await this.knowledgeRetrieval.searchEnabled(decision.query, 3)).map(
              (source) => ({
                knowledgeId: source.knowledgeId,
                name: source.name,
                source: source.source,
                text: source.text
              })
            );
          } catch {
            searchAvailable = false;
          }
        }
        let generated: string | null = null;
        if (searchAvailable && this.planDialogue !== null) {
          try {
            generated = await this.planDialogue.answerFollowUp({
              question: message,
              verdict,
              sources,
              context: dialogueContext
            });
          } catch {
            generated = null;
          }
        }
        finalOutput =
          renderGeneratedFollowUpOutput(generated, verdict, sources) ??
          renderFixedFollowUp(
            sources.length > 0 ? "follow_up_degraded" : "follow_up_no_evidence",
            searchAvailable
              ? "我查了当前启用的资料，但还没有找到足够贴合这个问题的依据。你可以补充最想了解的是原因、日常注意事项，还是当前方案里的具体内容？"
              : "当前知识搜索暂时不可用。你可以先说明最想了解的是当前方案、症状变化，还是一般鼻健康知识，我会在现有依据范围内继续帮你。",
            verdict
          );
      } else {
        const generated = decision?.action === "answer" ? decision.answer : null;
        finalOutput =
          renderGeneratedFollowUpOutput(generated, verdict, []) ??
          renderContextualPlanFollowUp(verdict, recentMessages.length > 0);
      }
    }

    const decisions = await this.repository.listDecisions(session.id);
    const lastDecision = decisions[decisions.length - 1] ?? null;
    const snapshotJson = canonicalJson(facts);
    const decisionId = randomUUID();
    const decision: DecisionRow = {
      id: decisionId,
      sessionId: session.id,
      decisionSequence: (lastDecision?.decisionSequence ?? 0) + 1,
      sessionRevision: session.revision,
      inputSnapshotEncrypted: this.encryption.encrypt(snapshotJson),
      inputSnapshotHash: sha256(snapshotJson),
      outcome: verdict.outcome,
      stage: verdict.stage,
      severityCode: verdict.severityCode,
      syndromeCode: verdict.syndromeCode,
      phaseCode: verdict.phaseCode,
      audience: verdict.audience,
      rulePackageStatus: this.kernel.rulePackageStatus,
      nextQuestionsJson: "[]",
      matchedRuleIdsJson: JSON.stringify(verdict.matchedRuleIds),
      rulePackageVersion: session.rulePackageVersion,
      rulePackageHash: session.rulePackageHash,
      planId: verdict.planId,
      planRevision: verdict.planRevision,
      createdAt: timestamp
    };

    const visibleMessage = patientVisibleMessage(message);
    const userSequence = session.lastSequence + 1;
    const messages: ConversationMessage[] = [
      {
        id: randomUUID(),
        sessionId: session.id,
        sequence: userSequence,
        role: "user",
        decisionId: null,
        contentEncrypted: this.encryption.encrypt(visibleMessage),
        contentHash: sha256(visibleMessage),
        createdAt: timestamp
      },
      {
        id: randomUUID(),
        sessionId: session.id,
        sequence: userSequence + 1,
        role: "assistant",
        decisionId,
        contentEncrypted: this.encryption.encrypt(finalOutput.content),
        contentHash: finalOutput.contentHash,
        createdAt: timestamp
      }
    ];
    const next: ConversationSession = {
      ...session,
      revision: session.revision + 1,
      lastSequence: userSequence + 2,
      updatedAt: timestamp
    };
    const outcome = await this.repository.commitTurn({
      sessionId: session.id,
      expectedRevision: session.revision,
      answers: [],
      candidates: [],
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
      state: "completed",
      message: {
        role: "assistant",
        content: finalOutput.content,
        contentHash: finalOutput.contentHash,
        decisionId
      },
      notices: [],
      verdict: this.patientVerdict(verdict),
      proposedCandidates: [],
      saveConfirmationRequired: input.saveConfirmationRequired,
      saved: input.saved,
      closed: true
    };
  }

  private summarizeDecision(decision: DecisionRow): DecisionSummary {
    // 按决策行自身包状态裁剪（codex P1-2）：历史 candidate 决策在包
    // 冻结后不得解封（证型/严重度/命中规则/planId 侧信道），
    // 与 0011 迁移新增的 rule_package_status 列配合。
    const trimmed = (decision.rulePackageStatus ?? "candidate") !== "approved";
    return {
      id: decision.id,
      decisionSequence: decision.decisionSequence,
      outcome: decision.outcome,
      // 评审 R2：candidate 下 stage 一并裁剪（置 null）——stage 进程
      // （safety→applicability→severity→syndrome→completed）可让患者
      // 确认"已通过严重度/证型阶段"，构成决策表进展侧信道。
      stage: trimmed ? null : decision.stage,
      // 未临床冻结（candidate）时对患者裁剪临床字段：绝不通过
      // 结构化字段侧信道拼装完整方案（评审 P0-2，见 patientVerdict）。
      severityCode: trimmed ? null : decision.severityCode,
      syndromeCode: trimmed ? null : decision.syndromeCode,
      phaseCode: trimmed ? null : decision.phaseCode,
      audience: trimmed ? null : decision.audience,
      matchedRuleIds: trimmed ? [] : (JSON.parse(decision.matchedRuleIdsJson) as string[]),
      rulePackageVersion: decision.rulePackageVersion,
      planId: trimmed ? null : decision.planId,
      nextQuestions: JSON.parse(decision.nextQuestionsJson) as NextQuestion[],
      createdAt: decision.createdAt
    };
  }

  /**
   * 患者侧 verdict 裁剪（评审 P0-2 + R2）：
   * 规则包未临床冻结（candidate）时，execTurn 返回的 verdict 只保留
   * outcome/nextQuestions 与规则包元数据，stage/severityCode/
   * syndromeCode/matchedRuleIds 置空——避免患者用 agent exec --json
   * 拿到证型/严重度/命中规则/阶段进展后拼出完整调理方案，违反 HELP
   * “Agent 不输出证型、穴位、疗程或调理方案”承诺。
   *
   * 边界与决策记录：
   * - 患者侧 `agent test run` 已关闭（capability_unavailable）：模拟
   *   链路属于管理端（kangmin-admin agent test run），患者一步拿完整
   *   ClinicalVerdict 可枚举决策表（评审 R2 P0，见 testRun）；
   * - `browse plan list/show` 受双门禁：管理端启用（status='enabled'）
   *   之外还需临床规则包冻结（approved）才对患者开放（评审 R2 P1，
   *   见 SqliteContentReadRepository.planBrowseEnabled）。本方法裁剪掉
   *   planId 后，患者第一步就拿不到 planId，无法发起
   *   “exec 拿证型 → conversations show 拿 planId → browse 拼步骤”
   *   三步拼装，侧信道被切断。
   */
  private patientVerdict(
    verdict: ClinicalVerdict
  ): ConversationTurnResult["verdict"] {
    const trimmed = this.kernel.rulePackageStatus !== "approved";
    return {
      outcome: verdict.outcome,
      // 评审 R2：candidate 下 stage 归一为 null（进展侧信道，见 summarizeDecision）。
      stage: trimmed ? null : verdict.stage,
      severityCode: trimmed ? null : verdict.severityCode,
      syndromeCode: trimmed ? null : verdict.syndromeCode,
      phaseCode: trimmed ? null : verdict.phaseCode,
      audience: trimmed ? null : verdict.audience,
      nextQuestions: verdict.nextQuestions,
      matchedRuleIds: trimmed ? [] : verdict.matchedRuleIds,
      rulePackageVersion: verdict.rulePackageVersion,
      rulePackageHash: verdict.rulePackageHash,
      rulePackageStatus: this.kernel.rulePackageStatus,
      // planBundle 永不进患者侧（评审 P0-8）：前端只从消息内容渲染，
      // 防 agent exec --json 拿完整方案拼装（三步拼装侧信道）。
      planBundle: null
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
   * 患者侧 `agent test run`（评审 R2 P0 关闭）：
   * 模拟测试链路属于管理端（kangmin-admin agent test run，管理侧已按
   * capability_unavailable 桩占位，见 agent-admin-service），患者 CLI
   * 设计 §6 不存在 test run 命令——患者侧 `kangmin agent test run` 是
   * w4 擅自添加。修复：患者侧一律返回 capability_unavailable，绝不向
   * 匿名/患者调用者返回完整 ClinicalVerdict（severityCode/
   * syndromeCode/matchedRuleIds/planId/planRevision/allQuestions 可
   * 一步枚举完整决策表，配合 browse plan show 拼出方案，P0-2 侧信道
   * 修复失效）。
   *
   * 方法签名保留以支撑 dispatcher 类型边界（app/application.ts 的
   * `agent test run` 分支仍调用本方法；命令解析/HELP 的移除属跨文件
   * 协同改动，见评审记录）。输入校验（answerFacts）仍在 dispatcher
   * 层先行，非法输入先于本方法返回 validation_failed。
   */
  async testRun(input: ConversationTestRunInput): Promise<ConversationTestRunResult> {
    throw new DomainError(
      "capability_unavailable",
      "模拟链路属于管理端：请使用 kangmin-admin agent test run"
    );
  }

  private createSession(
    patientId: string | null,
    timestamp: string,
    assessmentId: string | null = null,
    state: ConversationSession["state"] = "active"
  ): ConversationSession {
    return {
      id: randomUUID(),
      patientId,
      state,
      saveConsentId: null,
      assessmentId,
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

  private assessmentFacts(assessment: PatientAssessmentRow): ConfirmedFact[] {
    let snapshot: string;
    try {
      snapshot = this.encryption.decrypt(assessment.answersSnapshotEncrypted);
    } catch (cause) {
      throw new DomainError("storage_unavailable", "评估记录暂时无法读取", { cause });
    }
    if (sha256(snapshot) !== assessment.answersSnapshotHash) {
      throw new DomainError("storage_unavailable", "评估记录完整性校验失败");
    }
    return JSON.parse(snapshot) as ConfirmedFact[];
  }

  private async readVerifiedMessages(sessionId: string): Promise<Array<{
    role: ConversationMessage["role"];
    content: string;
  }>> {
    const messages = await this.repository.listMessages(sessionId);
    return messages.map((message) => {
      let content: string;
      try {
        content = this.encryption.decrypt(message.contentEncrypted);
      } catch (cause) {
        throw new DomainError("storage_unavailable", "对话记录暂时无法读取", { cause });
      }
      if (sha256(content) !== message.contentHash) {
        throw new DomainError("storage_unavailable", "对话记录完整性校验失败");
      }
      return { role: message.role, content };
    });
  }

  private async assessmentVerdict(
    assessment: PatientAssessmentRow,
    allowSuperseded = false
  ): Promise<ClinicalVerdict | null> {
    if (
      (!allowSuperseded && assessment.status !== "current") ||
      assessment.rulePackageVersion !== this.kernel.rulePackageVersion ||
      assessment.rulePackageHash !== this.kernel.rulePackageHash
    ) {
      return null;
    }
    const verdict = await this.kernel.evaluate(this.assessmentFacts(assessment));
    if (
      verdict.outcome !== "classified" || verdict.planBundle === null ||
      verdict.syndromeCode !== assessment.syndromeCode ||
      verdict.phaseCode !== assessment.phaseCode || verdict.audience !== assessment.audience ||
      JSON.stringify(planRefs(verdict)) !== assessment.planRefsJson
    ) {
      return null;
    }
    return verdict;
  }

  private async currentOrBackfilledAssessment(
    patientId: string
  ): Promise<PatientAssessmentRow | null> {
    const current = await this.repository.findCurrentAssessment(patientId);
    if (current !== null) return current;

    const sessions = await this.repository.listPatientSessions(patientId);
    for (const session of sessions) {
      if (
        session.state !== "completed" ||
        session.rulePackageVersion !== this.kernel.rulePackageVersion ||
        session.rulePackageHash !== this.kernel.rulePackageHash
      ) continue;
      const answers = await this.repository.listConfirmedAnswers(session.id);
      if (!Array.from({ length: 14 }, (_, index) => `q${index + 1}`)
        .every((fieldCode) => answers.some((answer) => answer.fieldCode === fieldCode))) {
        continue;
      }
      const facts = answersToFacts(answers);
      const verdict = await this.kernel.evaluate(facts);
      const decisions = await this.repository.listDecisions(session.id);
      const decision = [...decisions].reverse().find((entry) =>
        entry.outcome === "classified" && entry.rulePackageStatus === "approved"
      );
      if (
        decision === undefined || verdict.outcome !== "classified" ||
        verdict.planBundle === null || verdict.syndromeCode === null ||
        verdict.phaseCode === null || verdict.audience === null ||
        decision.rulePackageVersion !== verdict.rulePackageVersion ||
        decision.rulePackageHash !== verdict.rulePackageHash ||
        decision.syndromeCode !== verdict.syndromeCode ||
        decision.phaseCode !== verdict.phaseCode ||
        decision.audience !== verdict.audience ||
        decision.planId !== verdict.planId ||
        decision.planRevision !== verdict.planRevision
      ) continue;
      const snapshot = canonicalJson(facts);
      const assessment: PatientAssessmentRow = {
        id: `assessment-${session.id}`,
        patientId,
        sourceSessionId: session.id,
        decisionId: decision.id,
        status: "current",
        answersSnapshotEncrypted: this.encryption.encrypt(snapshot),
        answersSnapshotHash: sha256(snapshot),
        severityCode: verdict.severityCode,
        syndromeCode: verdict.syndromeCode,
        phaseCode: verdict.phaseCode,
        audience: verdict.audience,
        planRefsJson: JSON.stringify(planRefs(verdict)),
        rulePackageVersion: verdict.rulePackageVersion,
        rulePackageHash: verdict.rulePackageHash,
        completedAt: session.closedAt ?? session.updatedAt,
        supersededAt: null
      };
      await this.repository.saveAssessment(assessment);
      return assessment;
    }
    return null;
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
    verdict: Awaited<ReturnType<ClinicalRuleKernelPort["evaluate"]>>,
    unknownAnswered: ReadonlySet<string>
  ): { content: string; contentHash: string } | null {
    if (verdict.outcome !== "need_more_information") {
      return null;
    }
    if (verdict.allQuestions.length === 0) {
      // 补问集为空：内核 need_more 必带问题，空集只可能由
      // unknownAnswered 过滤造成（评审并发 P2-2）——全部待答字段
      // 已确认 unknown，无法取得进展 → fail-closed 收尾，避免
      // "无问题可问但会话不结束"的卡死态。
      const content =
        verdict.stage === "safety"
          ? FAIL_CLOSED_SAFETY_NOTICE
          : FAIL_CLOSED_INFO_NOTICE;
      return { content, contentHash: sha256(content) };
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
