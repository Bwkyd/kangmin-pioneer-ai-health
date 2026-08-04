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
import { AccountService } from "../modules/account/account-service.js";
import type { ConsentGatePort } from "../modules/account/consent-ports.js";
import { SessionService } from "../modules/account/session-service.js";
import type { ContentReadRepository } from "../modules/browse/content-read-repository.js";
import { BrowseService } from "../modules/browse/browse-service.js";
import type { PublishedMedia } from "../modules/browse/contracts.js";
import {
  listLimitOf,
  listOffsetOf,
  optionalLocationOf,
  resourceIdOf,
  searchQueryOf
} from "../modules/browse/domain.js";
import type { ObjectStoragePort } from "../modules/system/object-storage-ports.js";
import type { AgentRepository } from "../modules/agent/agent-repository.js";
import { AgentService } from "../modules/agent/agent-service.js";
import type { AgentQuestion, TriStateAnswer } from "../modules/agent/contracts.js";
import { ConversationService } from "../modules/agent/conversation-service.js";
import type { ConversationTurnResult, ConversationTestRunResult } from "../modules/agent/conversation-contracts.js";
import type { ConfirmedFact } from "../modules/clinical-rules/contracts.js";
import { cityOf, forecastDaysOf } from "../modules/environment/domain.js";
import type {
  EnvironmentCacheRepository,
  EnvironmentProviderPort
} from "../modules/environment/environment-ports.js";
import { EnvironmentService } from "../modules/environment/environment-service.js";
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

/**
 * agent exec / agent start --message 消息长度上限（字符数）：
 * 与 HTTP 请求体 64KiB 约束对齐取小者（事务与卫生残留批 P2-12d）。
 */
export const AGENT_MESSAGE_MAX_LENGTH = 4096;

export interface DoctorCheck {
  name: string;
  status: "ok" | "failed" | "not_configured";
  message: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  healthy: boolean;
}

