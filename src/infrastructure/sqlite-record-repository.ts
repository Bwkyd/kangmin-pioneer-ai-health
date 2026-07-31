import { KangminDatabase } from "./database.js";
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
  notes: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ExposureRow {
  id: string;
  patient_id: string;
  local_date: string;
  factors_json: string;
  other_description: string | null;
  notes: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface MedicationRow {
  id: string;
  patient_id: string;
  local_date: string;
  medication_name: string;
  dosage: string | null;
  actual_use: string | null;
  notes: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ProfileRow {
  patient_id: string;
  display_name: string | null;
  birth_date: string | null;
  sex: Sex;
  allergy_history: string | null;
  known_allergies: string | null;
  common_triggers: string | null;
  notes: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface IdempotencyRow {
  request_hash: string;
  result_json: string;
}

interface ProjectionRow {
  id: string;
  local_date: string;
  tnss_total: number;
}

function toSymptom(row: SymptomRow): SymptomRecord {
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

function toExposure(row: ExposureRow): ExposureRecord {
  return {
    id: row.id,
    localDate: row.local_date,
    factors: JSON.parse(row.factors_json) as string[],
    otherDescription: row.other_description,
    notes: row.notes,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMedication(row: MedicationRow): MedicationRecord {
  return {
    id: row.id,
    localDate: row.local_date,
    medicationName: row.medication_name,
    dosage: row.dosage,
    actualUse: row.actual_use,
    notes: row.notes,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toProfile(row: ProfileRow): HealthProfile {
  return {
    displayName: row.display_name,
    birthDate: row.birth_date,
    sex: row.sex,
    allergyHistory: row.allergy_history,
    knownAllergies: row.known_allergies,
    commonTriggers: row.common_triggers,
    notes: row.notes,
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
  | { kind: "date_conflict" };

export class SqliteRecordRepository implements RecordRepository {
  constructor(private readonly database: KangminDatabase) {}

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
        insert: () => {
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
        }
      });
      return outcome;
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
    return rows.map(toSymptom);
  }

  async findSymptom(
    patientId: string,
    id: string
  ): Promise<SymptomRecord | null> {
    return this.findOwned("symptom_records", patientId, id, toSymptom);
  }

  async updateSymptom(
    input: UpdateSymptomRecordInput
  ): Promise<UpdateSymptomRecordOutcome> {
    return this.database.transaction(() => {
      const current = this.findOwned(
        "symptom_records",
        input.patientId,
        input.id,
        toSymptom
      );
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
        return {
          kind: "version_conflict",
          currentRevision:
            this.findOwned("symptom_records", input.patientId, input.id, toSymptom)
              ?.revision ?? current.revision
        };
      }

      const updated = this.findOwned(
        "symptom_records",
        input.patientId,
        input.id,
        toSymptom
      );
      if (updated === null) {
        return { kind: "not_found" };
      }
      return { kind: "updated", record: updated };
    });
  }

  async deleteSymptom(
    patientId: string,
    id: string,
    expectedRevision: number
  ): Promise<DeleteRecordOutcome> {
    return this.database.transaction(() =>
      this.deleteOwned("symptom_records", patientId, id, expectedRevision)
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
    return row === undefined ? null : toProfile(row);
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
        this.database.connection
          .prepare(`
            INSERT INTO profiles(
              patient_id, display_name, birth_date, sex,
              allergy_history, known_allergies, common_triggers, notes,
              revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          `)
          .run(
            input.patientId,
            input.displayName,
            input.birthDate,
            input.sex,
            input.allergyHistory,
            input.knownAllergies,
            input.commonTriggers,
            input.notes,
            input.updatedAt,
            input.updatedAt
          );
        return {
          kind: "created",
          record: this.readProfileSync(input.patientId)
        };
      }

      const result = this.database.connection
        .prepare(`
          UPDATE profiles
          SET display_name = ?,
              birth_date = ?,
              sex = ?,
              allergy_history = ?,
              known_allergies = ?,
              common_triggers = ?,
              notes = ?,
              revision = revision + 1,
              updated_at = ?
          WHERE patient_id = ? AND revision = ?
        `)
        .run(
          input.displayName,
          input.birthDate,
          input.sex,
          input.allergyHistory,
          input.knownAllergies,
          input.commonTriggers,
          input.notes,
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

      return { kind: "updated", record: this.readProfileSync(input.patientId) };
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
        insert: () => {
          this.database.connection
            .prepare(`
              INSERT INTO exposure_records(
                id, patient_id, local_date,
                factors_json, other_description, notes,
                revision, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              input.record.id,
              input.patientId,
              input.record.localDate,
              JSON.stringify(input.record.factors),
              input.record.otherDescription,
              input.record.notes,
              input.record.revision,
              input.record.createdAt,
              input.record.updatedAt
            );
        }
      });
      return outcome;
    });
  }

  async listExposures(patientId: string): Promise<ExposureRecord[]> {
    const rows = this.database.connection
      .prepare(`
        SELECT *
        FROM exposure_records
        WHERE patient_id = ?
        ORDER BY local_date DESC, created_at DESC
      `)
      .all(patientId) as unknown as ExposureRow[];
    return rows.map(toExposure);
  }

  async findExposure(
    patientId: string,
    id: string
  ): Promise<ExposureRecord | null> {
    return this.findOwned("exposure_records", patientId, id, toExposure);
  }

  async updateExposure(
    input: UpdateExposureRecordInput
  ): Promise<UpdateExposureRecordOutcome> {
    return this.database.transaction(() => {
      const current = this.findOwned(
        "exposure_records",
        input.patientId,
        input.id,
        toExposure
      );
      if (current === null) {
        return { kind: "not_found" };
      }

      const result = this.database.connection
        .prepare(`
          UPDATE exposure_records
          SET factors_json = ?,
              other_description = ?,
              notes = ?,
              revision = revision + 1,
              updated_at = ?
          WHERE id = ? AND patient_id = ? AND revision = ?
        `)
        .run(
          JSON.stringify(input.factors),
          input.otherDescription,
          input.notes,
          input.updatedAt,
          input.id,
          input.patientId,
          input.expectedRevision
        );

      if (result.changes !== 1) {
        return {
          kind: "version_conflict",
          currentRevision:
            this.findOwned(
              "exposure_records",
              input.patientId,
              input.id,
              toExposure
            )?.revision ?? current.revision
        };
      }

      const updated = this.findOwned(
        "exposure_records",
        input.patientId,
        input.id,
        toExposure
      );
      if (updated === null) {
        return { kind: "not_found" };
      }
      return { kind: "updated", record: updated };
    });
  }

  async deleteExposure(
    patientId: string,
    id: string,
    expectedRevision: number
  ): Promise<DeleteRecordOutcome> {
    return this.database.transaction(() =>
      this.deleteOwned("exposure_records", patientId, id, expectedRevision)
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
        insert: () => {
          this.database.connection
            .prepare(`
              INSERT INTO medication_records(
                id, patient_id, local_date,
                medication_name, dosage, actual_use, notes,
                revision, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              input.record.id,
              input.patientId,
              input.record.localDate,
              input.record.medicationName,
              input.record.dosage,
              input.record.actualUse,
              input.record.notes,
              input.record.revision,
              input.record.createdAt,
              input.record.updatedAt
            );
        }
      });
      if (outcome.kind === "date_conflict") {
        // 用药记录表没有日期唯一约束，此分支在结构上不可达。
        throw new Error("medication insert hit an unexpected unique constraint");
      }
      return outcome;
    });
  }

  async listMedications(patientId: string): Promise<MedicationRecord[]> {
    const rows = this.database.connection
      .prepare(`
        SELECT *
        FROM medication_records
        WHERE patient_id = ?
        ORDER BY local_date DESC, created_at DESC
      `)
      .all(patientId) as unknown as MedicationRow[];
    return rows.map(toMedication);
  }

  async findMedication(
    patientId: string,
    id: string
  ): Promise<MedicationRecord | null> {
    return this.findOwned("medication_records", patientId, id, toMedication);
  }

  async updateMedication(
    input: UpdateMedicationRecordInput
  ): Promise<UpdateMedicationRecordOutcome> {
    return this.database.transaction(() => {
      const current = this.findOwned(
        "medication_records",
        input.patientId,
        input.id,
        toMedication
      );
      if (current === null) {
        return { kind: "not_found" };
      }

      const result = this.database.connection
        .prepare(`
          UPDATE medication_records
          SET medication_name = ?,
              dosage = ?,
              actual_use = ?,
              notes = ?,
              revision = revision + 1,
              updated_at = ?
          WHERE id = ? AND patient_id = ? AND revision = ?
        `)
        .run(
          input.medicationName,
          input.dosage,
          input.actualUse,
          input.notes,
          input.updatedAt,
          input.id,
          input.patientId,
          input.expectedRevision
        );

      if (result.changes !== 1) {
        return {
          kind: "version_conflict",
          currentRevision:
            this.findOwned(
              "medication_records",
              input.patientId,
              input.id,
              toMedication
            )?.revision ?? current.revision
        };
      }

      const updated = this.findOwned(
        "medication_records",
        input.patientId,
        input.id,
        toMedication
      );
      if (updated === null) {
        return { kind: "not_found" };
      }
      return { kind: "updated", record: updated };
    });
  }

  async deleteMedication(
    patientId: string,
    id: string,
    expectedRevision: number
  ): Promise<DeleteRecordOutcome> {
    return this.database.transaction(() =>
      this.deleteOwned("medication_records", patientId, id, expectedRevision)
    );
  }

  async readOverview(
    patientId: string,
    monthPrefix: string
  ): Promise<OverviewSourceData> {
    return this.database.transaction(() => {
      const symptomDates = (
        this.database.connection
          .prepare(`
            SELECT local_date
            FROM symptom_records
            WHERE patient_id = ?
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
    monthStart: string,
    monthEnd: string
  ): Promise<MonthSourceData> {
    return this.database.transaction(() => {
      const symptoms = this.projectionRows(
        "symptom_records",
        patientId,
        monthStart,
        monthEnd
      );
      const exposureDates = this.datesInRange(
        "exposure_records",
        patientId,
        monthStart,
        monthEnd
      );
      const medicationDates = this.datesInRange(
        "medication_records",
        patientId,
        monthStart,
        monthEnd
      );
      return { symptoms, exposureDates, medicationDates };
    });
  }

  async readTrend(
    patientId: string,
    from: string,
    to: string
  ): Promise<TrendSourceData> {
    return this.database.transaction(() => {
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
    insert: () => void;
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
      return previous.request_hash === options.requestHash
        ? {
            kind: "replayed",
            record: JSON.parse(previous.result_json) as T
          }
        : { kind: "idempotency_conflict" };
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
        new Date().toISOString()
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
        WHERE id = ? AND patient_id = ?
      `)
      .get(id, patientId) as unknown as R | undefined;
    return row === undefined ? null : mapRow(row);
  }

  private deleteOwned(
    table: string,
    patientId: string,
    id: string,
    expectedRevision: number
  ): DeleteRecordOutcome {
    const current = this.database.connection
      .prepare(`
        SELECT revision
        FROM ${table}
        WHERE id = ? AND patient_id = ?
      `)
      .get(id, patientId) as unknown as { revision: number } | undefined;
    if (current === undefined) {
      return { kind: "not_found" };
    }

    const result = this.database.connection
      .prepare(`
        DELETE FROM ${table}
        WHERE id = ? AND patient_id = ? AND revision = ?
      `)
      .run(id, patientId, expectedRevision);

    if (result.changes !== 1) {
      const latest = this.database.connection
        .prepare(`
          SELECT revision
          FROM ${table}
          WHERE id = ? AND patient_id = ?
        `)
        .get(id, patientId) as unknown as { revision: number } | undefined;
      return {
        kind: "version_conflict",
        currentRevision: latest?.revision ?? current.revision
      };
    }
    return { kind: "deleted" };
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
    return toProfile(row);
  }

  private latestProjectionRow(
    table: string,
    patientId: string
  ): MonthSymptomRow | null {
    const row = this.database.connection
      .prepare(`
        SELECT id, local_date, tnss_total
        FROM ${table}
        WHERE patient_id = ?
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
        WHERE patient_id = ?
        ORDER BY local_date DESC, created_at DESC
        LIMIT 1
      `)
      .get(patientId) as unknown as { local_date: string } | undefined;
    return row?.local_date ?? null;
  }

  private datesInRange(
    table: string,
    patientId: string,
    monthStart: string,
    monthEnd: string
  ): string[] {
    return (
      this.database.connection
        .prepare(`
          SELECT DISTINCT local_date
          FROM ${table}
          WHERE patient_id = ? AND local_date >= ? AND local_date <= ?
        `)
        .all(patientId, monthStart, monthEnd) as unknown as Array<{
        local_date: string;
      }>
    ).map((row) => row.local_date);
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
