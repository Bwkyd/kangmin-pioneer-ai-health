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
import { SessionService } from "../modules/account/session-service.js";
import type { ContentReadRepository } from "../modules/browse/content-read-repository.js";
import { BrowseService } from "../modules/browse/browse-service.js";
import type { AgentRepository } from "../modules/agent/agent-repository.js";
import { AgentService } from "../modules/agent/agent-service.js";
import type { AgentQuestion, TriStateAnswer } from "../modules/agent/contracts.js";
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
  private readonly accounts: AccountService;

  constructor(
    sessions: SessionService,
    recordRepository: RecordRepository,
    contentReadRepository: ContentReadRepository,
    agentRepository: AgentRepository,
    accountService: AccountService,
    private readonly closeResources: () => void = () => {}
  ) {
    this.sessions = sessions;
    this.records = new RecordService(recordRepository);
    this.browse = new BrowseService(contentReadRepository);
    this.agent = new AgentService(
      agentRepository,
      new RecordSnapshotAdapter(this.records)
    );
    this.accounts = accountService;
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    const command = request.command.trim();
    const input = request.input ?? {};

    try {
      this.rejectClientIdentity(input);

      if (command === "account" || command.startsWith("account ")) {
        // 必须 await：让 dispatchAccount 的拒绝在 try/catch 内转为 failure 结果。
        return await this.dispatchAccount(command, input, request);
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

      const patientId = (await this.sessions.resolvePatient(request.sessionToken)).patientId;

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
            optionalString(input, "nickname")
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
}
