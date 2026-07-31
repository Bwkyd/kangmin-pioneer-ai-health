import { DomainError } from "../kernel/errors.js";
import {
  failure,
  success,
  type CommandResult
} from "../kernel/result.js";
import {
  integerInRange,
  localDate,
  localDateNotAfterToday,
  monthString,
  optionalIntegerInRange,
  optionalLocalDateNotAfterToday,
  optionalString,
  optionalStringArray,
  positiveInteger,
  requiredString,
  requiredStringArray
} from "../kernel/validation.js";
import { SessionService } from "../modules/account/session-service.js";
import type { SessionRepository } from "../modules/account/session-repository.js";
import type { ContentReadRepository } from "../modules/browse/content-read-repository.js";
import { BrowseService } from "../modules/browse/browse-service.js";
import type { AgentRepository } from "../modules/agent/agent-repository.js";
import { AgentService } from "../modules/agent/agent-service.js";
import type { AgentQuestion, TriStateAnswer } from "../modules/agent/contracts.js";
import { ConversationService } from "../modules/agent/conversation-service.js";
import type { ConversationTurnResult, ConversationTestRunResult } from "../modules/agent/conversation-contracts.js";
import type { ConfirmedFact } from "../modules/clinical-rules/contracts.js";
import { sexOf } from "../modules/record/domain.js";
import type { RecordRepository } from "../modules/record/record-repository.js";
import { RecordService } from "../modules/record/record-service.js";
import { RecordSnapshotAdapter } from "./record-snapshot-adapter.js";

export interface CommandRequest {
  command: string;
  input?: Record<string, unknown> | undefined;
  sessionToken?: string | undefined;
  requestId?: string | undefined;
}

function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 高影响写操作必须显式确认，非交互环境不等待输入。 */
function requireConfirmation(input: Record<string, unknown>): void {
  if (input.yes !== true) {
    throw new DomainError(
      "confirmation_required",
      "删除是高影响操作，需要显式确认"
    );
  }
}

export class KangminApplication {
  readonly sessions: SessionService;
  private readonly records: RecordService;
  private readonly browse: BrowseService;
  private readonly agent: AgentService;
  private readonly conversations: ConversationService;

