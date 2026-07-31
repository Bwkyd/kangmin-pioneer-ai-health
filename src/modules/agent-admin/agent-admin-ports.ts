import type {
  AgentPlan,
  KnowledgeHit,
  KnowledgeItem
} from "./contracts.js";
import type {
  KnowledgeStatus,
  PlanStatus,
  SyndromeMeta
} from "./domain.js";

export interface KnowledgeRow {
  id: string;
  name: string;
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

export interface PlanRow {
  id: string;
  name: string;
  syndrome: string;
  method: string;
  stepsJson: string;
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

export interface ModelConfigRow {
  provider: string;
  modelName: string;
  timeoutSeconds: number;
  maxOutputTokens: number;
  knowledgeRetrievalEnabled: number;
  retrievalCount: number;
  explanationEnabled: number;
  apiKey: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  lastTestStatus: string | null;
  lastTestAt: string | null;
}

export interface TestCaseRow {
  id: string;
  inputText: string;
  status: "completed" | "failed";
  resultJson: string;
  createdBy: string | null;
  createdAt: string;
}

export interface ChunkInput {
  index: number;
  text: string;
}

export type UpdatePlanResult =
  | { kind: "updated"; plan: AgentPlan }
  | { kind: "not_found" }
  | { kind: "version_conflict"; currentRevision: number };

export interface AgentAdminRepository {
  // ---- 知识 ----
  createKnowledge(
    input: KnowledgeRow & { chunks: ChunkInput[] }
  ): Promise<void>;
  listKnowledge(status?: KnowledgeStatus): Promise<KnowledgeRow[]>;
  findKnowledge(id: string): Promise<KnowledgeRow | null>;
  setKnowledgeStatus(
    id: string,
    status: KnowledgeStatus,
    updatedAt: string,
    parseError?: string | null
  ): Promise<"updated" | "not_found">;
  searchChunks(query: string, onlyEnabled: boolean): Promise<
    Array<{
      knowledgeId: string;
      name: string;
      source: string | null;
      chunkIndex: number;
      chunkText: string;
    }>
  >;

  // ---- 素材登记（共享表，知识源文件与 content 素材同源） ----
  registerMedia(input: {
    id: string;
    kind: "image" | "video" | "word" | "pdf" | "markdown";
    filename: string;
    storedPath: string;
    sizeBytes: number;
    mimeType: string | null;
    sha256: string | null;
    status: "processing" | "ready" | "failed" | "disabled";
    failureReason: string | null;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;

  // ---- 方案 ----
  createPlan(input: PlanRow): Promise<void>;
  listPlans(status?: PlanStatus): Promise<AgentPlan[]>;
  findPlan(id: string): Promise<AgentPlan | null>;
  updatePlan(plan: AgentPlan, expectedRevision: number): Promise<UpdatePlanResult>;
  setPlanStatus(
    id: string,
    expectedRevision: number,
    status: PlanStatus,
    updatedAt: string
  ): Promise<UpdatePlanResult>;

  // ---- 模型设置 ----
  getModelConfig(): Promise<ModelConfigRow | null>;
  upsertModelConfig(row: ModelConfigRow): Promise<void>;

  // ---- 模拟测试 ----
  findTestCase(id: string): Promise<TestCaseRow | null>;
  listTestCases(limit: number): Promise<TestCaseRow[]>;

  // ---- 内容集成（方案关联视频的发布状态） ----
  findVideoResource(id: string): Promise<{ id: string; status: string } | null>;
}

/** 固定证型只读端口：当前由内置常量实现，待 w4 规则内核接管。 */
export interface SyndromeRegistryPort {
  list(): Promise<SyndromeMeta[]>;
  find(id: string): Promise<SyndromeMeta | null>;
}
