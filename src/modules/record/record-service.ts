import { createHash, randomUUID } from "node:crypto";

import { KangminDatabase } from "../../infrastructure/database.js";
import { DomainError } from "../../kernel/errors.js";
import type {
  CreateSymptomInput,
  SymptomRecord,
  UpdateSymptomInput
} from "./contracts.js";

interface SymptomRow {
  id: string;
  local_date: string;
  nasal_congestion: number;
  nasal_itching: number;
  sneezing: number;
  runny_nose: number;
  tnss_total: number;
  notes: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface IdempotencyRow {
  request_hash: string;
  result_json: string;
}

function toRecord(row: SymptomRow): SymptomRecord {
  return {
    id: row.id,
    localDate: row.local_date,
    nasalCongestion: row.nasal_congestion,
    nasalItching: row.nasal_itching,
    sneezing: row.sneezing,
    runnyNose: row.runny_nose,
    tnssTotal: row.tnss_total,
    notes: row.notes,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export class RecordService {
  constructor(private readonly database: KangminDatabase) {}

  createSymptom(
    patientId: string,
    input: CreateSymptomInput
  ): SymptomRecord {
    const commandScope = "record.symptom.add";
    const requestHash = stableHash({
      localDate: input.localDate,
      nasalCongestion: input.nasalCongestion,
      nasalItching: input.nasalItching,
      sneezing: input.sneezing,
      runnyNose: input.runnyNose,
      notes: input.notes
    });

    return this.database.transaction(() => {
      const previous = this.database.connection
        .prepare(`
          SELECT request_hash, result_json
          FROM idempotency_records
          WHERE patient_id = ? AND command_scope = ? AND idempotency_key = ?
        `)
        .get(
          patientId,
          commandScope,
          input.idempotencyKey
        ) as unknown as IdempotencyRow | undefined;

      if (previous !== undefined) {
        if (previous.request_hash !== requestHash) {
          throw new DomainError(
            "idempotency_conflict",
            "相同幂等键已用于不同请求"
          );
        }
        return JSON.parse(previous.result_json) as SymptomRecord;
      }

      const now = new Date().toISOString();
      const id = randomUUID();
      const tnssTotal =
        input.nasalCongestion +
        input.nasalItching +
        input.sneezing +
        input.runnyNose;

      try {
        this.database.connection
          .prepare(`
            INSERT INTO symptom_records(
              id, patient_id, local_date,
              nasal_congestion, nasal_itching, sneezing, runny_nose,
              tnss_total, notes, revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          `)
          .run(
            id,
            patientId,
            input.localDate,
            input.nasalCongestion,
            input.nasalItching,
            input.sneezing,
            input.runnyNose,
            tnssTotal,
            input.notes,
            now,
            now
          );
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) {
          throw new DomainError(
            "version_conflict",
            "该日期已存在症状记录，请先读取后更新",
            { cause: error }
          );
        }
        throw error;
      }

      const record = this.getOwned(patientId, id);
      this.database.connection
        .prepare(`
          INSERT INTO idempotency_records(
            patient_id, command_scope, idempotency_key,
            request_hash, result_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          patientId,
          commandScope,
          input.idempotencyKey,
          requestHash,
          JSON.stringify(record),
          now
        );
      return record;
    });
  }

  listSymptoms(patientId: string): SymptomRecord[] {
    const rows = this.database.connection
      .prepare(`
        SELECT *
        FROM symptom_records
        WHERE patient_id = ?
        ORDER BY local_date DESC, created_at DESC
      `)
      .all(patientId) as unknown as SymptomRow[];
    return rows.map(toRecord);
  }

  getSymptom(patientId: string, id: string): SymptomRecord {
    return this.getOwned(patientId, id);
  }

  updateSymptom(
    patientId: string,
    input: UpdateSymptomInput
  ): SymptomRecord {
    return this.database.transaction(() => {
      const current = this.getOwned(patientId, input.id);
      const next = {
        nasalCongestion: input.nasalCongestion ?? current.nasalCongestion,
        nasalItching: input.nasalItching ?? current.nasalItching,
        sneezing: input.sneezing ?? current.sneezing,
        runnyNose: input.runnyNose ?? current.runnyNose,
        notes: input.notes === undefined ? current.notes : input.notes
      };
      const tnssTotal =
        next.nasalCongestion +
        next.nasalItching +
        next.sneezing +
        next.runnyNose;
      const now = new Date().toISOString();

      const result = this.database.connection
        .prepare(`
          UPDATE symptom_records
          SET nasal_congestion = ?,
              nasal_itching = ?,
              sneezing = ?,
              runny_nose = ?,
              tnss_total = ?,
              notes = ?,
              revision = revision + 1,
              updated_at = ?
          WHERE id = ? AND patient_id = ? AND revision = ?
        `)
        .run(
          next.nasalCongestion,
          next.nasalItching,
          next.sneezing,
          next.runnyNose,
          tnssTotal,
          next.notes,
          now,
          input.id,
          patientId,
          input.expectedRevision
        );

      if (result.changes !== 1) {
        throw new DomainError(
          "version_conflict",
          "记录已更新，请重新读取后再修改",
          {
            details: {
              expectedRevision: input.expectedRevision,
              currentRevision: current.revision
            }
          }
        );
      }
      return this.getOwned(patientId, input.id);
    });
  }

  private getOwned(patientId: string, id: string): SymptomRecord {
    const row = this.database.connection
      .prepare(`
        SELECT *
        FROM symptom_records
        WHERE id = ? AND patient_id = ?
      `)
      .get(id, patientId) as unknown as SymptomRow | undefined;

    if (row === undefined) {
      throw new DomainError(
        "resource_not_found",
        "症状记录不存在"
      );
    }
    return toRecord(row);
  }
}
