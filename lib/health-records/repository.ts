import type {
  ExposureInput,
  ExposureRecord,
  HealthProfile,
  HealthProfileInput,
  IdempotentCreate,
  MedicationInput,
  MedicationRecord,
  SymptomRecord,
  SymptomRecordInput,
  TriggerProjection,
} from "./domain.ts";

export interface HealthRecordsRepository {
  getProfile(userId: string): Promise<HealthProfile | null>;
  saveProfile(userId: string, expectedVersion: number, input: HealthProfileInput): Promise<HealthProfile>;
  listMedications(userId: string): Promise<MedicationRecord[]>;
  createMedication(
    userId: string,
    idempotencyKey: string,
    requestHash: string,
    input: MedicationInput,
  ): Promise<IdempotentCreate<MedicationRecord>>;
  updateMedication(userId: string, id: string, expectedVersion: number, input: MedicationInput): Promise<MedicationRecord>;
  deleteMedication(userId: string, id: string, expectedVersion: number): Promise<void>;
  listSymptoms(userId: string, date: string | null): Promise<SymptomRecord[]>;
  saveSymptom(userId: string, date: string, expectedVersion: number, input: SymptomRecordInput): Promise<SymptomRecord>;
  listExposures(userId: string, date: string | null): Promise<ExposureRecord[]>;
  createExposure(
    userId: string,
    idempotencyKey: string,
    requestHash: string,
    input: ExposureInput,
  ): Promise<IdempotentCreate<ExposureRecord>>;
  updateExposure(userId: string, id: string, expectedVersion: number, input: ExposureInput): Promise<ExposureRecord>;
  deleteExposure(userId: string, id: string, expectedVersion: number): Promise<void>;
  listTriggerProjection(userId: string): Promise<TriggerProjection[]>;
}