  constructor(
    sessionRepository: SessionRepository,
    recordRepository: RecordRepository,
    contentReadRepository: ContentReadRepository,
    agentRepository: AgentRepository,
    conversations: ConversationService,
    private readonly closeResources: () => void = () => {}
  ) {
    this.sessions = new SessionService(sessionRepository);
    this.records = new RecordService(recordRepository);
    this.browse = new BrowseService(contentReadRepository);
    this.agent = new AgentService(
      agentRepository,
      new RecordSnapshotAdapter(this.records)
    );
    this.conversations = conversations;
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    const command = request.command.trim();
    const input = request.input ?? {};

    try {
      this.rejectClientIdentity(input);

      if (command === "account") {
        throw new DomainError(
          "capability_unavailable",
          `${command} 尚未进入本次 MVP`
        );
      }

      switch (command) {
        case "browse":
          return success(
            command,
            await this.browse.home(),
            request.requestId
          );
        case "browse article list":
          return success(
            command,
            { items: await this.browse.list("article") },
            request.requestId
          );
        case "browse article categories":
          return success(
            command,
            { items: await this.browse.categories("article") },
            request.requestId
          );
        case "browse article search":
          return success(
            command,
            {
              items: await this.browse.search(
                "article",
                requiredString(input, "query")
              )
            },
            request.requestId
          );
        case "browse article show":
          return success(
            command,
            await this.browse.get("article", requiredString(input, "id")),
            request.requestId
          );
        case "browse video list":
          return success(
            command,
            { items: await this.browse.list("video") },
            request.requestId
          );
        case "browse video categories":
          return success(
            command,
            { items: await this.browse.categories("video") },
            request.requestId
          );
        case "browse video search":
          return success(
            command,
            {
              items: await this.browse.search(
                "video",
                requiredString(input, "query")
              )
            },
            request.requestId
          );
        case "browse video show":
          return success(
            command,
            await this.browse.get("video", requiredString(input, "id")),
            request.requestId
          );
        default:
          if (command.startsWith("browse ")) {
            throw new DomainError("command_invalid", `未知命令：${command}`);
          }
      }

      // 匿名允许的 agent 命令：一次性体验/非交互 exec/反馈/模拟链路。
      // 已登录患者通过 token 解析身份；无 token 时按匿名处理（不保存）。
      if (this.isAnonymousAgentCommand(command, input)) {
        const patientId = await this.resolvePatientOrNull(request.sessionToken);
        if (command === "agent exec") {
          return success(
            command,
            await this.conversations.execTurn({
              patientId,
              message: typeof input.message === "string" ? input.message.trim() : "",
              conversationId: this.optionalString(input, "conversationId"),
              saveConsent: input.saveConsent === true
            }),
            request.requestId
          );
        }
        if (command === "agent start") {
          return success(
            command,
            await this.conversations.execTurn({
              patientId,
              message:
                typeof input.message === "string" ? input.message.trim() : "",
              saveConsent: input.saveConsent === true
            }),
            request.requestId
          );
        }
        if (command === "agent test run") {
          return success(
            command,
            await this.conversations.testRun({
              answers: this.answerFacts(input.answers)
            }),
            request.requestId
          );
        }
        if (command === "agent feedback") {
          return success(
            command,
            await this.conversations.addFeedback({
              conversationId: requiredString(input, "conversationId"),
              rating: this.feedbackRating(input.rating),
              reason: this.optionalString(input, "reason") ?? null,
              patientId
            }),
            request.requestId
          );
        }
        throw new DomainError("command_invalid", `未知命令：${command}`);
      }

      const patientId = await this.sessions.resolvePatient(request.sessionToken);

      switch (command) {
        case "agent":
        case "agent start":
          return success(
            command,
            await this.agent.start(patientId),
            request.requestId
          );
        case "agent continue":
          return success(
            command,
            await this.agent.continue(patientId, {
              id: requiredString(input, "id"),
              expectedRevision: positiveInteger(input, "expectedRevision"),
              question: this.agentQuestion(input.question),
              answer: this.triStateAnswer(input.answer)
            }),
            request.requestId
          );
        case "agent resume":
        case "agent sessions show":
          return success(
            command,
            await this.agent.get(patientId, requiredString(input, "id")),
            request.requestId
          );
        case "agent sessions list":
          return success(
            command,
            { items: await this.agent.list(patientId) },
            request.requestId
          );
        case "agent conversations list":
          return success(
            command,
            { items: await this.conversations.listForPatient(patientId) },
            request.requestId
          );
        case "agent conversations show":
          return success(
            command,
            await this.conversations.showForPatient(
              patientId,
              requiredString(input, "id")
            ),
            request.requestId
          );

        case "record symptom add":
          return success(
            command,
            await this.records.createSymptom(patientId, {
              localDate: localDateNotAfterToday(
                input,
                "localDate",
                localToday()
              ),
              nasalCongestion: integerInRange(input, "nasalCongestion", 0, 3),
              nasalItching: integerInRange(input, "nasalItching", 0, 3),
              sneezing: integerInRange(input, "sneezing", 0, 3),
              runnyNose: integerInRange(input, "runnyNose", 0, 3),
              notes: optionalString(input, "notes") ?? null,
              idempotencyKey: requiredString(input, "idempotencyKey")
            }),
            request.requestId
          );
        case "record symptom list":
          return success(
            command,
            { items: await this.records.listSymptoms(patientId) },
            request.requestId
          );
        case "record symptom show":
          return success(
            command,
            await this.records.getSymptom(
              patientId,
              requiredString(input, "id")
            ),
            request.requestId
          );
        case "record symptom update": {
          const update = {
            id: requiredString(input, "id"),
            expectedRevision: positiveInteger(input, "expectedRevision"),
            nasalCongestion: optionalIntegerInRange(
              input,
              "nasalCongestion",
              0,
              3
            ),
            nasalItching: optionalIntegerInRange(input, "nasalItching", 0, 3),
            sneezing: optionalIntegerInRange(input, "sneezing", 0, 3),
            runnyNose: optionalIntegerInRange(input, "runnyNose", 0, 3),
            notes: optionalString(input, "notes")
          };

          return success(
            command,
            await this.records.updateSymptom(patientId, update),
            request.requestId
          );
        }
        case "record symptom delete":
          requireConfirmation(input);
          await this.records.deleteSymptom(patientId, {
            id: requiredString(input, "id"),
            expectedRevision: positiveInteger(input, "expectedRevision")
          });
          return success(
            command,
            { id: input.id, deleted: true },
            request.requestId
          );

        case "record profile show":
          return success(
            command,
            await this.records.getProfile(patientId),
            request.requestId
          );
        case "record profile update": {
          const update = {
            expectedRevision: integerInRange(
              input,
              "expectedRevision",
              0,
              Number.MAX_SAFE_INTEGER
            ),
            displayName: optionalString(input, "displayName"),
            birthDate: optionalLocalDateNotAfterToday(
              input,
              "birthDate",
              localToday()
            ),
            sex: input.sex === undefined ? undefined : sexOf(input.sex),
            allergyHistory: optionalString(input, "allergyHistory"),
            knownAllergies: optionalString(input, "knownAllergies"),
            commonTriggers: optionalString(input, "commonTriggers"),
            notes: optionalString(input, "notes")
          };

          return success(
            command,
            await this.records.updateProfile(patientId, update),
            request.requestId
          );
        }

        case "record exposure add":
          return success(
            command,
            await this.records.createExposure(patientId, {
              localDate: localDateNotAfterToday(
                input,
                "localDate",
                localToday()
              ),
              factors: requiredStringArray(input, "factors"),
              otherDescription:
                optionalString(input, "otherDescription") ?? null,
              notes: optionalString(input, "notes") ?? null,
              idempotencyKey: requiredString(input, "idempotencyKey")
            }),
            request.requestId
          );
        case "record exposure list":
          return success(
            command,
            { items: await this.records.listExposures(patientId) },
            request.requestId
          );
        case "record exposure show":
          return success(
            command,
            await this.records.getExposure(
              patientId,
              requiredString(input, "id")
            ),
            request.requestId
          );
        case "record exposure update": {
          const update = {
            id: requiredString(input, "id"),
            expectedRevision: positiveInteger(input, "expectedRevision"),
            factors: optionalStringArray(input, "factors"),
            otherDescription: optionalString(input, "otherDescription"),
            notes: optionalString(input, "notes")
          };
          return success(
            command,
            await this.records.updateExposure(patientId, update),
            request.requestId
          );
        }
        case "record exposure delete":
          requireConfirmation(input);
          await this.records.deleteExposure(patientId, {
            id: requiredString(input, "id"),
            expectedRevision: positiveInteger(input, "expectedRevision")
          });
          return success(
            command,
            { id: input.id, deleted: true },
            request.requestId
          );

        case "record medication add":
          return success(
            command,
            await this.records.createMedication(patientId, {
              localDate: localDateNotAfterToday(
                input,
                "localDate",
                localToday()
              ),
              medicationName: requiredString(input, "medicationName"),
              dosage: optionalString(input, "dosage") ?? null,
              actualUse: optionalString(input, "actualUse") ?? null,
              notes: optionalString(input, "notes") ?? null,
              idempotencyKey: requiredString(input, "idempotencyKey")
            }),
            request.requestId
          );
        case "record medication list":
          return success(
            command,
            { items: await this.records.listMedications(patientId) },
            request.requestId
          );
        case "record medication show":
          return success(
            command,
            await this.records.getMedication(
              patientId,
              requiredString(input, "id")
            ),
            request.requestId
          );
        case "record medication update": {
          const update = {
            id: requiredString(input, "id"),
            expectedRevision: positiveInteger(input, "expectedRevision"),
            medicationName:
              input.medicationName === undefined ||
              input.medicationName === null
                ? undefined
                : requiredString(input, "medicationName"),
            dosage: optionalString(input, "dosage"),
            actualUse: optionalString(input, "actualUse"),
            notes: optionalString(input, "notes")
          };
          return success(
            command,
            await this.records.updateMedication(patientId, update),
            request.requestId
          );
        }
        case "record medication delete":
          requireConfirmation(input);
          await this.records.deleteMedication(patientId, {
            id: requiredString(input, "id"),
            expectedRevision: positiveInteger(input, "expectedRevision")
          });
          return success(
            command,
            { id: input.id, deleted: true },
            request.requestId
          );

        case "record overview":
          return success(
            command,
            await this.records.getOverview(patientId, localToday()),
            request.requestId
          );
        case "record calendar":
          return success(
            command,
            await this.records.getCalendar(
              patientId,
              monthString(input, "month")
            ),
            request.requestId
          );
        case "record trend": {
          const from = localDate(input, "from");
          const to = localDate(input, "to");
          if (from > to) {
            throw new DomainError(
              "validation_failed",
              "趋势查询的起始日期不能晚于结束日期"
            );
          }
          return success(
            command,
            await this.records.getTrend(patientId, from, to),
            request.requestId
          );
        }

        default:
          throw new DomainError(
            "command_invalid",
            `未知命令：${command || "(empty)"}`
          );
      }
    } catch (error) {
      return failure(command, error, request.requestId);
    }
  }

