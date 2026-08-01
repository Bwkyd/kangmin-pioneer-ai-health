import { DomainError } from "../../kernel/errors.js";
import type { EncryptionPort } from "../../kernel/encryption.js";
import type { PoolClient, QueryResultRow } from "pg";
import {
  decryptStoredField,
  encryptOptionalFields,
  encryptStoredField
} from "../encrypted-fields.js";
import type {
  ExposureRecord,
  HealthProfile,
  MedicationRecord,
  SymptomRecord
} from "../../modules/record/contracts.js";
import type { Sex } from "../../modules/record/domain.js";
import type {
  CreateExposureRecordInput,
  CreateExposureRecordOutcome,
  CreateMedicationRecordInput,
  CreateMedicationRecordOutcome,
  CreateSymptomRecordInput,
  CreateSymptomRecordOutcome,
  DeleteRecordOutcome,
  MonthSourceData,
  MonthSymptomRow,
  OverviewSourceData,
  RecordRepository,
  TrendSourceData,
  UpdateExposureRecordInput,
  UpdateExposureRecordOutcome,
  UpdateMedicationRecordInput,
  UpdateMedicationRecordOutcome,
  UpdateProfileRecordInput,
  UpdateProfileRecordOutcome,
  UpdateSymptomRecordInput,
  UpdateSymptomRecordOutcome
} from "../../modules/record/record-repository.js";
import { isUniqueViolation, KangminPgDatabase } from "./pg-database.js";
import { runPgIdempotentCreate } from "./pg-idempotency.js";
import type { IdempotentCreateOutcome } from "../idempotency.js";

