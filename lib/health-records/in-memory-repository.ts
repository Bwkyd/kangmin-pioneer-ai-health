import {
  HealthRecordError,
  allergenOption,
  type ExposureInput,
  type ExposureRecord,
  type HealthProfile,
  type HealthProfileInput,
  type IdempotentCreate,
  type MedicationInput,
  type MedicationRecord,
  type SymptomRecord,
  type SymptomRecordInput,
  type TriggerProjection,
} from "./domain.ts";
import type { HealthRecordsRepository } from "./repository.ts";

type Owned<T> = T & { userId: string };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function timestamp() {
  return new Date().toISOString();
}

function withoutOwner<T>(value: Owned<T>): T {
  const copied = clone(value) as Owned<T> & { userId?: string };
  delete copied.userId;
  return copied;
}

export class InMemoryHealthRecordsRepository implements HealthRecordsRepository {
  private profiles = new Map<string, HealthProfile>();
  private medications = new Map<string, Owned<MedicationRecord>>();
  private symptoms = new Map<string, Owned<SymptomRecord>>();
  private exposures = new Map<string, Owned<ExposureRecord>>();
  private idempotency = new Map<string, { requestHash: string; response: unknown }>();

  async getProfile(userId: string) {
    const value = this.profiles.get(userId);
    return value ? clone(value) : null;
  }

  async getProfileSnapshot(userId: string) {
    return { profile: await this.getProfile(userId), triggers: await this.listTriggerProjection(userId) };
  }