  close(): void {
    this.closeResources();
  }

  private rejectClientIdentity(input: Record<string, unknown>): void {
    for (const key of ["patientId", "patient_id", "userId", "user_id"]) {
      if (Object.hasOwn(input, key)) {
        throw new DomainError(
          "permission_denied",
          "患者身份必须由服务端会话解析，不能由客户端提交",
          { details: { field: key } }
        );
      }
    }
  }

  private triStateAnswer(value: unknown): TriStateAnswer {
    if (value !== "yes" && value !== "no" && value !== "unknown") {
      throw new DomainError(
        "validation_failed",
        "answer 必须是 yes、no 或 unknown",
        { details: { field: "answer" } }
      );
    }
    return value;
  }

  private agentQuestion(value: unknown): AgentQuestion["key"] {
    if (value !== "urgentHelp") {
      throw new DomainError(
        "validation_failed",
        "question 必须是服务端发布的问题键",
        { details: { field: "question" } }
      );
    }
    return value;
  }

  /**
   * 匿名允许的 agent 命令：exec/带 message 的 start/test run/feedback。
   * agent start 不带 message 时仍走 #131 结构化安全外壳（需要登录）。
   */
  private isAnonymousAgentCommand(
    command: string,
    input: Record<string, unknown>
  ): boolean {
    if (command === "agent exec" || command === "agent test run" || command === "agent feedback") {
      return true;
    }
    if (command === "agent start") {
      return typeof input.message === "string";
    }
    if (
      command.startsWith("agent ") &&
      !command.startsWith("agent conversations ") &&
      command !== "agent continue" &&
      command !== "agent resume" &&
      command !== "agent sessions list" &&
      command !== "agent sessions show"
    ) {
      throw new DomainError("command_invalid", `未知命令：${command}`);
    }
    return false;
  }

