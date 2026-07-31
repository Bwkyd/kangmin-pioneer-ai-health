import { DomainError } from "../kernel/errors.js";
import {
  failure,
  success,
  type CommandResult
} from "../kernel/result.js";
import {
  integerInRange,
  localDate,
  optionalIntegerInRange,
  optionalString,
  positiveInteger,
  requiredString
} from "../kernel/validation.js";
import { SessionService } from "../modules/account/session-service.js";
import type { SessionRepository } from "../modules/account/session-repository.js";
import type { RecordRepository } from "../modules/record/record-repository.js";
import { RecordService } from "../modules/record/record-service.js";

export interface CommandRequest {
  command: string;
  input?: Record<string, unknown> | undefined;
  sessionToken?: string | undefined;
  requestId?: string | undefined;
}

export class KangminApplication {
  readonly sessions: SessionService;
  private readonly records: RecordService;

  constructor(
    sessionRepository: SessionRepository,
    recordRepository: RecordRepository,
    private readonly closeResources: () => void = () => {}
  ) {
    this.sessions = new SessionService(sessionRepository);
    this.records = new RecordService(recordRepository);
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    const command = request.command.trim();
    const input = request.input ?? {};

    try {
      this.rejectClientIdentity(input);

      if (command === "agent") {
        throw new DomainError(
          "capability_unavailable",
          "Agent 尚未进入本次 MVP，实现不会伪造对话或临床结果"
        );
      }

      if (command === "browse" || command === "account") {
        throw new DomainError(
          "capability_unavailable",
          `${command} 尚未进入本次 MVP`
        );
      }

      const patientId = await this.sessions.resolvePatient(request.sessionToken);

      switch (command) {
        case "record symptom add":
          return success(
            command,
            await this.records.createSymptom(patientId, {
              localDate: localDate(input, "localDate"),
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

          if (
            update.nasalCongestion === undefined &&
            update.nasalItching === undefined &&
            update.sneezing === undefined &&
            update.runnyNose === undefined &&
            update.notes === undefined
          ) {
            throw new DomainError(
              "validation_failed",
              "至少提供一个需要更新的字段"
            );
          }

          return success(
            command,
            await this.records.updateSymptom(patientId, update),
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
}
