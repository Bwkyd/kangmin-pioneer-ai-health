import { DomainError } from "../kernel/errors.js";
import type { EncryptionPort } from "../kernel/encryption.js";
import { KangminDatabase } from "./database.js";
import {
  decryptStoredField,
  encryptOptionalFields,
  encryptStoredField
} from "./encrypted-fields.js";
import type {
  ExposureRecord,
  HealthProfile,
  MedicationRecord,
  SymptomRecord
} from "../modules/record/contracts.js";
import type { Sex } from "../modules/record/domain.js";
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
} from "../modules/record/record-repository.js";

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

interface IdempotencyRow {
  request_hash: string;
  result_json: string;
}

/** symptom 投影查询的原始行形状（snake_case），映射为领域形状 MonthSymptomRow。 */
interface ProjectionRow {
  id: string;
  local_date: string;
  tnss_total: number;
}

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

function isUniqueConstraint(error: unknown): boolean {
  return String(error).includes("UNIQUE constraint failed");
}

type CreateOutcome<T> =
  | { kind: "created"; record: T }
  | { kind: "replayed"; record: T }
  | { kind: "idempotency_conflict" }
  | { kind: "stale_replay" }
  | { kind: "date_conflict" };

export class SqliteRecordRepository implements RecordRepository {
  constructor(
    private readonly database: KangminDatabase,
    private readonly encryption: EncryptionPort
  ) {}

