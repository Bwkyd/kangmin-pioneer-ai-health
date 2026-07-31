import type { SymptomRecord } from "./contracts.js";

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

export interface RecordRepository {
  createSymptom(
    input: CreateSymptomRecordInput
  ): Promise<CreateSymptomRecordOutcome>;
  listSymptoms(patientId: string): Promise<SymptomRecord[]>;
  findSymptom(patientId: string, id: string): Promise<SymptomRecord | null>;
  updateSymptom(
    input: UpdateSymptomRecordInput
  ): Promise<UpdateSymptomRecordOutcome>;
}
