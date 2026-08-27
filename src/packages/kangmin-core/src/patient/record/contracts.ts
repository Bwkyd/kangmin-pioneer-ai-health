import type { Sex } from "./domain.js";

export interface SymptomRecord {
  id: string;
  localDate: string;
  nasalCongestion: number;
  nasalItching: number;
  sneezing: number;
  runnyNose: number;
  tnssTotal: number;
  notes: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSymptomInput {
  localDate: string;
  nasalCongestion: number;
  nasalItching: number;
  sneezing: number;
  runnyNose: number;
  notes: string | null;
  idempotencyKey: string;
}

export interface UpdateSymptomInput {
  id: string;
  expectedRevision: number;
  nasalCongestion?: number | undefined;
  nasalItching?: number | undefined;
  sneezing?: number | undefined;
  runnyNose?: number | undefined;
  notes?: string | null | undefined;
}

export interface DeleteRecordInput {
  id: string;
  expectedRevision: number;
}

export interface HealthProfile {
  displayName: string | null;
  birthDate: string | null;
  sex: Sex;
  allergyHistory: string | null;
  knownAllergies: string | null;
  commonTriggers: string | null;
  notes: string | null;
  /** 0 表示从未建档；建档后从 1 递增。 */
  revision: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface UpdateProfileInput {
  expectedRevision: number;
  displayName?: string | null | undefined;
  birthDate?: string | null | undefined;
  sex?: Sex | undefined;
  allergyHistory?: string | null | undefined;
  knownAllergies?: string | null | undefined;
  commonTriggers?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface ExposureRecord {
  id: string;
  localDate: string;
  factors: string[];
  otherDescription: string | null;
  notes: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateExposureInput {
  localDate: string;
  factors: string[];
  otherDescription: string | null;
  notes: string | null;
  idempotencyKey: string;
}

export interface UpdateExposureInput {
  id: string;
  expectedRevision: number;
  factors?: string[] | undefined;
  otherDescription?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface MedicationRecord {
  id: string;
  localDate: string;
  medicationName: string;
  dosage: string | null;
  actualUse: string | null;
  notes: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMedicationInput {
  localDate: string;
  medicationName: string;
  dosage: string | null;
  actualUse: string | null;
  notes: string | null;
  idempotencyKey: string;
}

export interface UpdateMedicationInput {
  id: string;
  expectedRevision: number;
  medicationName?: string | undefined;
  dosage?: string | null | undefined;
  actualUse?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface OverviewData {
  recentSymptomDate: string | null;
  monthRecordCount: number;
  consecutiveDays: number;
  lastTnss: number | null;
  recentExposureDate: string | null;
  recentMedicationDate: string | null;
  dataRead: "ok";
}

export interface CalendarDay {
  localDate: string;
  symptomId: string | null;
  tnssTotal: number | null;
  hasExposure: boolean;
  hasMedication: boolean;
}

export interface CalendarProjection {
  month: string;
  days: CalendarDay[];
}

export interface TrendPoint {
  localDate: string;
  symptomId: string;
  tnssTotal: number;
}

export interface TrendProjection {
  from: string;
  to: string;
  items: TrendPoint[];
}