interface SymptomRow {
  id: string;
  local_date: string;
  nasal_congestion: number;
  nasal_itching: number;
  sneezing: number;
  runny_nose: number;
  tnss_total: number;
  notes_encrypted: string | null;
  encryption_key_version: string | null;
  deleted_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ExposureRow {
  id: string;
  patient_id: string;
  local_date: string;
  factors_json: string;
  other_description_encrypted: string | null;
  notes_encrypted: string | null;
  encryption_key_version: string | null;
  deleted_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface MedicationRow {
  id: string;
  patient_id: string;
  local_date: string;
  medication_name_encrypted: string;
  dosage_encrypted: string | null;
  actual_use_encrypted: string | null;
  notes_encrypted: string | null;
  encryption_key_version: string | null;
  deleted_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ProfileRow {
  patient_id: string;
  display_name_encrypted: string | null;
  birth_date: string | null;
  sex: Sex;
  allergy_history_encrypted: string | null;
  known_allergies_encrypted: string | null;
  common_triggers_encrypted: string | null;
  notes_encrypted: string | null;
  encryption_key_version: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

/** symptom 投影查询的原始行形状（snake_case），映射为领域形状 MonthSymptomRow。 */
interface ProjectionRow {
  id: string;
  local_date: string;
  tnss_total: number;
}

/**
 * 查询执行器：事务内为 db.queryIn(client, …)，事务外为 db.query(…)，
 * 让共享辅助（findOwned/commitOwnedUpdate 等）在两种上下文复用同一实现。
 */
type Querier = <T extends QueryResultRow>(
  sql: string,
  params: readonly unknown[]
) => Promise<{ rows: T[]; rowCount: number }>;

function toSymptom(
  encryption: EncryptionPort,
  row: SymptomRow
): SymptomRecord {
  return {
    id: row.id,
    localDate: row.local_date,
    nasalCongestion: row.nasal_congestion,
    nasalItching: row.nasal_itching,
    sneezing: row.sneezing,
    runnyNose: row.runny_nose,
    tnssTotal: row.tnss_total,
    notes: decryptStoredField(
      encryption,
      row.notes_encrypted,
      row.encryption_key_version,
      "症状备注"
    ),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toExposure(
  encryption: EncryptionPort,
  row: ExposureRow
): ExposureRecord {
  return {
    id: row.id,
    localDate: row.local_date,
    factors: JSON.parse(row.factors_json) as string[],
    otherDescription: decryptStoredField(
      encryption,
      row.other_description_encrypted,
      row.encryption_key_version,
      "暴露描述"
    ),
    notes: decryptStoredField(
      encryption,
      row.notes_encrypted,
      row.encryption_key_version,
      "暴露备注"
    ),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMedication(
  encryption: EncryptionPort,
  row: MedicationRow
): MedicationRecord {
  return {
    id: row.id,
    localDate: row.local_date,
    medicationName: decryptStoredField(
      encryption,
      row.medication_name_encrypted,
      row.encryption_key_version,
      "药品名称"
    ) ?? "",
    dosage: decryptStoredField(
      encryption,
      row.dosage_encrypted,
      row.encryption_key_version,
      "用药剂量"
    ),
    actualUse: decryptStoredField(
      encryption,
      row.actual_use_encrypted,
      row.encryption_key_version,
      "实际用法"
    ),
    notes: decryptStoredField(
      encryption,
      row.notes_encrypted,
      row.encryption_key_version,
      "用药备注"
    ),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toProfile(
  encryption: EncryptionPort,
  row: ProfileRow
): HealthProfile {
  return {
    displayName: decryptStoredField(
      encryption,
      row.display_name_encrypted,
      row.encryption_key_version,
      "档案姓名"
    ),
    birthDate: row.birth_date,
    sex: row.sex,
    allergyHistory: decryptStoredField(
      encryption,
      row.allergy_history_encrypted,
      row.encryption_key_version,
      "过敏史"
    ),
    knownAllergies: decryptStoredField(
      encryption,
      row.known_allergies_encrypted,
      row.encryption_key_version,
      "已知过敏原"
    ),
    commonTriggers: decryptStoredField(
      encryption,
      row.common_triggers_encrypted,
      row.encryption_key_version,
      "常见诱因"
    ),
    notes: decryptStoredField(
      encryption,
      row.notes_encrypted,
      row.encryption_key_version,
      "档案备注"
    ),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMonthSymptom(row: ProjectionRow): MonthSymptomRow {
  return {
    id: row.id,
    localDate: row.local_date,
    tnssTotal: row.tnss_total
  };
}

type CreateOutcome<T> =
  | { kind: "created"; record: T }
  | { kind: "replayed"; record: T }
  | { kind: "idempotency_conflict" }
  | { kind: "stale_replay" }
  | { kind: "date_conflict" };

export class PgRecordRepository implements RecordRepository {
  constructor(
    private readonly database: KangminPgDatabase,
    private readonly encryption: EncryptionPort
  ) {}

  async createSymptom(
    input: CreateSymptomRecordInput
  ): Promise<CreateSymptomRecordOutcome> {
    return this.database.transaction(async (client) => {
      const query = this.inTransaction(client);
      const outcome = await runPgIdempotentCreate(this.database, client, {
        table: "idempotency_records",
        actorColumn: "patient_id",
        scopeColumn: "command_scope",
        keyColumn: "idempotency_key",
        actorId: input.patientId,
        scope: "record.symptom.add",
        key: input.idempotencyKey,
        requestHash: input.requestHash,
        resultJson: JSON.stringify(input.record),
        createdAt: input.record.createdAt,
        uniqueConflictAsDateConflict: true,
        verifyExists: async (json) =>
          (await this.findOwned(
            query,
            "symptom_records",
            input.patientId,
            (JSON.parse(json) as SymptomRecord).id,
            (row: SymptomRow) => toSymptom(this.encryption, row)
          )) !== null,
        insert: async () => {
          const notes = encryptOptionalFields(this.encryption, [
            input.record.notes
          ]);
          await query(
            `INSERT INTO symptom_records(
              id, patient_id, local_date,
              nasal_congestion, nasal_itching, sneezing, runny_nose,
              tnss_total, notes_encrypted, encryption_key_version,
              revision, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              input.record.id,
              input.patientId,
              input.record.localDate,
              input.record.nasalCongestion,
              input.record.nasalItching,
              input.record.sneezing,
              input.record.runnyNose,
              input.record.tnssTotal,
              notes.stored[0],
              notes.keyVersion,
              input.record.revision,
              input.record.createdAt,
              input.record.updatedAt
            ]
          );
        }
      });
      if (outcome.kind === "created") {
        await this.appendVersion(query, {
          recordType: "symptom",
          recordId: input.record.id,
          revision: input.record.revision,
          operation: "create",
          snapshot: input.record,
          actorId: input.patientId,
          requestId: input.requestId
        });
      }
      return this.mapCreateOutcome(outcome, input.record);
    });
  }

  async listSymptoms(patientId: string): Promise<SymptomRecord[]> {
    return this.guardRead(async () => {
      const { rows } = await this.database.query<SymptomRow>(
        `SELECT *
         FROM symptom_records
         WHERE patient_id = $1 AND deleted_at IS NULL
         ORDER BY local_date DESC, created_at DESC`,
        [patientId]
      );
      return rows.map((row: SymptomRow) =>
        toSymptom(this.encryption, row)
      );
    });
  }

  async findSymptom(
    patientId: string,
    id: string
  ): Promise<SymptomRecord | null> {
    return this.findOwned(
      (sql, params) => this.database.query(sql, params),
      "symptom_records",
      patientId,
      id,
      (row: SymptomRow) => toSymptom(this.encryption, row)
    );
  }

  async updateSymptom(
    input: UpdateSymptomRecordInput
  ): Promise<UpdateSymptomRecordOutcome> {
    return this.database.transaction(async (client) => {
      const query = this.inTransaction(client);
      const current = await this.findOwned(
        query,
        "symptom_records",
        input.patientId,
        input.id,
        (row: SymptomRow) => toSymptom(this.encryption, row)
      );
      if (current === null) {
        return { kind: "not_found" };
      }

      const outcome = await this.commitOwnedUpdate({
        query,
        table: "symptom_records",
        patientId: input.patientId,
        id: input.id,
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision,
        mapRow: (row: SymptomRow) => toSymptom(this.encryption, row),
        applyUpdate: async () => {
          const notes = encryptOptionalFields(this.encryption, [input.notes]);
          return query(
            `UPDATE symptom_records
             SET nasal_congestion = $1,
                 nasal_itching = $2,
                 sneezing = $3,
                 runny_nose = $4,
                 tnss_total = $5,
                 notes_encrypted = $6,
                 encryption_key_version = $7,
                 revision = revision + 1,
                 updated_at = $8
             WHERE id = $9 AND patient_id = $10 AND revision = $11
               AND deleted_at IS NULL`,
            [
              input.nasalCongestion,
              input.nasalItching,
              input.sneezing,
              input.runnyNose,
              input.tnssTotal,
              notes.stored[0],
              notes.keyVersion,
              input.updatedAt,
              input.id,
              input.patientId,
              input.expectedRevision
            ]
          );
        }
      });
      if (outcome.kind === "updated") {
        await this.appendVersion(query, {
          recordType: "symptom",
          recordId: input.id,
          revision: outcome.record.revision,
          operation: "update",
          snapshot: outcome.record,
          actorId: input.patientId,
          requestId: input.requestId
        });
      }
      return outcome;
    });
  }

  async deleteSymptom(
    patientId: string,
    id: string,
    expectedRevision: number,
    requestId: string
  ): Promise<DeleteRecordOutcome> {
    return this.database.transaction(async (client) =>
      this.deleteOwned({
        query: this.inTransaction(client),
        table: "symptom_records",
        patientId,
        id,
        expectedRevision,
        mapRow: (row: SymptomRow) => toSymptom(this.encryption, row),
        recordType: "symptom",
        requestId
      })
    );
  }

  async getProfile(patientId: string): Promise<HealthProfile | null> {
    const { rows } = await this.database.query<ProfileRow>(
      `SELECT *
       FROM profiles
       WHERE patient_id = $1`,
      [patientId]
    );
    const row = rows[0];
    return row === undefined
      ? null
      : toProfile(this.encryption, row);
  }

  async updateProfile(
    input: UpdateProfileRecordInput
  ): Promise<UpdateProfileRecordOutcome> {
    return this.database.transaction(async (client) => {
      const query = this.inTransaction(client);
      const { rows: currentRows } = await query<ProfileRow>(
        `SELECT *
         FROM profiles
         WHERE patient_id = $1`,
        [input.patientId]
      );
      const current = currentRows[0];

      if (current === undefined) {
        if (input.expectedRevision !== 0) {
          return { kind: "version_conflict", currentRevision: 0 };
        }
        const encrypted = encryptOptionalFields(this.encryption, [
          input.displayName,
          input.allergyHistory,
          input.knownAllergies,
          input.commonTriggers,
          input.notes
        ]);
        try {
          await query(
            `INSERT INTO profiles(
              patient_id, display_name_encrypted, birth_date, sex,
              allergy_history_encrypted, known_allergies_encrypted,
              common_triggers_encrypted, notes_encrypted,
              encryption_key_version,
              revision, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11)`,
            [
              input.patientId,
              encrypted.stored[0],
              input.birthDate,
              input.sex,
              encrypted.stored[1],
              encrypted.stored[2],
              encrypted.stored[3],
              encrypted.stored[4],
              encrypted.keyVersion,
              input.updatedAt,
              input.updatedAt
            ]
          );
        } catch (error) {
          // 并发创建竞态：另一进程已建档案，裸唯一冲突映射为
          // version_conflict（评审 B P2），不归为 internal_error。
          if (isUniqueViolation(error)) {
            return { kind: "version_conflict", currentRevision: 1 };
          }
          throw error;
        }
        const record = await this.readProfileSync(query, input.patientId);
        await this.appendVersion(query, {
          recordType: "profile",
          recordId: input.patientId,
          revision: record.revision,
          operation: "create",
          snapshot: record,
          actorId: input.patientId,
          requestId: input.requestId
        });
        return { kind: "created", record };
      }

      const encrypted = encryptOptionalFields(this.encryption, [
        input.displayName,
        input.allergyHistory,
        input.knownAllergies,
        input.commonTriggers,
        input.notes
      ]);
      const { rowCount } = await query(
        `UPDATE profiles
         SET display_name_encrypted = $1,
             birth_date = $2,
             sex = $3,
             allergy_history_encrypted = $4,
             known_allergies_encrypted = $5,
             common_triggers_encrypted = $6,
             notes_encrypted = $7,
             encryption_key_version = $8,
             revision = revision + 1,
             updated_at = $9
         WHERE patient_id = $10 AND revision = $11`,
        [
          encrypted.stored[0],
          input.birthDate,
          input.sex,
          encrypted.stored[1],
          encrypted.stored[2],
          encrypted.stored[3],
          encrypted.stored[4],
          encrypted.keyVersion,
          input.updatedAt,
          input.patientId,
          input.expectedRevision
        ]
      );

      if (rowCount !== 1) {
        const { rows: latestRows } = await query<{ revision: number }>(
          `SELECT revision
           FROM profiles
           WHERE patient_id = $1`,
          [input.patientId]
        );
        const latest = latestRows[0];
        return {
          kind: "version_conflict",
          currentRevision: latest?.revision ?? current.revision
        };
      }

      const record = await this.readProfileSync(query, input.patientId);
      await this.appendVersion(query, {
        recordType: "profile",
        recordId: input.patientId,
        revision: record.revision,
        operation: "update",
        snapshot: record,
        actorId: input.patientId,
        requestId: input.requestId
      });
      return { kind: "updated", record };
    });
  }

  async createExposure(
    input: CreateExposureRecordInput
  ): Promise<CreateExposureRecordOutcome> {
    return this.database.transaction(async (client) => {
      const query = this.inTransaction(client);
      const outcome = await runPgIdempotentCreate(this.database, client, {
        table: "idempotency_records",
        actorColumn: "patient_id",
        scopeColumn: "command_scope",
        keyColumn: "idempotency_key",
        actorId: input.patientId,
        scope: "record.exposure.add",
        key: input.idempotencyKey,
        requestHash: input.requestHash,
        resultJson: JSON.stringify(input.record),
        createdAt: input.record.createdAt,
        uniqueConflictAsDateConflict: true,
        verifyExists: async (json) =>
          (await this.findOwned(
            query,
            "exposure_records",
            input.patientId,
            (JSON.parse(json) as ExposureRecord).id,
            (row: ExposureRow) => toExposure(this.encryption, row)
          )) !== null,
        insert: async () => {
          const encrypted = encryptOptionalFields(this.encryption, [
            input.record.otherDescription,
            input.record.notes
          ]);
          await query(
            `INSERT INTO exposure_records(
              id, patient_id, local_date,
              factors_json, other_description_encrypted, notes_encrypted,
              encryption_key_version,
              revision, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              input.record.id,
              input.patientId,
              input.record.localDate,
              JSON.stringify(input.record.factors),
              encrypted.stored[0],
              encrypted.stored[1],
              encrypted.keyVersion,
              input.record.revision,
              input.record.createdAt,
              input.record.updatedAt
            ]
          );
        }
      });
      if (outcome.kind === "created") {
        await this.appendVersion(query, {
          recordType: "exposure",
          recordId: input.record.id,
          revision: input.record.revision,
          operation: "create",
          snapshot: input.record,
          actorId: input.patientId,
          requestId: input.requestId
        });
      }
      return this.mapCreateOutcome(outcome, input.record);
    });
  }

  async listExposures(patientId: string): Promise<ExposureRecord[]> {
    return this.guardRead(async () => {
      const { rows } = await this.database.query<ExposureRow>(
        `SELECT *
         FROM exposure_records
         WHERE patient_id = $1 AND deleted_at IS NULL
         ORDER BY local_date DESC, created_at DESC`,
        [patientId]
      );
      return rows.map((row: ExposureRow) =>
        toExposure(this.encryption, row)
      );
    });
  }

  async findExposure(
    patientId: string,
    id: string
  ): Promise<ExposureRecord | null> {
    return this.findOwned(
      (sql, params) => this.database.query(sql, params),
      "exposure_records",
      patientId,
      id,
      (row: ExposureRow) => toExposure(this.encryption, row)
    );
  }

  async updateExposure(
    input: UpdateExposureRecordInput
  ): Promise<UpdateExposureRecordOutcome> {
    return this.database.transaction(async (client) => {
      const query = this.inTransaction(client);
      const current = await this.findOwned(
        query,
        "exposure_records",
        input.patientId,
        input.id,
        (row: ExposureRow) => toExposure(this.encryption, row)
      );
      if (current === null) {
        return { kind: "not_found" };
      }

      const outcome = await this.commitOwnedUpdate({
        query,
        table: "exposure_records",
        patientId: input.patientId,
        id: input.id,
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision,
        mapRow: (row: ExposureRow) => toExposure(this.encryption, row),
        applyUpdate: async () => {
          const encrypted = encryptOptionalFields(this.encryption, [
            input.otherDescription,
            input.notes
          ]);
          return query(
            `UPDATE exposure_records
             SET factors_json = $1,
                 other_description_encrypted = $2,
                 notes_encrypted = $3,
                 encryption_key_version = $4,
                 revision = revision + 1,
                 updated_at = $5
             WHERE id = $6 AND patient_id = $7 AND revision = $8
               AND deleted_at IS NULL`,
            [
              JSON.stringify(input.factors),
              encrypted.stored[0],
              encrypted.stored[1],
              encrypted.keyVersion,
              input.updatedAt,
              input.id,
              input.patientId,
              input.expectedRevision
            ]
          );
        }
      });
      if (outcome.kind === "updated") {
        await this.appendVersion(query, {
          recordType: "exposure",
          recordId: input.id,
          revision: outcome.record.revision,
          operation: "update",
          snapshot: outcome.record,
          actorId: input.patientId,
          requestId: input.requestId
        });
      }
      return outcome;
    });
  }

  async deleteExposure(
    patientId: string,
    id: string,
    expectedRevision: number,
    requestId: string
  ): Promise<DeleteRecordOutcome> {
    return this.database.transaction(async (client) =>
      this.deleteOwned({
        query: this.inTransaction(client),
        table: "exposure_records",
        patientId,
        id,
        expectedRevision,
        mapRow: (row: ExposureRow) => toExposure(this.encryption, row),
        recordType: "exposure",
        requestId
      })
    );
  }

  async createMedication(
    input: CreateMedicationRecordInput
  ): Promise<CreateMedicationRecordOutcome> {
    return this.database.transaction(async (client) => {
      const query = this.inTransaction(client);
      const outcome = await runPgIdempotentCreate(this.database, client, {
        table: "idempotency_records",
        actorColumn: "patient_id",
        scopeColumn: "command_scope",
        keyColumn: "idempotency_key",
        actorId: input.patientId,
        scope: "record.medication.add",
        key: input.idempotencyKey,
        requestHash: input.requestHash,
        resultJson: JSON.stringify(input.record),
        createdAt: input.record.createdAt,
        verifyExists: async (json) =>
          (await this.findOwned(
            query,
            "medication_records",
            input.patientId,
            (JSON.parse(json) as MedicationRecord).id,
            (row: MedicationRow) => toMedication(this.encryption, row)
          )) !== null,
        insert: async () => {
          const encrypted = encryptOptionalFields(this.encryption, [
            input.record.medicationName,
            input.record.dosage,
            input.record.actualUse,
            input.record.notes
          ]);
          await query(
            `INSERT INTO medication_records(
              id, patient_id, local_date,
              medication_name_encrypted, dosage_encrypted,
              actual_use_encrypted, notes_encrypted,
              encryption_key_version,
              revision, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              input.record.id,
              input.patientId,
              input.record.localDate,
              encrypted.stored[0],
              encrypted.stored[1],
              encrypted.stored[2],
              encrypted.stored[3],
              encrypted.keyVersion,
              input.record.revision,
              input.record.createdAt,
              input.record.updatedAt
            ]
          );
        }
      });
      if (outcome.kind === "created") {
        await this.appendVersion(query, {
          recordType: "medication",
          recordId: input.record.id,
          revision: input.record.revision,
          operation: "create",
          snapshot: input.record,
          actorId: input.patientId,
          requestId: input.requestId
        });
      }
      const mapped = this.mapCreateOutcome(outcome, input.record);
      if (mapped.kind === "date_conflict") {
        // 用药记录表没有日期唯一约束，此分支在结构上不可达；
        // 保留它是为未来加约束时的安全网。
        throw new DomainError(
          "internal_error",
          "用药记录插入意外触发唯一约束"
        );
      }
      return mapped;
    });
  }

  async listMedications(patientId: string): Promise<MedicationRecord[]> {
    return this.guardRead(async () => {
      const { rows } = await this.database.query<MedicationRow>(
        `SELECT *
         FROM medication_records
         WHERE patient_id = $1 AND deleted_at IS NULL
         ORDER BY local_date DESC, created_at DESC`,
        [patientId]
      );
      return rows.map((row: MedicationRow) =>
        toMedication(this.encryption, row)
      );
    });
  }

  async findMedication(
    patientId: string,
    id: string
  ): Promise<MedicationRecord | null> {
    return this.findOwned(
      (sql, params) => this.database.query(sql, params),
      "medication_records",
      patientId,
      id,
      (row: MedicationRow) => toMedication(this.encryption, row)
    );
  }

  async updateMedication(
    input: UpdateMedicationRecordInput
  ): Promise<UpdateMedicationRecordOutcome> {
    return this.database.transaction(async (client) => {
      const query = this.inTransaction(client);
      const current = await this.findOwned(
        query,
        "medication_records",
        input.patientId,
        input.id,
        (row: MedicationRow) => toMedication(this.encryption, row)
      );
      if (current === null) {
        return { kind: "not_found" };
      }

      const outcome = await this.commitOwnedUpdate({
        query,
        table: "medication_records",
        patientId: input.patientId,
        id: input.id,
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision,
        mapRow: (row: MedicationRow) => toMedication(this.encryption, row),
        applyUpdate: async () => {
          const encrypted = encryptOptionalFields(this.encryption, [
            input.medicationName,
            input.dosage,
            input.actualUse,
            input.notes
          ]);
          return query(
            `UPDATE medication_records
             SET medication_name_encrypted = $1,
                 dosage_encrypted = $2,
                 actual_use_encrypted = $3,
                 notes_encrypted = $4,
                 encryption_key_version = $5,
                 revision = revision + 1,
                 updated_at = $6
             WHERE id = $7 AND patient_id = $8 AND revision = $9
               AND deleted_at IS NULL`,
            [
              encrypted.stored[0],
              encrypted.stored[1],
              encrypted.stored[2],
              encrypted.stored[3],
              encrypted.keyVersion,
              input.updatedAt,
              input.id,
              input.patientId,
              input.expectedRevision
            ]
          );
        }
      });
      if (outcome.kind === "updated") {
        await this.appendVersion(query, {
          recordType: "medication",
          recordId: input.id,
          revision: outcome.record.revision,
          operation: "update",
          snapshot: outcome.record,
          actorId: input.patientId,
          requestId: input.requestId
        });
      }
      return outcome;
    });
  }

  async deleteMedication(
    patientId: string,
    id: string,
    expectedRevision: number,
    requestId: string
  ): Promise<DeleteRecordOutcome> {
    return this.database.transaction(async (client) =>
      this.deleteOwned({
        query: this.inTransaction(client),
        table: "medication_records",
        patientId,
        id,
        expectedRevision,
        mapRow: (row: MedicationRow) => toMedication(this.encryption, row),
        recordType: "medication",
        requestId
      })
    );
  }

  async readOverview(
    patientId: string,
    monthPrefix: string
  ): Promise<OverviewSourceData> {
    return this.guardRead(async () =>
      // 与 SQLite readOnly 只读事务一致：整个概览读取共享同一快照。
      this.database.transaction(async (client) => {
        const query = this.inTransaction(client);
        const { rows: dateRows } = await query<{ local_date: string }>(
          `SELECT local_date
           FROM symptom_records
           WHERE patient_id = $1 AND deleted_at IS NULL
           GROUP BY local_date
           ORDER BY local_date DESC`,
          [patientId]
        );
        const symptomDates = dateRows.map((row) => row.local_date);

        // COUNT 在 PostgreSQL 返回 int8（pg 驱动反序列化为 string），
        // 强转 int 保持与 SQLite number 语义一致。
        const { rows: monthRows } = await query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
           FROM symptom_records
           WHERE patient_id = $1 AND local_date LIKE $2
             AND deleted_at IS NULL`,
          [patientId, `${monthPrefix}%`]
        );
        const monthRow = monthRows[0] ?? { count: 0 };

        const lastSymptom = await this.latestProjectionRow(
          query,
          "symptom_records",
          patientId
        );
        const lastExposure = await this.latestDate(
          query,
          "exposure_records",
          patientId
        );
        const lastMedication = await this.latestDate(
          query,
          "medication_records",
          patientId
        );

        return {
          symptomDates,
          monthRecordCount: monthRow.count,
          lastTnss: lastSymptom?.tnssTotal ?? null,
          latestExposureDate: lastExposure,
          latestMedicationDate: lastMedication
        };
      })
    );
  }

  async readMonth(
    patientId: string,
    month: string
  ): Promise<MonthSourceData> {
    return this.guardRead(async () =>
      this.database.transaction(async (client) => {
        const query = this.inTransaction(client);
        const symptoms = await this.projectionRowsInMonth(
          query,
          "symptom_records",
          patientId,
          month
        );
        const exposureDates = await this.datesInMonth(
          query,
          "exposure_records",
          patientId,
          month
        );
        const medicationDates = await this.datesInMonth(
          query,
          "medication_records",
          patientId,
          month
        );
        return { symptoms, exposureDates, medicationDates };
      })
    );
  }

  async readTrend(
    patientId: string,
    from: string,
    to: string
  ): Promise<TrendSourceData> {
    return this.guardRead(async () =>
      this.database.transaction(async (client) => {
        const query = this.inTransaction(client);
        return {
          items: await this.projectionRows(
            query,
            "symptom_records",
            patientId,
            from,
            to
          )
        };
      })
    );
  }

  /** 事务内查询执行器。 */
  private inTransaction(client: PoolClient): Querier {
    return (sql, params) => this.database.queryIn(client, sql, params);
  }

  /** 读失败统一映射 storage_unavailable（retryable），绝不伪装成空数据。 */
  private async guardRead<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        "storage_unavailable",
        "健康记录读取失败，请稍后重试",
        { retryable: true, cause: error }
      );
    }
  }

  /**
   * 把幂等辅助的归一化结果映射为患者侧领域结果。
   * 重放分支必须解析存储的原结果（原始记录 id），不能返回本次请求
   * 携带的新生成记录——与旧实现读取存储行的语义一致。
   */
  private mapCreateOutcome<T>(
    outcome: IdempotentCreateOutcome,
    record: T
  ): CreateOutcome<T> {
    switch (outcome.kind) {
      case "created":
        return { kind: "created", record };
      case "replayed":
        return {
          kind: "replayed",
          record: JSON.parse(outcome.resultJson) as T
        };
      case "stale_replay":
        return { kind: "stale_replay" };
      case "idempotency_conflict":
        return { kind: "idempotency_conflict" };
      case "date_conflict":
        return { kind: "date_conflict" };
    }
  }

  private async findOwned<T, R extends QueryResultRow>(
    query: Querier,
    table: string,
    patientId: string,
    id: string,
    mapRow: (row: R) => T
  ): Promise<T | null> {
    const { rows } = await query<R>(
      `SELECT *
       FROM ${table}
       WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL`,
      [id, patientId]
    );
    const row = rows[0];
    return row === undefined ? null : mapRow(row);
  }

  /** 执行乐观锁 UPDATE 并统一处理 rowCount!==1 的版本冲突与事后丢失。 */
  private async commitOwnedUpdate<T, R extends QueryResultRow>(options: {
    query: Querier;
    table: string;
    patientId: string;
    id: string;
    expectedRevision: number;
    currentRevision: number;
    mapRow: (row: R) => T;
    applyUpdate: () => Promise<{ rows: unknown[]; rowCount: number }>;
  }): Promise<
    | { kind: "updated"; record: T }
    | { kind: "not_found" }
    | { kind: "version_conflict"; currentRevision: number }
  > {
    const result = await options.applyUpdate();
    if (result.rowCount !== 1) {
      const latest = await this.findOwned(
        options.query,
        options.table,
        options.patientId,
        options.id,
        options.mapRow
      );
      return {
        kind: "version_conflict",
        currentRevision:
          (latest as { revision: number } | null)?.revision ??
          options.currentRevision
      };
    }

    const updated = await this.findOwned(
      options.query,
      options.table,
      options.patientId,
      options.id,
      options.mapRow
    );
    if (updated === null) {
      return { kind: "not_found" };
    }
    return { kind: "updated", record: updated };
  }

  private async deleteOwned<T, R extends QueryResultRow>(options: {
    query: Querier;
    table: string;
    patientId: string;
    id: string;
    expectedRevision: number;
    mapRow: (row: R) => T;
    recordType: "symptom" | "exposure" | "medication";
    requestId: string;
  }): Promise<DeleteRecordOutcome> {
    const current = await this.findOwned(
      options.query,
      options.table,
      options.patientId,
      options.id,
      options.mapRow
    );
    if (current === null) {
      return { kind: "not_found" };
    }

    // 软删除：只打时间戳不物理删除；同日唯一约束由部分唯一索引
    // （WHERE deleted_at IS NULL）保证，删除后同日可重建。
    const { rowCount } = await options.query(
      `UPDATE ${options.table}
       SET deleted_at = $1
       WHERE id = $2 AND patient_id = $3 AND revision = $4
         AND deleted_at IS NULL`,
      [
        new Date().toISOString(),
        options.id,
        options.patientId,
        options.expectedRevision
      ]
    );

    if (rowCount !== 1) {
      const { rows: latestRows } = await options.query<{ revision: number }>(
        `SELECT revision
         FROM ${options.table}
         WHERE id = $1 AND patient_id = $2`,
        [options.id, options.patientId]
      );
      const latest = latestRows[0];
      const revision = (current as { revision: number }).revision;
      return {
        kind: "version_conflict",
        currentRevision: latest?.revision ?? revision
      };
    }

    const revision = (current as { revision: number }).revision;
    // 删除凭证 revision 取被删 revision + 1：PK(record_type, record_id,
    // revision) 不允许与同 revision 的 create/update 凭证重号，且
    // 账本按 revision 单调递增可完整回放。
    await this.appendVersion(options.query, {
      recordType: options.recordType,
      recordId: options.id,
      revision: revision + 1,
      operation: "delete",
      snapshot: current,
      actorId: options.patientId,
      requestId: options.requestId
    });
    return { kind: "deleted" };
  }

  /** 追加一次写操作的患者记录版本凭证（与写操作同一事务）。 */
  private async appendVersion(
    query: Querier,
    options: {
      recordType: "symptom" | "profile" | "exposure" | "medication";
      recordId: string;
      revision: number;
      operation: "create" | "update" | "delete";
      snapshot: unknown;
      actorId: string;
      requestId: string;
    }
  ): Promise<void> {
    const { stored, keyVersion } = encryptStoredField(
      this.encryption,
      JSON.stringify(options.snapshot)
    );
    await query(
      `INSERT INTO patient_record_versions(
        record_type, record_id, revision, operation,
        encrypted_snapshot, encryption_key_version,
        actor_kind, actor_id, request_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'patient', $7, $8, $9)`,
      [
        options.recordType,
        options.recordId,
        options.revision,
        options.operation,
        stored,
        keyVersion,
        options.actorId,
        options.requestId,
        new Date().toISOString()
      ]
    );
  }

  private async readProfileSync(
    query: Querier,
    patientId: string
  ): Promise<HealthProfile> {
    const { rows } = await query<ProfileRow>(
      `SELECT *
       FROM profiles
       WHERE patient_id = $1`,
      [patientId]
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("profile row missing after write");
    }
    return toProfile(this.encryption, row);
  }

  private async latestProjectionRow(
    query: Querier,
    table: string,
    patientId: string
  ): Promise<MonthSymptomRow | null> {
    const { rows } = await query<ProjectionRow>(
      `SELECT id, local_date, tnss_total
       FROM ${table}
       WHERE patient_id = $1 AND deleted_at IS NULL
       ORDER BY local_date DESC, created_at DESC
       LIMIT 1`,
      [patientId]
    );
    const row = rows[0];
    return row === undefined ? null : toMonthSymptom(row);
  }

  private async latestDate(
    query: Querier,
    table: string,
    patientId: string
  ): Promise<string | null> {
    const { rows } = await query<{ local_date: string }>(
      `SELECT local_date
       FROM ${table}
       WHERE patient_id = $1 AND deleted_at IS NULL
       ORDER BY local_date DESC, created_at DESC
       LIMIT 1`,
      [patientId]
    );
    return rows[0]?.local_date ?? null;
  }

  private async datesInMonth(
    query: Querier,
    table: string,
    patientId: string,
    month: string
  ): Promise<string[]> {
    const { rows } = await query<{ local_date: string }>(
      `SELECT DISTINCT local_date
       FROM ${table}
       WHERE patient_id = $1 AND local_date LIKE $2
         AND deleted_at IS NULL`,
      [patientId, `${month}%`]
    );
    return rows.map((row) => row.local_date);
  }

  private async projectionRowsInMonth(
    query: Querier,
    table: string,
    patientId: string,
    month: string
  ): Promise<MonthSymptomRow[]> {
    const { rows } = await query<ProjectionRow>(
      `SELECT id, local_date, tnss_total
       FROM ${table}
       WHERE patient_id = $1 AND local_date LIKE $2
         AND deleted_at IS NULL
       ORDER BY local_date ASC, created_at ASC`,
      [patientId, `${month}%`]
    );
    return rows.map(toMonthSymptom);
  }

  private async projectionRows(
    query: Querier,
    table: string,
    patientId: string,
    from: string,
    to: string
  ): Promise<MonthSymptomRow[]> {
    const { rows } = await query<ProjectionRow>(
      `SELECT id, local_date, tnss_total
       FROM ${table}
       WHERE patient_id = $1 AND local_date >= $2 AND local_date <= $3
         AND deleted_at IS NULL
       ORDER BY local_date ASC, created_at ASC`,
      [patientId, from, to]
    );
    return rows.map(toMonthSymptom);
  }
}
