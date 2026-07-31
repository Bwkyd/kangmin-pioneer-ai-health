import { createHash, randomUUID } from "node:crypto";

import { DomainError } from "../../kernel/errors.js";
import type {
  CreateSymptomInput,
  SymptomRecord,
  UpdateSymptomInput
} from "./contracts.js";
import type { RecordRepository } from "./record-repository.js";

function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export class RecordService {
  constructor(private readonly repository: RecordRepository) {}

  async createSymptom(
    patientId: string,
    input: CreateSymptomInput
  ): Promise<SymptomRecord> {
    const requestHash = stableHash({
      localDate: input.localDate,
      nasalCongestion: input.nasalCongestion,
      nasalItching: input.nasalItching,
      sneezing: input.sneezing,
      runnyNose: input.runnyNose,
      notes: input.notes
    });
    const now = new Date().toISOString();
    const record: SymptomRecord = {
      id: randomUUID(),
      localDate: input.localDate,
      nasalCongestion: input.nasalCongestion,
      nasalItching: input.nasalItching,
      sneezing: input.sneezing,
      runnyNose: input.runnyNose,
      tnssTotal:
        input.nasalCongestion +
        input.nasalItching +
        input.sneezing +
        input.runnyNose,
      notes: input.notes,
      revision: 1,
      createdAt: now,
      updatedAt: now
    };
    const outcome = await this.repository.createSymptom({
      patientId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      record
    });

    if (outcome.kind === "idempotency_conflict") {
      throw new DomainError(
        "idempotency_conflict",
        "相同幂等键已用于不同请求"
      );
    }
    if (outcome.kind === "date_conflict") {
      throw new DomainError(
        "version_conflict",
        "该日期已存在症状记录，请先读取后更新"
      );
    }
    return outcome.record;
  }

  async listSymptoms(patientId: string): Promise<SymptomRecord[]> {
    return this.repository.listSymptoms(patientId);
  }

  async getSymptom(
    patientId: string,
    id: string
  ): Promise<SymptomRecord> {
    const record = await this.repository.findSymptom(patientId, id);
    if (record === null) {
      throw new DomainError(
        "resource_not_found",
        "症状记录不存在"
      );
    }
    return record;
  }

  async updateSymptom(
    patientId: string,
    input: UpdateSymptomInput
  ): Promise<SymptomRecord> {
    const current = await this.repository.findSymptom(patientId, input.id);
    if (current === null) {
      throw new DomainError(
        "resource_not_found",
        "症状记录不存在"
      );
    }

    const next = {
      nasalCongestion: input.nasalCongestion ?? current.nasalCongestion,
      nasalItching: input.nasalItching ?? current.nasalItching,
      sneezing: input.sneezing ?? current.sneezing,
      runnyNose: input.runnyNose ?? current.runnyNose,
      notes: input.notes === undefined ? current.notes : input.notes
    };
    const outcome = await this.repository.updateSymptom({
      patientId,
      id: input.id,
      expectedRevision: input.expectedRevision,
      ...next,
      tnssTotal:
        next.nasalCongestion +
        next.nasalItching +
        next.sneezing +
        next.runnyNose,
      updatedAt: new Date().toISOString()
    });

    if (outcome.kind === "not_found") {
      throw new DomainError(
        "resource_not_found",
        "症状记录不存在"
      );
    }
    if (outcome.kind === "version_conflict") {
      throw new DomainError(
        "version_conflict",
        "记录已更新，请重新读取后再修改",
        {
          details: {
            expectedRevision: input.expectedRevision,
            currentRevision: outcome.currentRevision
          }
        }
      );
    }
    return outcome.record;
  }
}
