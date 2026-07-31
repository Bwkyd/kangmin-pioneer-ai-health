import type {
  ExposureRecord,
  HealthProfile,
  MedicationRecord,
  SymptomRecord
} from "./contracts.js";
import type { Sex } from "./domain.js";

export interface CreateSymptomRecordInput {
  patientId: string;
  idempotencyKey: string;
  requestHash: string;
  record: SymptomRecord;
}

export type CreateSymptomRecordOutcome =
  | { kind: "created"; record: SymptomRecord }
  | { kind: "replayed"; record: SymptomRecord }
  | { kind: "idempotency_conflict" }
  | { kind: "stale_replay" }
  | { kind: "date_conflict" };

export interface UpdateSymptomRecordInput {
  patientId: string;
  id: string;
  expectedRevision: number;
  nasalCongestion: number;
  nasalItching: number;
  sneezing: number;
  runnyNose: number;
  tnssTotal: number;
  notes: string | null;
  updatedAt: string;
}

export type UpdateSymptomRecordOutcome =
  | { kind: "updated"; record: SymptomRecord }
  | { kind: "not_found" }
  | { kind: "version_conflict"; currentRevision: number };

export type DeleteRecordOutcome =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "version_conflict"; currentRevision: number };

export interface UpdateProfileRecordInput {
  patientId: string;
  expectedRevision: number;
  displayName: string | null;
  birthDate: string | null;
  sex: Sex;
  allergyHistory: string | null;
  knownAllergies: string | null;
  commonTriggers: string | null;
  notes: string | null;
  updatedAt: string;
}

export type UpdateProfileRecordOutcome =
  | { kind: "created"; record: HealthProfile }
  | { kind: "updated"; record: HealthProfile }
  | { kind: "version_conflict"; currentRevision: number };

export interface CreateExposureRecordInput {
  patientId: string;
  idempotencyKey: string;
  requestHash: string;
  record: ExposureRecord;
}

export type CreateExposureRecordOutcome =
  | { kind: "created"; record: ExposureRecord }
  | { kind: "replayed"; record: ExposureRecord }
  | { kind: "idempotency_conflict" }
  | { kind: "stale_replay" }
  | { kind: "date_conflict" };

export interface UpdateExposureRecordInput {
  patientId: string;
  id: string;
  expectedRevision: number;
  factors: string[];
  otherDescription: string | null;
  notes: string | null;
  updatedAt: string;
}

export type UpdateExposureRecordOutcome =
  | { kind: "updated"; record: ExposureRecord }
  | { kind: "not_found" }
  | { kind: "version_conflict"; currentRevision: number };

export interface CreateMedicationRecordInput {
  patientId: string;
  idempotencyKey: string;
  requestHash: string;
  record: MedicationRecord;
}

export type CreateMedicationRecordOutcome =
  | { kind: "created"; record: MedicationRecord }
  | { kind: "replayed"; record: MedicationRecord }
  | { kind: "idempotency_conflict" }
  | { kind: "stale_replay" };

export interface UpdateMedicationRecordInput {
  patientId: string;
  id: string;
  expectedRevision: number;
  medicationName: string;
  dosage: string | null;
  actualUse: string | null;
  notes: string | null;
  updatedAt: string;
}

export type UpdateMedicationRecordOutcome =
  | { kind: "updated"; record: MedicationRecord }
  | { kind: "not_found" }
  | { kind: "version_conflict"; currentRevision: number };

export interface OverviewSourceData {
  /** 去重后的症状日期，按本地日期倒序。 */
  symptomDates: string[];
  /** 当前月症状记录条数（按本地月份前缀统计）。 */
  monthRecordCount: number;
  lastTnss: number | null;
  latestExposureDate: string | null;
  latestMedicationDate: string | null;
}

export interface MonthSymptomRow {
  id: string;
  localDate: string;
  tnssTotal: number;
}

export interface MonthSourceData {
  symptoms: MonthSymptomRow[];
  exposureDates: string[];
  medicationDates: string[];
}

export interface TrendSourceData {
  items: MonthSymptomRow[];
}

export interface RecordRepository {
  createSymptom(
    input: CreateSymptomRecordInput
  ): Promise<CreateSymptomRecordOutcome>;
  listSymptoms(patientId: string): Promise<SymptomRecord[]>;
  findSymptom(patientId: string, id: string): Promise<SymptomRecord | null>;
  updateSymptom(
    input: UpdateSymptomRecordInput
  ): Promise<UpdateSymptomRecordOutcome>;
  deleteSymptom(
    patientId: string,
    id: string,
    expectedRevision: number
  ): Promise<DeleteRecordOutcome>;

  getProfile(patientId: string): Promise<HealthProfile | null>;
  updateProfile(
    input: UpdateProfileRecordInput
  ): Promise<UpdateProfileRecordOutcome>;

  createExposure(
    input: CreateExposureRecordInput
  ): Promise<CreateExposureRecordOutcome>;
  listExposures(patientId: string): Promise<ExposureRecord[]>;
  findExposure(patientId: string, id: string): Promise<ExposureRecord | null>;
  updateExposure(
    input: UpdateExposureRecordInput
  ): Promise<UpdateExposureRecordOutcome>;
  deleteExposure(
    patientId: string,
    id: string,
    expectedRevision: number
  ): Promise<DeleteRecordOutcome>;

  createMedication(
    input: CreateMedicationRecordInput
  ): Promise<CreateMedicationRecordOutcome>;
  listMedications(patientId: string): Promise<MedicationRecord[]>;
  findMedication(
    patientId: string,
    id: string
  ): Promise<MedicationRecord | null>;
  updateMedication(
    input: UpdateMedicationRecordInput
  ): Promise<UpdateMedicationRecordOutcome>;
  deleteMedication(
    patientId: string,
    id: string,
    expectedRevision: number
  ): Promise<DeleteRecordOutcome>;

  readOverview(patientId: string, monthPrefix: string): Promise<OverviewSourceData>;
  readMonth(patientId: string, month: string): Promise<MonthSourceData>;
  readTrend(patientId: string, from: string, to: string): Promise<TrendSourceData>;
}
