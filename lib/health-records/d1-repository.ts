import {
  HealthRecordError,
  allergenOption,
  type ExposureInput,
  type ExposureRecord,
  type HealthProfile,
  type HealthProfileInput,
  type MedicationInput,
  type MedicationRecord,
  type SymptomRecord,
  type SymptomRecordInput,
  type TriggerProjection,
} from "./domain.ts";
import type { HealthRecordsRepository } from "./repository.ts";

type ProfileRow = {
  basic_info: string;
  allergy_history: string;
  common_triggers: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type MedicationRow = {
  id: string;
  taken_at: string;
  medication_name: string;
  dosage_status: "known" | "unknown";
  dosage_value: string | null;
  dosage_unit: string | null;
  actual_use_status: "known" | "unknown";
  actual_use_description: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type SymptomRow = {
  id: string;
  symptom_date: string;
  sneezing: number;
  rhinorrhea: number;
  congestion: number;
  itching: number;
  total_score: number;
  version: number;
  created_at: string;
  updated_at: string;
};

type ExposureRow = {
  id: string;
  exposure_date: string;
  other_description: string | null;
  note: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type SelectionRow = {
  exposure_id: string;
  group_code: ExposureInput["selections"][number]["group"];
  option_code: ExposureInput["selections"][number]["code"];
};

type ExposureWithSelectionRow = ExposureRow & {
  group_code: ExposureInput["selections"][number]["group"] | null;
  option_code: ExposureInput["selections"][number]["code"] | null;
};

type TriggerRow = SelectionRow & {
  exposure_date: string;
  other_description: string | null;
};

const IDEMPOTENCY_LEASE_MS = 5 * 60 * 1000;

function exposureDateConflict() {
  return new HealthRecordError(409, "DATE_CONFLICT", "同一天已有过敏原患者自述记录，请编辑原记录或更换日期");
}

function isExposureDateConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("allergen_exposure_records_user_date_idx")
    || /UNIQUE constraint failed: allergen_exposure_records\.user_id, allergen_exposure_records\.exposure_date/u.test(message);
}

function now() {
  return new Date().toISOString();
}

function mapProfile(row: ProfileRow): HealthProfile {
  return {
    basicInfo: JSON.parse(row.basic_info),
    allergyHistory: JSON.parse(row.allergy_history),
    commonTriggers: JSON.parse(row.common_triggers),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMedication(row: MedicationRow): MedicationRecord {
  return {
    id: row.id,
    takenAt: row.taken_at,
    medicationName: row.medication_name,
    dosage: row.dosage_status === "unknown"
      ? { status: "unknown" }
      : { status: "known", value: row.dosage_value!, unit: row.dosage_unit! },
    actualUse: row.actual_use_status === "unknown"
      ? { status: "unknown" }
      : { status: "known", description: row.actual_use_description! },
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSymptom(row: SymptomRow): SymptomRecord {
  return {
    id: row.id,
    date: row.symptom_date,
    scores: { sneezing: row.sneezing, rhinorrhea: row.rhinorrhea, congestion: row.congestion, itching: row.itching },
    totalScore: row.total_score,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapExposure(row: ExposureRow, selections: SelectionRow[]): ExposureRecord {
  return {
    id: row.id,
    date: row.exposure_date,
    selections: selections
      .filter((selection) => selection.exposure_id === row.id)
      .map((selection) => ({ group: selection.group_code, code: selection.option_code })),
    otherDescription: row.other_description,
    note: row.note,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class D1HealthRecordsRepository implements HealthRecordsRepository {
  private readonly getDatabase: () => Promise<D1Database>;

  constructor(getDatabase: () => Promise<D1Database>) {
    this.getDatabase = getDatabase;
  }

  async getProfile(userId: string) {
    const row = await (await this.getDatabase()).prepare(
      "SELECT basic_info, allergy_history, common_triggers, version, created_at, updated_at FROM health_profiles WHERE user_id = ?",
    ).bind(userId).first<ProfileRow>();
    return row ? mapProfile(row) : null;
  }

  async getProfileSnapshot(userId: string) {
    const database = await this.getDatabase();
    const [profileResult, triggerResult] = await database.batch([
      database.prepare("SELECT basic_info, allergy_history, common_triggers, version, created_at, updated_at FROM health_profiles WHERE user_id = ?").bind(userId),
      database.prepare("SELECT e.id exposure_id, e.exposure_date, e.other_description, s.group_code, s.option_code FROM allergen_exposure_records e JOIN allergen_exposure_selections s ON s.exposure_id = e.id WHERE e.user_id = ? ORDER BY e.exposure_date DESC, e.id").bind(userId),
    ]);
    const profileRow = profileResult.results[0] as ProfileRow | undefined;
    return {
      profile: profileRow ? mapProfile(profileRow) : null,
      triggers: this.projectTriggerRows(triggerResult.results as TriggerRow[]),
    };
  }

  async saveProfile(userId: string, expectedVersion: number, input: HealthProfileInput) {
    const database = await this.getDatabase();
    const timestamp = now();
    const statements = expectedVersion === 0
      ? [
        database.prepare("INSERT OR IGNORE INTO health_profiles (user_id, basic_info, allergy_history, common_triggers, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
          .bind(userId, JSON.stringify(input.basicInfo), JSON.stringify(input.allergyHistory), JSON.stringify(input.commonTriggers), timestamp, timestamp),
        database.prepare("SELECT basic_info, allergy_history, common_triggers, version, created_at, updated_at FROM health_profiles WHERE user_id = ?").bind(userId),
        database.prepare("SELECT e.id exposure_id, e.exposure_date, e.other_description, s.group_code, s.option_code FROM allergen_exposure_records e JOIN allergen_exposure_selections s ON s.exposure_id = e.id WHERE e.user_id = ? ORDER BY e.exposure_date DESC, e.id").bind(userId),
      ]
      : [
        database.prepare("UPDATE health_profiles SET basic_info = ?, allergy_history = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND version = ?")
          .bind(JSON.stringify(input.basicInfo), JSON.stringify(input.allergyHistory), timestamp, userId, expectedVersion),
        database.prepare("SELECT basic_info, allergy_history, common_triggers, version, created_at, updated_at FROM health_profiles WHERE user_id = ?").bind(userId),
        database.prepare("SELECT e.id exposure_id, e.exposure_date, e.other_description, s.group_code, s.option_code FROM allergen_exposure_records e JOIN allergen_exposure_selections s ON s.exposure_id = e.id WHERE e.user_id = ? ORDER BY e.exposure_date DESC, e.id").bind(userId),
      ];
    const results = await database.batch(statements);
    if (results[0].meta.changes === 0) {
      if (expectedVersion === 0) throw new HealthRecordError(409, "VERSION_CONFLICT", "健康档案已存在，请刷新后重试");
      const exists = await database.prepare("SELECT user_id FROM health_profiles WHERE user_id = ?").bind(userId).first<{ user_id: string }>();
      throw new HealthRecordError(exists ? 409 : 404, exists ? "VERSION_CONFLICT" : "NOT_FOUND", exists ? "健康档案已被更新，请刷新后重试" : "健康档案不存在");
    }
    const row = results[1].results[0] as ProfileRow | undefined;
    if (!row) throw new HealthRecordError(500, "INTERNAL_ERROR", "健康档案保存后无法读取当前快照");
    return { profile: mapProfile(row), triggers: this.projectTriggerRows(results[2].results as TriggerRow[]) };
  }

  async listMedications(userId: string) {
    const rows = await (await this.getDatabase()).prepare(
      "SELECT id, taken_at, medication_name, dosage_status, dosage_value, dosage_unit, actual_use_status, actual_use_description, version, created_at, updated_at FROM medication_records WHERE user_id = ? ORDER BY taken_at DESC, id DESC",
    ).bind(userId).all<MedicationRow>();
    return rows.results.map(mapMedication);
  }

  async createMedication(userId: string, key: string, requestHash: string, input: MedicationInput) {
    const database = await this.getDatabase();
    const claim = await this.claimIdempotency<MedicationRecord>(database, userId, "medication", key, requestHash);
    if (claim.replay) return { value: claim.replay, replayed: true };
    const id = `med_${crypto.randomUUID()}`;
    const timestamp = now();
    const value: MedicationRecord = { id, ...input, version: 1, createdAt: timestamp, updatedAt: timestamp };
    try {
      const results = await database.batch([
        database.prepare("INSERT INTO medication_records (id, user_id, taken_at, medication_name, dosage_status, dosage_value, dosage_unit, actual_use_status, actual_use_description, version, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM health_record_idempotency WHERE id = ? AND state = 'pending')")
          .bind(id, userId, input.takenAt, input.medicationName, input.dosage.status, input.dosage.status === "known" ? input.dosage.value : null, input.dosage.status === "known" ? input.dosage.unit : null, input.actualUse.status, input.actualUse.status === "known" ? input.actualUse.description : null, timestamp, timestamp, claim.id),
        database.prepare("UPDATE health_record_idempotency SET state = 'completed', response = ?, completed_at = ? WHERE id = ? AND state = 'pending'")
          .bind(JSON.stringify(value), timestamp, claim.id),
      ]);
      if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
        throw new HealthRecordError(409, "IDEMPOTENCY_LEASE_LOST", "保存请求已失效，请重试");
      }
      return { value, replayed: false };
    } catch (error) {
      await this.releaseIdempotency(database, claim.id);
      throw error;
    }
  }

  async updateMedication(userId: string, id: string, expectedVersion: number, input: MedicationInput) {
    const database = await this.getDatabase();
    const current = await this.medication(database, userId, id);
    const timestamp = now();
    const result = await database.prepare("UPDATE medication_records SET taken_at = ?, medication_name = ?, dosage_status = ?, dosage_value = ?, dosage_unit = ?, actual_use_status = ?, actual_use_description = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?")
      .bind(input.takenAt, input.medicationName, input.dosage.status, input.dosage.status === "known" ? input.dosage.value : null, input.dosage.status === "known" ? input.dosage.unit : null, input.actualUse.status, input.actualUse.status === "known" ? input.actualUse.description : null, timestamp, id, userId, expectedVersion).run();
    if (result.meta.changes === 0) throw new HealthRecordError(409, "VERSION_CONFLICT", "用药记录已被更新，请刷新后重试");
    return mapMedication({ ...current, taken_at: input.takenAt, medication_name: input.medicationName, dosage_status: input.dosage.status, dosage_value: input.dosage.status === "known" ? input.dosage.value : null, dosage_unit: input.dosage.status === "known" ? input.dosage.unit : null, actual_use_status: input.actualUse.status, actual_use_description: input.actualUse.status === "known" ? input.actualUse.description : null, version: expectedVersion + 1, updated_at: timestamp });
  }

  async deleteMedication(userId: string, id: string, expectedVersion: number) {
    const database = await this.getDatabase();
    await this.medication(database, userId, id);
    const result = await database.prepare("DELETE FROM medication_records WHERE id = ? AND user_id = ? AND version = ?").bind(id, userId, expectedVersion).run();
    if (result.meta.changes === 0) throw new HealthRecordError(409, "VERSION_CONFLICT", "用药记录已被更新，请刷新后重试");
  }

  async listSymptoms(userId: string, date: string | null) {
    const database = await this.getDatabase();
    const query = date
      ? database.prepare("SELECT id, symptom_date, sneezing, rhinorrhea, congestion, itching, total_score, version, created_at, updated_at FROM symptom_records WHERE user_id = ? AND symptom_date = ? ORDER BY symptom_date DESC, id DESC").bind(userId, date)
      : database.prepare("SELECT id, symptom_date, sneezing, rhinorrhea, congestion, itching, total_score, version, created_at, updated_at FROM symptom_records WHERE user_id = ? ORDER BY symptom_date DESC, id DESC").bind(userId);
    const rows = await query.all<SymptomRow>();
    return rows.results.map(mapSymptom);
  }

  async saveSymptom(userId: string, date: string, expectedVersion: number, input: SymptomRecordInput, idempotencyKey?: string, requestHash?: string) {
    const database = await this.getDatabase();
    const timestamp = now();
    const id = `symptom_${crypto.randomUUID()}`;
    const totalScore = Object.values(input.scores).reduce((sum, item) => sum + item, 0);
    let currentId = id;
    let createdAt = timestamp;
    const claim = expectedVersion === 0 && idempotencyKey && requestHash
      ? await this.claimIdempotency<SymptomRecord>(database, userId, `symptom:${date}`, idempotencyKey, requestHash)
      : null;
    if (claim?.replay) return claim.replay;
    try {
      if (expectedVersion === 0) {
        const existing = await database.prepare("SELECT id, symptom_date, sneezing, rhinorrhea, congestion, itching, total_score, version, created_at, updated_at FROM symptom_records WHERE user_id = ? AND symptom_date = ?").bind(userId, date).first<SymptomRow>();
        if (existing) {
          if (claim) await this.releaseIdempotency(database, claim.id);
          throw new HealthRecordError(409, "VERSION_CONFLICT", "症状记录已存在，请使用 If-Match 更新现有记录");
        }
        if (claim) {
          const results = await database.batch([
            database.prepare("INSERT OR IGNORE INTO symptom_records (id, user_id, symptom_date, sneezing, rhinorrhea, congestion, itching, total_score, version, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM health_record_idempotency WHERE id = ? AND state = 'pending')")
              .bind(id, userId, date, input.scores.sneezing, input.scores.rhinorrhea, input.scores.congestion, input.scores.itching, totalScore, timestamp, timestamp, claim.id),
            database.prepare("UPDATE health_record_idempotency SET state = 'completed', response = ?, completed_at = ? WHERE id = ? AND state = 'pending' AND EXISTS (SELECT 1 FROM symptom_records WHERE id = ? AND user_id = ? AND symptom_date = ?)")
              .bind(JSON.stringify(mapSymptom({ id, symptom_date: date, sneezing: input.scores.sneezing, rhinorrhea: input.scores.rhinorrhea, congestion: input.scores.congestion, itching: input.scores.itching, total_score: totalScore, version: 1, created_at: timestamp, updated_at: timestamp })), timestamp, claim.id, id, userId, date),
          ]);
          if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
            throw new HealthRecordError(409, "IDEMPOTENCY_LEASE_LOST", "保存请求已失效，请重试");
          }
        } else {
          const inserted = await database.prepare("INSERT OR IGNORE INTO symptom_records (id, user_id, symptom_date, sneezing, rhinorrhea, congestion, itching, total_score, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)")
            .bind(id, userId, date, input.scores.sneezing, input.scores.rhinorrhea, input.scores.congestion, input.scores.itching, totalScore, timestamp, timestamp).run();
          if (inserted.meta.changes === 0) throw new HealthRecordError(409, "VERSION_CONFLICT", "症状记录已存在，请刷新后重试");
        }
      } else {
        const current = await database.prepare("SELECT id, created_at FROM symptom_records WHERE user_id = ? AND symptom_date = ? AND version = ?").bind(userId, date, expectedVersion).first<{ id: string; created_at: string }>();
        if (!current) throw new HealthRecordError(409, "VERSION_CONFLICT", "症状记录已被更新，请刷新后重试");
        currentId = current.id;
        createdAt = current.created_at;
        const updated = await database.prepare("UPDATE symptom_records SET sneezing = ?, rhinorrhea = ?, congestion = ?, itching = ?, total_score = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND symptom_date = ? AND version = ?")
          .bind(input.scores.sneezing, input.scores.rhinorrhea, input.scores.congestion, input.scores.itching, totalScore, timestamp, userId, date, expectedVersion).run();
        if (updated.meta.changes === 0) throw new HealthRecordError(409, "VERSION_CONFLICT", "症状记录已被更新，请刷新后重试");
      }
      const value = mapSymptom({ id: currentId, symptom_date: date, sneezing: input.scores.sneezing, rhinorrhea: input.scores.rhinorrhea, congestion: input.scores.congestion, itching: input.scores.itching, total_score: totalScore, version: expectedVersion + 1, created_at: createdAt, updated_at: timestamp });
      if (claim && expectedVersion !== 0) {
        const completed = await database.prepare("UPDATE health_record_idempotency SET state = 'completed', response = ?, completed_at = ? WHERE id = ? AND state = 'pending'")
          .bind(JSON.stringify(value), timestamp, claim.id).run();
        if (completed.meta.changes !== 1) throw new HealthRecordError(409, "IDEMPOTENCY_LEASE_LOST", "保存请求已失效，请重试");
      }
      return value;
    } catch (error) {
      if (claim) await this.releaseIdempotency(database, claim.id);
      throw error;
    }
  }

  async listExposures(userId: string, date: string | null) {
    const database = await this.getDatabase();
    const query = date
      ? database.prepare("SELECT e.id, e.exposure_date, e.other_description, e.note, e.version, e.created_at, e.updated_at, s.group_code, s.option_code FROM allergen_exposure_records e LEFT JOIN allergen_exposure_selections s ON s.exposure_id = e.id WHERE e.user_id = ? AND e.exposure_date = ? ORDER BY e.created_at DESC, s.option_code").bind(userId, date)
      : database.prepare("SELECT e.id, e.exposure_date, e.other_description, e.note, e.version, e.created_at, e.updated_at, s.group_code, s.option_code FROM allergen_exposure_records e LEFT JOIN allergen_exposure_selections s ON s.exposure_id = e.id WHERE e.user_id = ? ORDER BY e.exposure_date DESC, e.created_at DESC, s.option_code").bind(userId);
    const rows = await query.all<ExposureWithSelectionRow>();
    const grouped = new Map<string, { row: ExposureRow; selections: SelectionRow[] }>();
    for (const row of rows.results) {
      const current = grouped.get(row.id) ?? { row, selections: [] };
      if (row.group_code && row.option_code) current.selections.push({ exposure_id: row.id, group_code: row.group_code, option_code: row.option_code });
      grouped.set(row.id, current);
    }
    return [...grouped.values()].map(({ row, selections }) => mapExposure(row, selections));
  }

  async createExposure(userId: string, key: string, requestHash: string, input: ExposureInput) {
    const database = await this.getDatabase();
    const claim = await this.claimIdempotency<ExposureRecord>(database, userId, "exposure", key, requestHash);
    if (claim.replay) return { value: claim.replay, replayed: true };
    const id = `exposure_${crypto.randomUUID()}`;
    const timestamp = now();
    const value: ExposureRecord = { id, ...input, version: 1, createdAt: timestamp, updatedAt: timestamp };
    try {
      const existing = await database.prepare("SELECT id FROM allergen_exposure_records WHERE user_id = ? AND exposure_date = ?").bind(userId, input.date).first<{ id: string }>();
      if (existing) throw exposureDateConflict();
      const results = await database.batch([
        database.prepare("INSERT INTO allergen_exposure_records (id, user_id, exposure_date, other_description, note, mutation_id, version, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM health_record_idempotency WHERE id = ? AND state = 'pending')")
          .bind(id, userId, input.date, input.otherDescription, input.note, `mutation_${crypto.randomUUID()}`, timestamp, timestamp, claim.id),
        ...input.selections.map((selection) => database.prepare("INSERT INTO allergen_exposure_selections (exposure_id, group_code, option_code) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM health_record_idempotency WHERE id = ? AND state = 'pending')").bind(id, selection.group, selection.code, claim.id)),
        database.prepare("UPDATE health_record_idempotency SET state = 'completed', response = ?, completed_at = ? WHERE id = ? AND state = 'pending'")
          .bind(JSON.stringify(value), timestamp, claim.id),
      ]);
      const selectionResults = results.slice(1, -1);
      if (results[0].meta.changes !== 1 || selectionResults.some((result) => result.meta.changes !== 1) || results.at(-1)?.meta.changes !== 1) {
        throw new HealthRecordError(409, "IDEMPOTENCY_LEASE_LOST", "保存请求已失效，请重试");
      }
      return { value, replayed: false };
    } catch (error) {
      await this.releaseIdempotency(database, claim.id);
      if (isExposureDateConflict(error)) throw exposureDateConflict();
      throw error;
    }
  }

  async updateExposure(userId: string, id: string, expectedVersion: number, input: ExposureInput) {
    const database = await this.getDatabase();
    const current = await this.exposure(database, userId, id);
    const duplicate = await database.prepare("SELECT id FROM allergen_exposure_records WHERE user_id = ? AND exposure_date = ? AND id <> ?").bind(userId, input.date, id).first<{ id: string }>();
    if (duplicate) throw exposureDateConflict();
    const timestamp = now();
    const mutationId = `mutation_${crypto.randomUUID()}`;
    const statements = [
      database.prepare("UPDATE allergen_exposure_records SET exposure_date = ?, other_description = ?, note = ?, mutation_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?")
        .bind(input.date, input.otherDescription, input.note, mutationId, timestamp, id, userId, expectedVersion),
      database.prepare("DELETE FROM allergen_exposure_selections WHERE exposure_id = ? AND EXISTS (SELECT 1 FROM allergen_exposure_records WHERE id = ? AND user_id = ? AND mutation_id = ?)")
        .bind(id, id, userId, mutationId),
      ...input.selections.map((selection) => database.prepare("INSERT INTO allergen_exposure_selections (exposure_id, group_code, option_code) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM allergen_exposure_records WHERE id = ? AND user_id = ? AND mutation_id = ?)")
        .bind(id, selection.group, selection.code, id, userId, mutationId)),
    ];
    let results: Array<{ meta: { changes: number } }>;
    try {
      results = await database.batch(statements);
    } catch (error) {
      if (isExposureDateConflict(error)) throw exposureDateConflict();
      throw error;
    }
    if (results[0].meta.changes === 0) throw new HealthRecordError(409, "VERSION_CONFLICT", "过敏原暴露记录已被更新，请刷新后重试");
    return { id, ...input, version: expectedVersion + 1, createdAt: current.created_at, updatedAt: timestamp };
  }

  async deleteExposure(userId: string, id: string, expectedVersion: number) {
    const database = await this.getDatabase();
    await this.exposure(database, userId, id);
    const result = await database.prepare("DELETE FROM allergen_exposure_records WHERE id = ? AND user_id = ? AND version = ?").bind(id, userId, expectedVersion).run();
    if (result.meta.changes === 0) throw new HealthRecordError(409, "VERSION_CONFLICT", "过敏原暴露记录已被更新，请刷新后重试");
  }

  async listTriggerProjection(userId: string) {
    const rows = await (await this.getDatabase()).prepare("SELECT e.id exposure_id, e.exposure_date, e.other_description, s.group_code, s.option_code FROM allergen_exposure_records e JOIN allergen_exposure_selections s ON s.exposure_id = e.id WHERE e.user_id = ? ORDER BY e.exposure_date DESC, e.id")
      .bind(userId).all<SelectionRow & { exposure_id: string; exposure_date: string; other_description: string | null }>();
    return this.projectTriggerRows(rows.results);
  }

  private projectTriggerRows(rows: TriggerRow[]) {
    const projected = new Map<string, TriggerProjection>();
    for (const row of rows) {
      if (row.option_code === "none_identified") continue;
      const option = allergenOption(row.option_code);
      if (!option) continue;
      const label = row.option_code === "other" ? row.other_description ?? option.label : option.label;
      const key = row.option_code === "other" ? `${row.option_code}:${label}` : row.option_code;
      const current = projected.get(key);
      if (current) {
        current.occurrenceCount += 1;
        current.sourceRecordIds.push(row.exposure_id);
      } else {
        projected.set(key, { code: row.option_code, label, group: row.group_code, latestDate: row.exposure_date, occurrenceCount: 1, source: "patient_reported_exposure", sourceRecordIds: [row.exposure_id] });
      }
    }
    return [...projected.values()];
  }

  private async medication(database: D1Database, userId: string, id: string) {
    const row = await database.prepare("SELECT id, taken_at, medication_name, dosage_status, dosage_value, dosage_unit, actual_use_status, actual_use_description, version, created_at, updated_at FROM medication_records WHERE id = ? AND user_id = ?").bind(id, userId).first<MedicationRow>();
    if (!row) throw new HealthRecordError(404, "NOT_FOUND", "用药记录不存在");
    return row;
  }

  private async exposure(database: D1Database, userId: string, id: string) {
    const row = await database.prepare("SELECT id, exposure_date, other_description, note, version, created_at, updated_at FROM allergen_exposure_records WHERE id = ? AND user_id = ?").bind(id, userId).first<ExposureRow>();
    if (!row) throw new HealthRecordError(404, "NOT_FOUND", "过敏原暴露记录不存在");
    return row;
  }

  private async claimIdempotency<T>(database: D1Database, userId: string, scope: string, key: string, requestHash: string): Promise<{ id: string; replay?: T }> {
    const existing = await database.prepare("SELECT id, request_hash, state, response, created_at FROM health_record_idempotency WHERE user_id = ? AND scope = ? AND key = ?")
      .bind(userId, scope, key).first<{ id: string; request_hash: string; state: "pending" | "completed"; response: string | null; created_at: string }>();
    const staleBefore = new Date(Date.now() - IDEMPOTENCY_LEASE_MS).toISOString();
    if (existing?.state === "pending" && existing.created_at < staleBefore) {
      const recovered = await database.prepare("DELETE FROM health_record_idempotency WHERE id = ? AND state = 'pending' AND created_at < ?")
        .bind(existing.id, staleBefore).run();
      if (recovered.meta.changes > 0) return this.claimIdempotency(database, userId, scope, key, requestHash);
    }
    if (existing) return this.resolveIdempotency<T>(existing, requestHash);
    const id = `idem_${crypto.randomUUID()}`;
    const claim = await database.prepare("INSERT OR IGNORE INTO health_record_idempotency (id, user_id, scope, key, request_hash, state, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
      .bind(id, userId, scope, key, requestHash, now()).run();
    if (claim.meta.changes > 0) return { id };
    const raced = await database.prepare("SELECT id, request_hash, state, response, created_at FROM health_record_idempotency WHERE user_id = ? AND scope = ? AND key = ?")
      .bind(userId, scope, key).first<{ id: string; request_hash: string; state: "pending" | "completed"; response: string | null; created_at: string }>();
    if (!raced) throw new HealthRecordError(409, "REQUEST_IN_PROGRESS", "相同请求正在处理中");
    if (raced.state === "pending" && raced.created_at < staleBefore) {
      const recovered = await database.prepare("DELETE FROM health_record_idempotency WHERE id = ? AND state = 'pending' AND created_at < ?")
        .bind(raced.id, staleBefore).run();
      if (recovered.meta.changes > 0) return this.claimIdempotency(database, userId, scope, key, requestHash);
    }
    return this.resolveIdempotency<T>(raced, requestHash);
  }

  private resolveIdempotency<T>(existing: { id: string; request_hash: string; state: "pending" | "completed"; response: string | null }, requestHash: string) {
    if (existing.request_hash !== requestHash) throw new HealthRecordError(409, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同请求");
    if (existing.state !== "completed" || !existing.response) throw new HealthRecordError(409, "REQUEST_IN_PROGRESS", "相同请求正在处理中");
    return { id: existing.id, replay: JSON.parse(existing.response) as T };
  }

  private async releaseIdempotency(database: D1Database, id: string) {
    await database.prepare("DELETE FROM health_record_idempotency WHERE id = ? AND state = 'pending'").bind(id).run();
  }
}

export function createRuntimeHealthRecordsRepository() {
  return new D1HealthRecordsRepository(async () => {
    const { env } = await import("cloudflare:workers");
    const database = (env as unknown as { DB?: D1Database }).DB;
    if (!database) throw new HealthRecordError(503, "DATABASE_NOT_CONFIGURED", "健康记录数据库尚未配置");
    return database;
  });
}
