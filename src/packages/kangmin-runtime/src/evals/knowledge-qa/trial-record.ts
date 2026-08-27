import type { EvaluationAction } from "./task-schema.js";

export type ProviderOutcome = "ok" | "not_called" | "failed";

export interface EvaluationRetrievedSource {
  knowledgeId: string;
  name: string;
  source: string | null;
  chunkIndex: number;
  score: number;
  text: string;
  enabled: boolean;
}

export interface EvaluationReturnedSource {
  knowledgeId: string;
  name: string;
  source: string | null;
}

export interface EvaluationTurnRecord {
  input: string;
  observedAction: EvaluationAction;
  finalText: string;
  retrieved: EvaluationRetrievedSource[];
  returnedSources: EvaluationReturnedSource[];
  providerOutcome: ProviderOutcome;
  modelOutput: string | null;
  durationMs: number;
  streamedText: string | null;
  persistedText: string | null;
}

export interface EvaluationTrialRecord {
  taskId: string;
  trial: number;
  startedAt: string;
  snapshot: {
    codeSha: string;
    taskSet: string;
    knowledgeManifest: string;
    rulePackage: string;
    model: string;
    embeddingModel: string;
  };
  turns: EvaluationTurnRecord[];
}

export interface EvaluationExecutor {
  execute(taskId: string, trial: number): Promise<EvaluationTrialRecord>;
}
