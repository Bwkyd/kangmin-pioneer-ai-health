import { createHash, randomUUID } from "node:crypto";

import { DomainError } from "../../kernel/errors.js";
import type {
  CalendarProjection,
  CreateExposureInput,
  CreateMedicationInput,
  CreateSymptomInput,
  DeleteRecordInput,
  ExposureRecord,
  HealthProfile,
  MedicationRecord,
  OverviewData,
  SymptomRecord,
  TrendProjection,
  UpdateExposureInput,
  UpdateMedicationInput,
  UpdateProfileInput,
  UpdateSymptomInput
} from "./contracts.js";
import { validateFactors } from "./domain.js";
import type {
  DeleteRecordOutcome,
  RecordRepository
} from "./record-repository.js";

function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function now(): string {
  return new Date().toISOString();
}

/** 截至最近一条记录日期的连续记录天数；无记录返回 0。 */
function consecutiveDayCount(dates: readonly string[]): number {
  if (dates.length === 0) {
    return 0;
  }
  let count = 1;
  for (let index = 1; index < dates.length; index += 1) {
    const previous = Date.parse(`${dates[index - 1]}T00:00:00Z`);
    const current = Date.parse(`${dates[index]}T00:00:00Z`);
    if (
      Number.isFinite(previous) &&
      Number.isFinite(current) &&
      previous - current === 86_400_000
    ) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
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
    const timestamp = now();
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
      createdAt: timestamp,
      updatedAt: timestamp
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
      updatedAt: now()
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

  async deleteSymptom(
    patientId: string,
    input: DeleteRecordInput
  ): Promise<void> {
    await this.runDelete(
      patientId,
      input,
      (id, expectedRevision) =>
        this.repository.deleteSymptom(patientId, id, expectedRevision)
    );
  }

  async getProfile(patientId: string): Promise<HealthProfile> {
    const profile = await this.repository.getProfile(patientId);
    if (profile === null) {
      return {
        displayName: null,
        birthDate: null,
        sex: "unspecified",
        allergyHistory: null,
        knownAllergies: null,
        commonTriggers: null,
        notes: null,
        revision: 0,
        createdAt: null,
        updatedAt: null
      };
    }
    return profile;
  }

  async updateProfile(
    patientId: string,
    input: UpdateProfileInput
  ): Promise<HealthProfile> {
    const current = await this.repository.getProfile(patientId);
    const outcome = await this.repository.updateProfile({
      patientId,
      expectedRevision: input.expectedRevision,
      displayName: input.displayName ?? current?.displayName ?? null,
      birthDate: input.birthDate ?? current?.birthDate ?? null,
      sex: input.sex ?? current?.sex ?? "unspecified",
      allergyHistory: input.allergyHistory ?? current?.allergyHistory ?? null,
      knownAllergies: input.knownAllergies ?? current?.knownAllergies ?? null,
      commonTriggers: input.commonTriggers ?? current?.commonTriggers ?? null,
      notes: input.notes ?? current?.notes ?? null,
      updatedAt: now()
    });
    if (outcome.kind === "version_conflict") {
      throw new DomainError(
        "version_conflict",
        "档案已更新，请重新读取后再修改",
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

  async createExposure(
    patientId: string,
    input: CreateExposureInput
  ): Promise<ExposureRecord> {
    validateFactors(input.factors, input.otherDescription);
    const requestHash = stableHash({
      localDate: input.localDate,
      factors: input.factors,
      otherDescription: input.otherDescription,
      notes: input.notes
    });
    const timestamp = now();
    const record: ExposureRecord = {
      id: randomUUID(),
      localDate: input.localDate,
      factors: [...input.factors],
      otherDescription: input.otherDescription,
      notes: input.notes,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const outcome = await this.repository.createExposure({
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
        "该日期已存在暴露记录，请先读取后更新"
      );
    }
    return outcome.record;
  }

  async listExposures(patientId: string): Promise<ExposureRecord[]> {
    return this.repository.listExposures(patientId);
  }

  async getExposure(
    patientId: string,
    id: string
  ): Promise<ExposureRecord> {
    const record = await this.repository.findExposure(patientId, id);
    if (record === null) {
      throw new DomainError("resource_not_found", "暴露记录不存在");
    }
    return record;
  }

  async updateExposure(
    patientId: string,
    input: UpdateExposureInput
  ): Promise<ExposureRecord> {
    const current = await this.repository.findExposure(patientId, input.id);
    if (current === null) {
      throw new DomainError("resource_not_found", "暴露记录不存在");
    }

    const factors = input.factors ?? current.factors;
    const otherDescription =
      input.otherDescription === undefined
        ? current.otherDescription
        : input.otherDescription;
    const notes = input.notes === undefined ? current.notes : input.notes;

    if (
      input.factors === undefined &&
      input.otherDescription === undefined &&
      input.notes === undefined
    ) {
      throw new DomainError(
        "validation_failed",
        "至少提供一个需要更新的字段"
      );
    }
    validateFactors(factors, otherDescription);

    const outcome = await this.repository.updateExposure({
      patientId,
      id: input.id,
      expectedRevision: input.expectedRevision,
      factors,
      otherDescription,
      notes,
      updatedAt: now()
    });
    if (outcome.kind === "not_found") {
      throw new DomainError("resource_not_found", "暴露记录不存在");
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

  async deleteExposure(
    patientId: string,
    input: DeleteRecordInput
  ): Promise<void> {
    await this.runDelete(
      patientId,
      input,
      (id, expectedRevision) =>
        this.repository.deleteExposure(patientId, id, expectedRevision)
    );
  }

  async createMedication(
    patientId: string,
    input: CreateMedicationInput
  ): Promise<MedicationRecord> {
    const requestHash = stableHash({
      localDate: input.localDate,
      medicationName: input.medicationName,
      dosage: input.dosage,
      actualUse: input.actualUse,
      notes: input.notes
    });
    const timestamp = now();
    const record: MedicationRecord = {
      id: randomUUID(),
      localDate: input.localDate,
      medicationName: input.medicationName,
      dosage: input.dosage,
      actualUse: input.actualUse,
      notes: input.notes,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const outcome = await this.repository.createMedication({
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
    return outcome.record;
  }

  async listMedications(patientId: string): Promise<MedicationRecord[]> {
    return this.repository.listMedications(patientId);
  }

  async getMedication(
    patientId: string,
    id: string
  ): Promise<MedicationRecord> {
    const record = await this.repository.findMedication(patientId, id);
    if (record === null) {
      throw new DomainError("resource_not_found", "用药记录不存在");
    }
    return record;
  }

  async updateMedication(
    patientId: string,
    input: UpdateMedicationInput
  ): Promise<MedicationRecord> {
    const current = await this.repository.findMedication(patientId, input.id);
    if (current === null) {
      throw new DomainError("resource_not_found", "用药记录不存在");
    }

    const medicationName = input.medicationName ?? current.medicationName;
    const dosage = input.dosage === undefined ? current.dosage : input.dosage;
    const actualUse =
      input.actualUse === undefined ? current.actualUse : input.actualUse;
    const notes = input.notes === undefined ? current.notes : input.notes;

    if (
      input.medicationName === undefined &&
      input.dosage === undefined &&
      input.actualUse === undefined &&
      input.notes === undefined
    ) {
      throw new DomainError(
        "validation_failed",
        "至少提供一个需要更新的字段"
      );
    }

    const outcome = await this.repository.updateMedication({
      patientId,
      id: input.id,
      expectedRevision: input.expectedRevision,
      medicationName,
      dosage,
      actualUse,
      notes,
      updatedAt: now()
    });
    if (outcome.kind === "not_found") {
      throw new DomainError("resource_not_found", "用药记录不存在");
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

  async deleteMedication(
    patientId: string,
    input: DeleteRecordInput
  ): Promise<void> {
    await this.runDelete(
      patientId,
      input,
      (id, expectedRevision) =>
        this.repository.deleteMedication(patientId, id, expectedRevision)
    );
  }

  async getOverview(patientId: string, today: string): Promise<OverviewData> {
    const source = await this.repository.readOverview(
      patientId,
      today.slice(0, 7)
    );
    return {
      recentSymptomDate: source.symptomDates[0] ?? null,
      monthRecordCount: source.monthRecordCount,
      consecutiveDays: consecutiveDayCount(source.symptomDates),
      lastTnss: source.lastTnss,
      recentExposureDate: source.latestExposureDate,
      recentMedicationDate: source.latestMedicationDate,
      dataRead: "ok"
    };
  }

  async getCalendar(
    patientId: string,
    month: string
  ): Promise<CalendarProjection> {
    const monthStart = `${month}-01`;
    const monthEnd = `${month}-31`;
    const source = await this.repository.readMonth(
      patientId,
      monthStart,
      monthEnd
    );

    const exposureDates = new Set(source.exposureDates);
    const medicationDates = new Set(source.medicationDates);
    const days = new Map<string, {
      localDate: string;
      symptomId: string | null;
      tnssTotal: number | null;
      hasExposure: boolean;
      hasMedication: boolean;
    }>();

    for (const symptom of source.symptoms) {
      days.set(symptom.localDate, {
        localDate: symptom.localDate,
        symptomId: symptom.id,
        tnssTotal: symptom.tnssTotal,
        hasExposure: exposureDates.has(symptom.localDate),
        hasMedication: medicationDates.has(symptom.localDate)
      });
    }
    for (const date of source.exposureDates) {
      const existing = days.get(date);
      days.set(date, {
        localDate: date,
        symptomId: existing?.symptomId ?? null,
        tnssTotal: existing?.tnssTotal ?? null,
        hasExposure: true,
        hasMedication: existing?.hasMedication ?? medicationDates.has(date)
      });
    }
    for (const date of source.medicationDates) {
      const existing = days.get(date);
      days.set(date, {
        localDate: date,
        symptomId: existing?.symptomId ?? null,
        tnssTotal: existing?.tnssTotal ?? null,
        hasExposure: existing?.hasExposure ?? exposureDates.has(date),
        hasMedication: true
      });
    }

    return {
      month,
      days: [...days.values()].sort((left, right) =>
        left.localDate.localeCompare(right.localDate)
      )
    };
  }

  async getTrend(
    patientId: string,
    from: string,
    to: string
  ): Promise<TrendProjection> {
    const source = await this.repository.readTrend(patientId, from, to);
    return {
      from,
      to,
      items: source.items.map((item) => ({
        localDate: item.localDate,
        symptomId: item.id,
        tnssTotal: item.tnssTotal
      }))
    };
  }

  private async runDelete(
    patientId: string,
    input: DeleteRecordInput,
    deleteRecord: (
      id: string,
      expectedRevision: number
    ) => Promise<DeleteRecordOutcome>
  ): Promise<void> {
    const outcome = await deleteRecord(input.id, input.expectedRevision);
    if (outcome.kind === "not_found") {
      throw new DomainError("resource_not_found", "记录不存在");
    }
    if (outcome.kind === "version_conflict") {
      throw new DomainError(
        "version_conflict",
        "记录已更新，请重新读取后再删除",
        {
          details: {
            expectedRevision: input.expectedRevision,
            currentRevision: outcome.currentRevision
          }
        }
      );
    }
  }
}