  async createSymptom(
    input: CreateSymptomRecordInput
  ): Promise<CreateSymptomRecordOutcome> {
    return this.database.transaction(() => {
      const outcome = this.runWithIdempotency({
        patientId: input.patientId,
        commandScope: "record.symptom.add",
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        uniquePatientDate: true,
        result: input.record,
        createdAt: input.record.createdAt,
        verifyExists: (record) =>
          this.findOwned(
            "symptom_records",
            input.patientId,
            record.id,
            (row) => toSymptom(this.encryption, row)
          ) !== null,
        insert: () => {
          const notes = encryptOptionalFields(this.encryption, [
            input.record.notes
          ]);
          this.database.connection
            .prepare(`
              INSERT INTO symptom_records(
                id, patient_id, local_date,
                nasal_congestion, nasal_itching, sneezing, runny_nose,
                tnss_total, notes_encrypted, encryption_key_version,
                revision, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              notes.stored[0],
              notes.keyVersion,
              input.record.revision,
              input.record.createdAt,
              input.record.updatedAt
            );
        }
      });
      if (outcome.kind === "created") {
        this.appendVersion({
          recordType: "symptom",
          recordId: input.record.id,
          revision: input.record.revision,
          operation: "create",
          snapshot: input.record,
          actorId: input.patientId,
          requestId: input.requestId
        });
      }
      return outcome;
    });
  }

  async listSymptoms(patientId: string): Promise<SymptomRecord[]> {
    const rows = this.database.connection
      .prepare(`
        SELECT *
        FROM symptom_records
        WHERE patient_id = ? AND deleted_at IS NULL
        ORDER BY local_date DESC, created_at DESC
      `)
      .all(patientId) as unknown as SymptomRow[];
    return rows.map((row) => toSymptom(this.encryption, row));
  }

  async findSymptom(
    patientId: string,
    id: string
  ): Promise<SymptomRecord | null> {
    return this.findOwned(
      "symptom_records",
      patientId,
      id,
      (row) => toSymptom(this.encryption, row)
    );
  }

  async updateSymptom(
    input: UpdateSymptomRecordInput
  ): Promise<UpdateSymptomRecordOutcome> {
    return this.database.transaction(() => {
      const current = this.findOwned(
        "symptom_records",
        input.patientId,
        input.id,
        (row) => toSymptom(this.encryption, row)
      );
      if (current === null) {
        return { kind: "not_found" };
      }

      const outcome = this.commitOwnedUpdate({
        table: "symptom_records",
        patientId: input.patientId,
        id: input.id,
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision,
        mapRow: (row) => toSymptom(this.encryption, row),
        applyUpdate: () => {
          const notes = encryptOptionalFields(this.encryption, [input.notes]);
          return this.database.connection
            .prepare(`
              UPDATE symptom_records
              SET nasal_congestion = ?,
                  nasal_itching = ?,
                  sneezing = ?,
                  runny_nose = ?,
                  tnss_total = ?,
                  notes_encrypted = ?,
                  encryption_key_version = ?,
                  revision = revision + 1,
                  updated_at = ?
              WHERE id = ? AND patient_id = ? AND revision = ?
                AND deleted_at IS NULL
            `)
            .run(
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
            );
        }
      });
      if (outcome.kind === "updated") {
        this.appendVersion({
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
    return this.database.transaction(() =>
      this.deleteOwned({
        table: "symptom_records",
        patientId,
        id,
        expectedRevision,
        mapRow: (row) => toSymptom(this.encryption, row),
        recordType: "symptom",
        requestId
      })
    );
  }

  async getProfile(patientId: string): Promise<HealthProfile | null> {
    const row = this.database.connection
      .prepare(`
        SELECT *
        FROM profiles
        WHERE patient_id = ?
      `)
      .get(patientId) as unknown as ProfileRow | undefined;
    return row === undefined
      ? null
      : toProfile(this.encryption, row);
  }

  async updateProfile(
    input: UpdateProfileRecordInput
  ): Promise<UpdateProfileRecordOutcome> {
    return this.database.transaction(() => {
      const current = this.database.connection
        .prepare(`
          SELECT *
          FROM profiles
          WHERE patient_id = ?
        `)
        .get(input.patientId) as unknown as ProfileRow | undefined;

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
        this.database.connection
          .prepare(`
            INSERT INTO profiles(
              patient_id, display_name_encrypted, birth_date, sex,
              allergy_history_encrypted, known_allergies_encrypted,
              common_triggers_encrypted, notes_encrypted,
              encryption_key_version,
              revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          `)
          .run(
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
          );
        const record = this.readProfileSync(input.patientId);
        this.appendVersion({
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
      const result = this.database.connection
        .prepare(`
          UPDATE profiles
          SET display_name_encrypted = ?,
              birth_date = ?,
              sex = ?,
              allergy_history_encrypted = ?,
              known_allergies_encrypted = ?,
              common_triggers_encrypted = ?,
              notes_encrypted = ?,
              encryption_key_version = ?,
              revision = revision + 1,
              updated_at = ?
          WHERE patient_id = ? AND revision = ?
        `)
        .run(
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
        );

      if (result.changes !== 1) {
        const latest = this.database.connection
          .prepare(`
            SELECT revision
            FROM profiles
            WHERE patient_id = ?
          `)
          .get(input.patientId) as unknown as { revision: number } | undefined;
        return {
          kind: "version_conflict",
          currentRevision: latest?.revision ?? current.revision
        };
      }

      const record = this.readProfileSync(input.patientId);
      this.appendVersion({
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
    return this.database.transaction(() => {
      const outcome = this.runWithIdempotency({
        patientId: input.patientId,
        commandScope: "record.exposure.add",
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        uniquePatientDate: true,
        result: input.record,
        createdAt: input.record.createdAt,
        verifyExists: (record) =>
          this.findOwned(
            "exposure_records",
            input.patientId,
            record.id,
            (row) => toExposure(this.encryption, row)
          ) !== null,
        insert: () => {
          const encrypted = encryptOptionalFields(this.encryption, [
            input.record.otherDescription,
            input.record.notes
          ]);
          this.database.connection
            .prepare(`
              INSERT INTO exposure_records(
                id, patient_id, local_date,
                factors_json, other_description_encrypted, notes_encrypted,
                encryption_key_version,
                revision, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
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
            );
        }
      });
      if (outcome.kind === "created") {
        this.appendVersion({
          recordType: "exposure",
          recordId: input.record.id,
          revision: input.record.revision,
          operation: "create",
          snapshot: input.record,
          actorId: input.patientId,
          requestId: input.requestId
        });
      }
      return outcome;
    });
  }

  async listExposures(patientId: string): Promise<ExposureRecord[]> {
    const rows = this.database.connection
      .prepare(`
        SELECT *
        FROM exposure_records
        WHERE patient_id = ? AND deleted_at IS NULL
        ORDER BY local_date DESC, created_at DESC
      `)
      .all(patientId) as unknown as ExposureRow[];
    return rows.map((row) => toExposure(this.encryption, row));
  }

  async findExposure(
    patientId: string,
    id: string
  ): Promise<ExposureRecord | null> {
    return this.findOwned(
      "exposure_records",
      patientId,
      id,
      (row) => toExposure(this.encryption, row)
    );
  }

  async updateExposure(
    input: UpdateExposureRecordInput
  ): Promise<UpdateExposureRecordOutcome> {
    return this.database.transaction(() => {
      const current = this.findOwned(
        "exposure_records",
        input.patientId,
        input.id,
        (row) => toExposure(this.encryption, row)
      );
      if (current === null) {
        return { kind: "not_found" };
      }

      const outcome = this.commitOwnedUpdate({
        table: "exposure_records",
        patientId: input.patientId,
        id: input.id,
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision,
        mapRow: (row) => toExposure(this.encryption, row),
        applyUpdate: () => {
          const encrypted = encryptOptionalFields(this.encryption, [
            input.otherDescription,
            input.notes
          ]);
          return this.database.connection
            .prepare(`
              UPDATE exposure_records
              SET factors_json = ?,
                  other_description_encrypted = ?,
                  notes_encrypted = ?,
                  encryption_key_version = ?,
                  revision = revision + 1,
                  updated_at = ?
              WHERE id = ? AND patient_id = ? AND revision = ?
                AND deleted_at IS NULL
            `)
            .run(
              JSON.stringify(input.factors),
              encrypted.stored[0],
              encrypted.stored[1],
              encrypted.keyVersion,
              input.updatedAt,
              input.id,
              input.patientId,
              input.expectedRevision
            );
        }
      });
      if (outcome.kind === "updated") {
        this.appendVersion({
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
    return this.database.transaction(() =>
      this.deleteOwned({
        table: "exposure_records",
        patientId,
        id,
        expectedRevision,
        mapRow: (row) => toExposure(this.encryption, row),
        recordType: "exposure",
        requestId
      })
    );
  }

  async createMedication(
    input: CreateMedicationRecordInput
  ): Promise<CreateMedicationRecordOutcome> {
    return this.database.transaction(() => {
      const outcome = this.runWithIdempotency({
        patientId: input.patientId,
        commandScope: "record.medication.add",
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        uniquePatientDate: false,
        result: input.record,
        createdAt: input.record.createdAt,
        verifyExists: (record) =>
          this.findOwned(
            "medication_records",
            input.patientId,
            record.id,
            (row) => toMedication(this.encryption, row)
          ) !== null,
        insert: () => {
          const encrypted = encryptOptionalFields(this.encryption, [
            input.record.medicationName,
            input.record.dosage,
            input.record.actualUse,
            input.record.notes
          ]);
          this.database.connection
            .prepare(`
              INSERT INTO medication_records(
                id, patient_id, local_date,
                medication_name_encrypted, dosage_encrypted,
                actual_use_encrypted, notes_encrypted,
                encryption_key_version,
                revision, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
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
            );
        }
      });
      if (outcome.kind === "date_conflict") {
        // 用药记录表没有日期唯一约束，此分支在结构上不可达；
        // 保留它是为未来加约束时的安全网。
        throw new DomainError(
          "internal_error",
          "用药记录插入意外触发唯一约束"
        );
      }
      if (outcome.kind === "created") {
        this.appendVersion({
          recordType: "medication",
          recordId: input.record.id,
          revision: input.record.revision,
          operation: "create",
          snapshot: input.record,
          actorId: input.patientId,
          requestId: input.requestId
        });
      }
      return outcome;
    });
  }

  async listMedications(patientId: string): Promise<MedicationRecord[]> {
    const rows = this.database.connection
      .prepare(`
        SELECT *
        FROM medication_records
        WHERE patient_id = ? AND deleted_at IS NULL
        ORDER BY local_date DESC, created_at DESC
      `)
      .all(patientId) as unknown as MedicationRow[];
    return rows.map((row) => toMedication(this.encryption, row));
  }

  async findMedication(
    patientId: string,
    id: string
  ): Promise<MedicationRecord | null> {
    return this.findOwned(
      "medication_records",
      patientId,
      id,
      (row) => toMedication(this.encryption, row)
    );
  }

  async updateMedication(
    input: UpdateMedicationRecordInput
  ): Promise<UpdateMedicationRecordOutcome> {
    return this.database.transaction(() => {
      const current = this.findOwned(
        "medication_records",
        input.patientId,
        input.id,
        (row) => toMedication(this.encryption, row)
      );
      if (current === null) {
        return { kind: "not_found" };
      }

      const outcome = this.commitOwnedUpdate({
        table: "medication_records",
        patientId: input.patientId,
        id: input.id,
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision,
        mapRow: (row) => toMedication(this.encryption, row),
        applyUpdate: () => {
          const encrypted = encryptOptionalFields(this.encryption, [
            input.medicationName,
            input.dosage,
            input.actualUse,
            input.notes
          ]);
          return this.database.connection
            .prepare(`
              UPDATE medication_records
              SET medication_name_encrypted = ?,
                  dosage_encrypted = ?,
                  actual_use_encrypted = ?,
                  notes_encrypted = ?,
                  encryption_key_version = ?,
                  revision = revision + 1,
                  updated_at = ?
              WHERE id = ? AND patient_id = ? AND revision = ?
                AND deleted_at IS NULL
            `)
            .run(
              encrypted.stored[0],
              encrypted.stored[1],
              encrypted.stored[2],
              encrypted.stored[3],
              encrypted.keyVersion,
              input.updatedAt,
              input.id,
              input.patientId,
              input.expectedRevision
            );
        }
      });
      if (outcome.kind === "updated") {
        this.appendVersion({
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
    return this.database.transaction(() =>
      this.deleteOwned({
        table: "medication_records",
        patientId,
        id,
        expectedRevision,
        mapRow: (row) => toMedication(this.encryption, row),
        recordType: "medication",
        requestId
      })
    );
  }

  async readOverview(
    patientId: string,
    monthPrefix: string
  ): Promise<OverviewSourceData> {
    return this.database.readOnly(() => {
      const symptomDates = (
        this.database.connection
          .prepare(`
            SELECT local_date
            FROM symptom_records
            WHERE patient_id = ? AND deleted_at IS NULL
            GROUP BY local_date
            ORDER BY local_date DESC
          `)
          .all(patientId) as unknown as Array<{ local_date: string }>
      ).map((row) => row.local_date);

      const monthRow = this.database.connection
        .prepare(`
          SELECT COUNT(*) AS count
          FROM symptom_records
          WHERE patient_id = ? AND local_date LIKE ?
            AND deleted_at IS NULL
        `)
        .get(patientId, `${monthPrefix}%`) as unknown as { count: number };

      const lastSymptom = this.latestProjectionRow("symptom_records", patientId);
      const lastExposure = this.latestDate("exposure_records", patientId);
      const lastMedication = this.latestDate("medication_records", patientId);

      return {
        symptomDates,
        monthRecordCount: monthRow.count,
        lastTnss: lastSymptom?.tnssTotal ?? null,
        latestExposureDate: lastExposure,
        latestMedicationDate: lastMedication
      };
    });
  }

  async readMonth(
    patientId: string,
    month: string
  ): Promise<MonthSourceData> {
    return this.database.readOnly(() => {
      const symptoms = this.projectionRowsInMonth(
        "symptom_records",
        patientId,
        month
      );
      const exposureDates = this.datesInMonth(
        "exposure_records",
        patientId,
        month
      );
      const medicationDates = this.datesInMonth(
        "medication_records",
        patientId,
        month
      );
      return { symptoms, exposureDates, medicationDates };
    });
  }

  async readTrend(
    patientId: string,
    from: string,
    to: string
  ): Promise<TrendSourceData> {
    return this.database.readOnly(() => {
      return {
        items: this.projectionRows("symptom_records", patientId, from, to)
      };
    });
  }

  private runWithIdempotency<T>(options: {
    patientId: string;
    commandScope: string;
    idempotencyKey: string;
    requestHash: string;
    uniquePatientDate: boolean;
    result: T;
    createdAt: string;
    insert: () => void;
    /** 重放时校验原记录仍存在；已删除时返回 stale_replay，避免返回幻影记录。 */
    verifyExists: (record: T) => boolean;
  }): CreateOutcome<T> {
    const previous = this.database.connection
      .prepare(`
        SELECT request_hash, result_json
        FROM idempotency_records
        WHERE patient_id = ? AND command_scope = ? AND idempotency_key = ?
      `)
      .get(
        options.patientId,
        options.commandScope,
        options.idempotencyKey
      ) as unknown as IdempotencyRow | undefined;

    if (previous !== undefined) {
      if (previous.request_hash !== options.requestHash) {
        return { kind: "idempotency_conflict" };
      }
      const record = JSON.parse(previous.result_json) as T;
      return options.verifyExists(record)
        ? { kind: "replayed", record }
        : { kind: "stale_replay" };
    }

    try {
      options.insert();
    } catch (error) {
      if (options.uniquePatientDate && isUniqueConstraint(error)) {
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
        options.patientId,
        options.commandScope,
        options.idempotencyKey,
        options.requestHash,
        JSON.stringify(options.result),
        options.createdAt
      );

    return { kind: "created", record: options.result };
  }

  private findOwned<T, R>(
    table: string,
    patientId: string,
    id: string,
    mapRow: (row: R) => T
  ): T | null {
    const row = this.database.connection
      .prepare(`
        SELECT *
        FROM ${table}
        WHERE id = ? AND patient_id = ? AND deleted_at IS NULL
      `)
      .get(id, patientId) as unknown as R | undefined;
    return row === undefined ? null : mapRow(row);
  }

  /** 执行乐观锁 UPDATE 并统一处理 changes!==1 的版本冲突与事后丢失。 */
  private commitOwnedUpdate<T, R>(options: {
    table: string;
    patientId: string;
    id: string;
    expectedRevision: number;
    currentRevision: number;
    mapRow: (row: R) => T;
    applyUpdate: () => { changes: number | bigint };
  }):
    | { kind: "updated"; record: T }
    | { kind: "not_found" }
    | { kind: "version_conflict"; currentRevision: number } {
    const result = options.applyUpdate();
    if (Number(result.changes) !== 1) {
      return {
        kind: "version_conflict",
        currentRevision:
          (this.findOwned(
            options.table,
            options.patientId,
            options.id,
            options.mapRow
          ) as { revision: number } | null)?.revision ?? options.currentRevision
      };
    }

    const updated = this.findOwned(
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

  private deleteOwned<T, R>(options: {
    table: string;
    patientId: string;
    id: string;
    expectedRevision: number;
    mapRow: (row: R) => T;
    recordType: "symptom" | "exposure" | "medication";
    requestId: string;
  }): DeleteRecordOutcome {
    const current = this.findOwned(
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
    const result = this.database.connection
      .prepare(`
        UPDATE ${options.table}
        SET deleted_at = ?
        WHERE id = ? AND patient_id = ? AND revision = ?
          AND deleted_at IS NULL
      `)
      .run(
        new Date().toISOString(),
        options.id,
        options.patientId,
        options.expectedRevision
      );

    if (result.changes !== 1) {
      const latest = this.database.connection
        .prepare(`
          SELECT revision
          FROM ${options.table}
          WHERE id = ? AND patient_id = ?
        `)
        .get(options.id, options.patientId) as unknown as
        | { revision: number }
        | undefined;
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
    this.appendVersion({
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
  private appendVersion(options: {
    recordType: "symptom" | "profile" | "exposure" | "medication";
    recordId: string;
    revision: number;
    operation: "create" | "update" | "delete";
    snapshot: unknown;
    actorId: string;
    requestId: string;
  }): void {
    const { stored, keyVersion } = encryptStoredField(
      this.encryption,
      JSON.stringify(options.snapshot)
    );
    this.database.connection
      .prepare(`
        INSERT INTO patient_record_versions(
          record_type, record_id, revision, operation,
          encrypted_snapshot, encryption_key_version,
          actor_kind, actor_id, request_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'patient', ?, ?, ?)
      `)
      .run(
        options.recordType,
        options.recordId,
        options.revision,
        options.operation,
        stored,
        keyVersion,
        options.actorId,
        options.requestId,
        new Date().toISOString()
      );
  }

  private readProfileSync(patientId: string): HealthProfile {
    const row = this.database.connection
      .prepare(`
        SELECT *
        FROM profiles
        WHERE patient_id = ?
      `)
      .get(patientId) as unknown as ProfileRow | undefined;
    if (row === undefined) {
      throw new Error("profile row missing after write");
    }
    return toProfile(this.encryption, row);
  }

  private latestProjectionRow(
    table: string,
    patientId: string
  ): MonthSymptomRow | null {
    const row = this.database.connection
      .prepare(`
        SELECT id, local_date, tnss_total
        FROM ${table}
        WHERE patient_id = ? AND deleted_at IS NULL
        ORDER BY local_date DESC, created_at DESC
        LIMIT 1
      `)
      .get(patientId) as unknown as ProjectionRow | undefined;
    return row === undefined ? null : toMonthSymptom(row);
  }

  private latestDate(table: string, patientId: string): string | null {
    const row = this.database.connection
      .prepare(`
        SELECT local_date
        FROM ${table}
        WHERE patient_id = ? AND deleted_at IS NULL
        ORDER BY local_date DESC, created_at DESC
        LIMIT 1
      `)
      .get(patientId) as unknown as { local_date: string } | undefined;
    return row?.local_date ?? null;
  }

  private datesInMonth(
    table: string,
    patientId: string,
    month: string
  ): string[] {
    return (
      this.database.connection
        .prepare(`
          SELECT DISTINCT local_date
          FROM ${table}
          WHERE patient_id = ? AND local_date LIKE ?
            AND deleted_at IS NULL
        `)
        .all(patientId, `${month}%`) as unknown as Array<{
        local_date: string;
      }>
    ).map((row) => row.local_date);
  }

  private projectionRowsInMonth(
    table: string,
    patientId: string,
    month: string
  ): MonthSymptomRow[] {
    const rows = this.database.connection
      .prepare(`
        SELECT id, local_date, tnss_total
        FROM ${table}
        WHERE patient_id = ? AND local_date LIKE ?
          AND deleted_at IS NULL
        ORDER BY local_date ASC, created_at ASC
      `)
      .all(patientId, `${month}%`) as unknown as ProjectionRow[];
    return rows.map(toMonthSymptom);
  }

  private projectionRows(
    table: string,
    patientId: string,
    from: string,
    to: string
  ): MonthSymptomRow[] {
    const rows = this.database.connection
      .prepare(`
        SELECT id, local_date, tnss_total
        FROM ${table}
        WHERE patient_id = ? AND local_date >= ? AND local_date <= ?
          AND deleted_at IS NULL
        ORDER BY local_date ASC, created_at ASC
      `)
      .all(patientId, from, to) as unknown as ProjectionRow[];
    return rows.map(toMonthSymptom);
  }
}

function toMonthSymptom(row: ProjectionRow): MonthSymptomRow {
  return {
    id: row.id,
    localDate: row.local_date,
    tnssTotal: row.tnss_total
  };
}