  /** 无 token 视为匿名（允许一次性体验）；有 token 则必须有效。 */
  private async resolvePatientOrNull(
    token: string | undefined
  ): Promise<string | null> {
    if (token === undefined || token.trim() === "") {
      return null;
    }
    return this.sessions.resolvePatient(token);
  }

  private optionalString(
    input: Record<string, unknown>,
    key: string
  ): string | undefined {
    const value = input[key];
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new DomainError(
        "validation_failed",
        `${key} 必须是字符串`,
        { details: { field: key } }
      );
    }
    return value.trim() === "" ? undefined : value.trim();
  }

  private feedbackRating(value: unknown): "helpful" | "unhelpful" {
    if (value !== "helpful" && value !== "unhelpful") {
      throw new DomainError(
        "validation_failed",
        "rating 必须是 helpful 或 unhelpful",
        { details: { field: "rating" } }
      );
    }
    return value;
  }

  /** agent test run 的答案输入：只接受固定 field_code 与三态/值。 */
  private answerFacts(value: unknown): ConfirmedFact[] {
    if (!Array.isArray(value)) {
      throw new DomainError(
        "validation_failed",
        "answers 必须是数组",
        { details: { field: "answers" } }
      );
    }
    const facts: ConfirmedFact[] = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) {
        throw new DomainError("validation_failed", "answers 元素必须是对象");
      }
      const item = entry as Record<string, unknown>;
      const fieldCode = item.fieldCode;
      const state = item.state;
      if (typeof fieldCode !== "string" || fieldCode === "") {
        throw new DomainError("validation_failed", "answers 缺少 fieldCode");
      }
      if (
        state !== "missing" &&
        state !== "unknown" &&
        state !== "yes" &&
        state !== "no" &&
        state !== "value"
      ) {
        throw new DomainError(
          "validation_failed",
          `fieldCode ${fieldCode} 的 state 非法：${String(state)}`
        );
      }
      const fact: ConfirmedFact = {
        fieldCode,
        state,
        source: "patient_confirmation"
      };
      if (state === "value") {
        const factValue = item.value;
        if (typeof factValue !== "string" && typeof factValue !== "number") {
          throw new DomainError(
            "validation_failed",
            `fieldCode ${fieldCode} 的 value 必须是字符串或数字`
          );
        }
        fact.value = factValue;
      }
      facts.push(fact);
    }
    return facts;
  }
}