  async saveProfile(userId: string, expectedVersion: number, input: HealthProfileInput) {
    const current = this.profiles.get(userId);
    if (!current && expectedVersion !== 0) throw new HealthRecordError(404, "NOT_FOUND", "健康档案不存在");
    if ((current?.version ?? 0) !== expectedVersion) throw new HealthRecordError(409, "VERSION_CONFLICT", "健康档案已被更新，请刷新后重试");
    const now = timestamp();
    const value: HealthProfile = {
      ...clone(input),
      version: expectedVersion + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.profiles.set(userId, value);
    return clone(value);
  }

  async listMedications(userId: string) {
    return [...this.medications.values()]
      .filter((item) => item.userId === userId)
      .sort((left, right) => right.takenAt.localeCompare(left.takenAt) || right.id.localeCompare(left.id))
      .map(withoutOwner);
  }

  async createMedication(userId: string, key: string, requestHash: string, input: MedicationInput) {
    return this.createIdempotent(userId, "medication", key, requestHash, () => {
      const now = timestamp();
      const value: MedicationRecord = {
        id: `med_${crypto.randomUUID()}`,
        ...clone(input),
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.medications.set(value.id, { ...value, userId });
      return value;
    });
  }

  async updateMedication(userId: string, id: string, expectedVersion: number, input: MedicationInput) {
    const current = this.owned(this.medications, userId, id, "用药记录");
    if (current.version !== expectedVersion) throw new HealthRecordError(409, "VERSION_CONFLICT", "用药记录已被更新，请刷新后重试");
    const value: MedicationRecord = { ...clone(input), id, version: current.version + 1, createdAt: current.createdAt, updatedAt: timestamp() };
    this.medications.set(id, { ...value, userId });
    return clone(value);
  }

  async deleteMedication(userId: string, id: string, expectedVersion: number) {
    const current = this.owned(this.medications, userId, id, "用药记录");
    if (current.version !== expectedVersion) throw new HealthRecordError(409, "VERSION_CONFLICT", "用药记录已被更新，请刷新后重试");
    this.medications.delete(id);
  }

  async listSymptoms(userId: string, date: string | null) {
    return [...this.symptoms.values()]
      .filter((item) => item.userId === userId && (date === null || item.date === date))
      .sort((left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id))
      .map(withoutOwner);
  }

  async saveSymptom(userId: string, date: string, expectedVersion: number, input: SymptomRecordInput, idempotencyKey?: string, requestHash?: string) {
    const key = `${userId}\u0000${date}`;
    const current = this.symptoms.get(key);
    const idempotencyMapKey = idempotencyKey && requestHash ? `${userId}\u0000symptom:${date}\u0000${idempotencyKey}` : null;
    if (idempotencyMapKey) {
      const replay = this.idempotency.get(idempotencyMapKey);
      if (replay) {
        if (replay.requestHash !== requestHash) throw new HealthRecordError(409, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同请求");
        return clone(replay.response as SymptomRecord);
      }
    }
    if (current && expectedVersion === 0) throw new HealthRecordError(409, "VERSION_CONFLICT", "症状记录已存在，请使用 If-Match 更新现有记录");
    if (!current && expectedVersion !== 0) throw new HealthRecordError(404, "NOT_FOUND", "症状记录不存在");
    if ((current?.version ?? 0) !== expectedVersion) throw new HealthRecordError(409, "VERSION_CONFLICT", "症状记录已被更新，请刷新后重试");
    const now = timestamp();
    const value: SymptomRecord = {
      id: current?.id ?? `symptom_${crypto.randomUUID()}`,
      date,
      scores: clone(input.scores),
      totalScore: Object.values(input.scores).reduce((sum, item) => sum + item, 0),
      version: expectedVersion + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.symptoms.set(key, { ...value, userId });
    if (idempotencyMapKey) this.idempotency.set(idempotencyMapKey, { requestHash: requestHash!, response: clone(value) });
    return clone(value);
  }

  async listExposures(userId: string, date: string | null) {
    return [...this.exposures.values()]
      .filter((item) => item.userId === userId && (date === null || item.date === date))
      .sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt))
      .map(withoutOwner);
  }

  async createExposure(userId: string, key: string, requestHash: string, input: ExposureInput) {
    return this.createIdempotent(userId, "exposure", key, requestHash, () => {
      if ([...this.exposures.values()].some((item) => item.userId === userId && item.date === input.date)) {
        throw new HealthRecordError(409, "DATE_CONFLICT", "同一天已有过敏原患者自述记录，请编辑原记录或更换日期");
      }
      const now = timestamp();
      const value: ExposureRecord = {
        id: `exposure_${crypto.randomUUID()}`,
        ...clone(input),
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.exposures.set(value.id, { ...value, userId });
      return value;
    });
  }

  async updateExposure(userId: string, id: string, expectedVersion: number, input: ExposureInput) {
    const current = this.owned(this.exposures, userId, id, "过敏原暴露记录");
    if (current.version !== expectedVersion) throw new HealthRecordError(409, "VERSION_CONFLICT", "过敏原暴露记录已被更新，请刷新后重试");
    if ([...this.exposures.values()].some((item) => item.userId === userId && item.id !== id && item.date === input.date)) {
      throw new HealthRecordError(409, "DATE_CONFLICT", "同一天已有过敏原患者自述记录，请编辑原记录或更换日期");
    }
    const value: ExposureRecord = { ...clone(input), id, version: current.version + 1, createdAt: current.createdAt, updatedAt: timestamp() };
    this.exposures.set(id, { ...value, userId });
    return clone(value);
  }

  async deleteExposure(userId: string, id: string, expectedVersion: number) {
    const current = this.owned(this.exposures, userId, id, "过敏原暴露记录");
    if (current.version !== expectedVersion) throw new HealthRecordError(409, "VERSION_CONFLICT", "过敏原暴露记录已被更新，请刷新后重试");
    this.exposures.delete(id);
  }

  async listTriggerProjection(userId: string) {
    const projected = new Map<string, TriggerProjection>();
    for (const exposure of this.exposures.values()) {
      if (exposure.userId !== userId) continue;
      for (const selection of exposure.selections) {
        if (selection.code === "none_identified") continue;
        const option = allergenOption(selection.code);
        if (!option) continue;
        const label = selection.code === "other" ? exposure.otherDescription ?? option.label : option.label;
        const projectionKey = selection.code === "other" ? `${selection.code}:${label}` : selection.code;
        const current = projected.get(projectionKey);
        if (current) {
          current.occurrenceCount += 1;
          if (exposure.date > current.latestDate) current.latestDate = exposure.date;
          current.sourceRecordIds.push(exposure.id);
        } else {
          projected.set(projectionKey, {
            code: selection.code,
            label,
            group: selection.group,
            latestDate: exposure.date,
            occurrenceCount: 1,
            source: "patient_reported_exposure",
            sourceRecordIds: [exposure.id],
          });
        }
      }
    }
    return [...projected.values()].sort((left, right) => right.latestDate.localeCompare(left.latestDate) || left.label.localeCompare(right.label, "zh-CN"));
  }

  private owned<T extends { version: number }>(store: Map<string, Owned<T>>, userId: string, id: string, label: string) {
    const value = store.get(id);
    if (!value || value.userId !== userId) throw new HealthRecordError(404, "NOT_FOUND", `${label}不存在`);
    return value;
  }

  private async createIdempotent<T>(
    userId: string,
    scope: string,
    key: string,
    requestHash: string,
    create: () => T,
  ): Promise<IdempotentCreate<T>> {
    const mapKey = `${userId}\u0000${scope}\u0000${key}`;
    const existing = this.idempotency.get(mapKey);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new HealthRecordError(409, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同请求");
      return { value: clone(existing.response as T), replayed: true };
    }
    const value = create();
    this.idempotency.set(mapKey, { requestHash, response: clone(value) });
    return { value: clone(value), replayed: false };
  }
}
