import { KangminDatabase } from "./database.js";
import type { SymptomRecord } from "../modules/record/contracts.js";
import type {
  CreateSymptomRecordInput,
  CreateSymptomRecordOutcome,
  RecordRepository,
  UpdateSymptomRecordInput,
  UpdateSymptomRecordOutcome
} from "../modules/record/record-repository.js";

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

function isUniqueConstraint(error: unknown): boolean {
  return String(error).includes("UNIQUE constraint failed");
}

export class SqliteRecordRepository implements RecordRepository {
  constructor(private readonly database: KangminDatabase) {}

  async createSymptom(
    input: CreateSymptomRecordInput
  ): Promise<CreateSymptomRecordOutcome> {
    return this.database.transaction(() => {
      const commandScope = "record.symptom.add";
      const previous = this.database.connection
        .prepare(`
          SELECT request_hash, result_json
          FROM idempotency_records
          WHERE patient_id = ? AND command_scope = ? AND idempotency_key = ?
        `)
        .get(
          input.patientId,
          commandScope,
          input.idempotencyKey
        ) as unknown as IdempotencyRow | undefined;

      if (previous !== undefined) {
        return previous.request_hash === input.requestHash
          ? {
              kind: "replayed",
              record: JSON.parse(previous.result_json) as SymptomRecord
            }
          : { kind: "idempotency_conflict" };
      }

      try {
        this.database.connection
          .prepare(`
            INSERT INTO symptom_records(
              id, patient_id, local_date,
              nasal_congestion, nasal_itching, sneezing, runny_nose,
              tnss_total, notes, revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            input.record.id,
            input.patientId,
            input.record.localDate,
            input.record.nasalCongestion,
            input.record.nasalItching,
            input.record.sneezing,
            input.record.runnyNose,
            input.record.tnssTotal,
            input.record.notes,
            input.record.revision,
            input.record.createdAt,
            input.record.updatedAt
          );
      } catch (error) {
        if (isUniqueConstraint(error)) {
          return { kind: "date_conflict" };
        }
        throw error;
      }

      this.database.connection
        .prepare(`
          INSERT INTO idempotency_records(
            patient_id, command_scope, idempotency_key,
            request_hash, result_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.patientId,
          commandScope,
          input.idempotencyKey,
          input.requestHash,
          JSON.stringify(input.record),
          input.record.createdAt
        );

      return { kind: "created", record: input.record };
    });
  }

  async listSymptoms(patientId: string): Promise<SymptomRecord[]> {
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

  async findSymptom(
    patientId: string,
    id: string
  ): Promise<SymptomRecord | null> {
    const row = this.database.connection
      .prepare(`
        SELECT *
        FROM symptom_records
        WHERE id = ? AND patient_id = ?
      `)
      .get(id, patientId) as unknown as SymptomRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  async updateSymptom(
    input: UpdateSymptomRecordInput
  ): Promise<UpdateSymptomRecordOutcome> {
    return this.database.transaction(() => {
      const current = this.findOwnedSync(input.patientId, input.id);
      if (current === null) {
        return { kind: "not_found" };
      }

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
          input.nasalCongestion,
          input.nasalItching,
          input.sneezing,
          input.runnyNose,
          input.tnssTotal,
          input.notes,
          input.updatedAt,
          input.id,
          input.patientId,
          input.expectedRevision
        );

      if (result.changes !== 1) {
        const latest = this.findOwnedSync(input.patientId, input.id);
        return {
          kind: "version_conflict",
          currentRevision: latest?.revision ?? current.revision
        };
      }

      const updated = this.findOwnedSync(input.patientId, input.id);
      if (updated === null) {
        return { kind: "not_found" };
      }
      return { kind: "updated", record: updated };
    });
  }

  private findOwnedSync(
    patientId: string,
    id: string
  ): SymptomRecord | null {
    const row = this.database.connection
      .prepare(`
        SELECT *
        FROM symptom_records
        WHERE id = ? AND patient_id = ?
      `)
      .get(id, patientId) as unknown as SymptomRow | undefined;
    return row === undefined ? null : toRecord(row);
  }
}