export type DoctorCheckProvider = () => Promise<DoctorReport>;

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
  private readonly accounts: AccountService;
  private readonly environment: EnvironmentService;
  private readonly conversations: ConversationService;

  constructor(
    sessions: SessionService,
    recordRepository: RecordRepository,
    contentReadRepository: ContentReadRepository,
    agentRepository: AgentRepository,
    accountService: AccountService,
    environmentProvider: EnvironmentProviderPort,
    environmentCache: EnvironmentCacheRepository,
    conversations: ConversationService,
    consentGate: ConsentGatePort,
    private readonly closeResources: () => void = () => {},
    private readonly doctorProvider: DoctorCheckProvider = async () => ({
      checks: [],
      healthy: true
    }),
    objectStorage?: ObjectStoragePort | undefined
  ) {
    this.sessions = sessions;
    this.records = new RecordService(recordRepository, consentGate);
    // environment 先于 browse 构造：browse 首页环境区块经窄端口
    // （BrowseEnvironmentPort）复用 EnvironmentService 的缓存语义。
    this.environment = new EnvironmentService(
      environmentProvider,
      environmentCache
    );
    this.browse = new BrowseService(
      contentReadRepository,
      this.environment,
      objectStorage
    );
    this.agent = new AgentService(
      agentRepository,
      new RecordSnapshotAdapter(this.records)
    );
    this.accounts = accountService;
    this.conversations = conversations;
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    const command = request.command.trim();
    const input = request.input ?? {};

    try {
      this.rejectClientIdentity(input);

      if (command === "doctor") {
        return success(
          command,
          await this.doctorProvider(),
          request.requestId
        );
      }

      if (command === "account" || command.startsWith("account ")) {
        // 必须 await：让 dispatchAccount 的拒绝在 try/catch 内转为 failure 结果。
        return await this.dispatchAccount(command, input, request);
      }

      switch (command) {
        case "browse":
          return success(
            command,
            await this.browse.home(optionalLocationOf(input)),
            request.requestId
          );
        case "browse article list": {
          const limit = listLimitOf(input);
          const offset = listOffsetOf(input);
          return success(
            command,
            {
              items: await this.browse.listPage("article", limit, offset),
              limit,
              offset
            },
            request.requestId
          );
        }
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
                searchQueryOf(input)
              )
            },
            request.requestId
          );
        case "browse article show":
          return success(
            command,
            await this.browse.get("article", resourceIdOf(input)),
            request.requestId
          );
        case "browse video list": {
          const limit = listLimitOf(input);
          const offset = listOffsetOf(input);
          return success(
            command,
            {
              items: await this.browse.listPage("video", limit, offset),
              limit,
              offset
            },
            request.requestId
          );
        }
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
                searchQueryOf(input)
              )
            },
            request.requestId
          );
        case "browse video show":
          return success(
            command,
            await this.browse.get("video", resourceIdOf(input)),
            request.requestId
          );
        case "browse plan list":
          return success(
            command,
            await this.browse.listPlans(),
            request.requestId
          );
        case "browse plan show":
          return success(
            command,
            await this.browse.showPlan(resourceIdOf(input)),
            request.requestId
          );
        case "browse search":
          return success(
            command,
            await this.browse.searchAll(searchQueryOf(input)),
            request.requestId
          );
        case "browse environment current":
          return success(
            command,
            await this.environment.current(cityOf(input)),
            request.requestId
          );
        case "browse environment forecast":
          return success(
            command,
            {
              items: await this.environment.forecast(
                cityOf(input),
                forecastDaysOf(input)
              )
            },
            request.requestId
          );
        case "browse environment refresh":
          return success(
            command,
            await this.environment.refresh(cityOf(input)),
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
          const message =
            typeof input.message === "string" ? input.message.trim() : "";
          // 消息长度上限（事务与卫生残留批 P2-12d）：service 层入口统一
          // 校验（conversation-service 属并行域，校验放在本分发处），
          // 与 HTTP 64KiB 约束对齐取小者（字符数）。
          this.assertAgentMessageLength(message);
          return success(
            command,
            await this.conversations.execTurn({
              patientId,
              message,
              conversationId: this.optionalString(input, "conversationId"),
              saveConsent: input.saveConsent === true
            }),
            request.requestId
          );
        }
        if (command === "agent start") {
          const message =
            typeof input.message === "string" ? input.message.trim() : "";
          this.assertAgentMessageLength(message);
          return success(
            command,
            await this.conversations.execTurn({
              patientId,
              message,
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

      // 未知命令先于身份解析返回 command_invalid（与登录状态无关）：
      // 避免无 token 时未知命令漂移成 authentication_required（exit 9）。
      if (!this.isKnownCommand(command)) {
        throw new DomainError("command_invalid", `未知命令：${command}`);
      }

      const patientId = (await this.sessions.resolvePatient(request.sessionToken)).patientId;

      switch (command) {
        // 语义分流（评审 P0-3 收敛，非同一输入双路由）：
        // 无 --message 的 agent/agent start → 确定性安全会话（#131 结构化
        // 问答，agent_sessions 表，登录必需）；带 --message → 自由对话管线
        //（ConversationService，agent_conversations 表，匿名允许），
        // 由 isAnonymousAgentCommand 的 message 条件唯一分流。
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
              // id 缺省 = 裸 continue（设计 §6.5）：续接最近待答会话，
              // 由 AgentService 经 findLatestAwaiting 解析。
              id: this.optionalString(input, "id"),
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
            await this.records.createSymptom(
              patientId,
              {
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
              },
              request.requestId
            ),
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
            await this.records.updateSymptom(patientId, update, request.requestId),
            request.requestId
          );
        }
        case "record symptom delete":
          requireConfirmation(input);
          await this.records.deleteSymptom(
            patientId,
            {
              id: requiredString(input, "id"),
              expectedRevision: positiveInteger(input, "expectedRevision")
            },
            request.requestId
          );
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
            await this.records.updateProfile(patientId, update, request.requestId),
            request.requestId
          );
        }

        case "record exposure add":
          return success(
            command,
            await this.records.createExposure(
              patientId,
              {
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
              },
              request.requestId
            ),
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
            await this.records.updateExposure(patientId, update, request.requestId),
            request.requestId
          );
        }
        case "record exposure delete":
          requireConfirmation(input);
          await this.records.deleteExposure(
            patientId,
            {
              id: requiredString(input, "id"),
              expectedRevision: positiveInteger(input, "expectedRevision")
            },
            request.requestId
          );
          return success(
            command,
            { id: input.id, deleted: true },
            request.requestId
          );

        case "record medication add":
          return success(
            command,
            await this.records.createMedication(
              patientId,
              {
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
              },
              request.requestId
            ),
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
            await this.records.updateMedication(patientId, update, request.requestId),
            request.requestId
          );
        }
        case "record medication delete":
          requireConfirmation(input);
          await this.records.deleteMedication(
            patientId,
            {
              id: requiredString(input, "id"),
              expectedRevision: positiveInteger(input, "expectedRevision")
            },
            request.requestId
          );
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

  /** account 命令组（患者 CLI 设计 §9）：本地账号、会话、资料、同意与隐私。 */
  private async dispatchAccount(
    command: string,
    input: Record<string, unknown>,
    request: CommandRequest
  ): Promise<CommandResult> {
    const { sessionToken } = request;
    switch (command) {
      case "account register": {
        const outcome = await this.accounts.register({
          username: requiredString(input, "username"),
          nickname: optionalString(input, "nickname"),
          password: input.password
        });
        return success(command, outcome, request.requestId);
      }
      case "account login": {
        const outcome = await this.accounts.login({
          username: requiredString(input, "username"),
          password: input.password
        });
        return success(command, outcome, request.requestId);
      }
      case "account status":
        return success(
          command,
          await this.accounts.status(sessionToken),
          request.requestId
        );
      case "account logout":
        return success(
          command,
          await this.accounts.logout(sessionToken),
          request.requestId
        );
      case "account profile show": {
        const patientId = (await this.sessions.resolvePatient(sessionToken)).patientId;
        return success(
          command,
          await this.accounts.profileShow(patientId),
          request.requestId
        );
      }
      case "account profile update": {
        const patientId = (await this.sessions.resolvePatient(sessionToken)).patientId;
        return success(
          command,
          await this.accounts.profileUpdate(
            patientId,
            optionalString(input, "nickname"),
            // CAS（事务与卫生残留批 P2-9）：与 record profile update 一致。
            integerInRange(
              input,
              "expectedRevision",
              0,
              Number.MAX_SAFE_INTEGER
            )
          ),
          request.requestId
        );
      }
      case "account consent show": {
        const patientId = (await this.sessions.resolvePatient(sessionToken)).patientId;
        return success(
          command,
          await this.accounts.consentShow(patientId),
          request.requestId
        );
      }
      case "account consent update": {
        const patientId = (await this.sessions.resolvePatient(sessionToken)).patientId;
        return success(
          command,
          await this.accounts.consentUpdate(patientId, {
            consentType: input.consentType,
            decision: input.decision,
            policyVersion: requiredString(input, "policyVersion"),
            requestId: requiredString(input, "requestId")
          }),
          request.requestId
        );
      }
      case "account privacy":
        return success(
          command,
          this.accounts.privacy(),
          request.requestId
        );
      // 患者 CLI 设计 §9.7：范围、保留期限与处理时限需另行确认，
      // 本版本明确返回未实现，绝不伪造"已删除"。
      case "account data":
      case "account data export":
      case "account data deletion-request":
      case "account data request-status":
      case "account deactivate":
      case "account reminder":
      case "account reminder show":
      case "account reminder update":
      case "account notification":
      case "account notification list":
      case "account notification read":
        throw new DomainError(
          "capability_unavailable",
          "数据导出/删除/停用与提醒通知的范围、保留期限和处理时限尚未确认，本版本明确不提供"
        );
      default:
        throw new DomainError(
          "command_invalid",
          command === "account"
            ? "account 需要子命令（register/login/status/logout/profile/consent/privacy/data/deactivate）"
            : `未知命令：${command}`
        );
    }
  }

  close(): void {
    this.closeResources();
  }

  /**
   * 已发布内容引用的媒体字节（HTTP GET /v1/media/:id 专用）：不套命令
   * 信封协议，直接给适配层字节流；无已发布引用/素材不可用/未配置对象
   * 存储一律 null（路由 404，不泄露存在性）。
   */
  async getPublishedMedia(mediaId: string): Promise<PublishedMedia | null> {
    return this.browse.getPublishedMedia(mediaId);
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

  /**
   * 已知命令判定（身份解析前置）：help/doctor 免登录；agent 的未知子命令
   * 由 isAnonymousAgentCommand 拦截，browse 的未知子命令由 switch 拦截；
   * 其余未知命令组在此统一返回 command_invalid。
   */
  private isKnownCommand(command: string): boolean {
    return (
      command === "help" ||
      command === "doctor" ||
      command === "browse" ||
      command.startsWith("browse ") ||
      command === "agent" ||
      command.startsWith("agent ") ||
      command.startsWith("record ") ||
      command === "account" ||
      command.startsWith("account ")
    );
  }

  /** 无 token 视为匿名（允许一次性体验）；有 token 则必须有效。 */
  private async resolvePatientOrNull(
    token: string | undefined
  ): Promise<string | null> {
    if (token === undefined || token.trim() === "") {
      return null;
    }
    return (await this.sessions.resolvePatient(token)).patientId;
  }

  /**
   * agent exec / agent start --message 的消息长度上限
   * （事务与卫生残留批 P2-12d）：4096 字符（与 HTTP 请求体 64KiB
   * 对齐取小者），超限 validation_failed，避免超长消息进入对话存储。
   */
  private assertAgentMessageLength(message: string): void {
    if (message.length > AGENT_MESSAGE_MAX_LENGTH) {
      throw new DomainError(
        "validation_failed",
        `消息长度不能超过 ${AGENT_MESSAGE_MAX_LENGTH} 字符`
      );
    }
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
