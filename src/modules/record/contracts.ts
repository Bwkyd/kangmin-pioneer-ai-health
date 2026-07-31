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
