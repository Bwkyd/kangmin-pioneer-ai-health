import type {
  KnowledgeStatus,
  PlanStatus,
  SyndromeMeta
} from "./domain.js";

export interface KnowledgeItem {
  id: string;
  name: string;
  category?: string | null;
  source: string | null;
  description: string | null;
  sourceMediaId: string | null;
  sizeBytes: number;
  mimeType: string | null;
  sha256: string | null;
  status: KnowledgeStatus;
  parseError: string | null;
  chunkCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeHit {
  knowledgeId: string;
  name: string;
  chunkIndex: number;
  snippet: string;
  source: string | null;
  enabled: true;
}

export interface AgentPlan {
  id: string;
  name: string;
  syndrome: string;
  /** 期别（智能体设计 v4）：'acute'=急性期方案；null=调体方案。 */
  phaseCode: "acute" | null;
  /** 人群（智能体设计 v4）：'adult'/'child'。 */
  audience: "adult" | "child" | null;
  method: string;
  steps: string[];
  precautions: string;
  risks: string;
  contraindications: string;
  applicableAge: string | null;
  videoResourceId: string | null;
  displayOrder: number;
  status: PlanStatus;
  revision: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanPreview extends AgentPlan {
  validation: { ok: boolean; missing: string[] };
}

export interface PlanMapping {
  syndromeId: string;
  syndromeName: string;
  hasEnabledPlan: boolean;
  plans: Array<{ id: string; name: string; status: PlanStatus }>;
}

export interface ModelConfigView {
  provider: string;
  modelName: string;
  timeoutSeconds: number;
  maxOutputTokens: number;
  knowledgeRetrievalEnabled: boolean;
  retrievalCount: number;
  explanationEnabled: boolean;
  /** 脱敏后的 API Key；绝不返回完整密钥。 */
  apiKeyMasked: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  lastTestStatus: string | null;
  lastTestAt: string | null;
}

export interface TestCaseView {
  id: string;
  inputText: string;
  status: "completed" | "failed";
  result: unknown;
  createdBy: string | null;
  createdAt: string;
}

export interface AgentStatusSummary {
  model: {
    provider: string;
    modelName: string;
    configured: boolean;
    lastTestStatus: string | null;
    lastTestAt: string | null;
  };
  enabledKnowledgeCount: number;
  indexFailedCount: number;
  enabledPlanCount: number;
  syndromesWithoutEnabledPlan: SyndromeMeta[];
  lastTestCaseStatus: TestCaseView | null;
}
