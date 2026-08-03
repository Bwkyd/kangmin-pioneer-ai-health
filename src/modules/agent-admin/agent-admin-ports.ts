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
// MediaKind 唯一来源是 media-validation，避免多处定义发散。
import type { MediaKind } from "../admin/media-validation.js";

/**
 * 素材行（content_resource_media）只读投影：与 content-aux 的
 * ContentMediaRow 同构，在此独立声明以保持模块契约面
 * （跨模块导入只走 contracts/domain/-ports/media-validation）。
 */
export interface KnowledgeSourceMediaRow {
  id: string;
  kind: MediaKind;
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
}

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

/** 启用前校验与状态更新同一事务的结果（guard 返回的 missing 由调用方映射）。 */
export type PlanGuardedUpdateResult =
  | { kind: "updated"; plan: AgentPlan }
  | { kind: "not_found" }
  | { kind: "version_conflict"; currentRevision: number }
  | { kind: "validation_failed"; missing: string[] };

/**
 * 知识状态守卫更新结果：知识无 revision 列，事务内重读的状态同时充当
 * guard 输入与 UPDATE 状态谓词（CAS），并发变化 → validation_failed。
 */
export type KnowledgeGuardedUpdateResult =
  | { kind: "updated"; knowledge: KnowledgeRow }
  | { kind: "not_found" }
  | { kind: "validation_failed"; missing: string[] };

/** 管理端幂等创建（admin_idempotency 归一语义，与内容创建一致）。 */
export type IdempotentCreateResult<T> =
  | { kind: "created"; item: T }
  | { kind: "replayed"; item: T }
  | { kind: "stale_replay" }
  | { kind: "conflict" };

export interface AgentAdminRepository {
  // ---- 知识 ----
  createKnowledge(
    input: KnowledgeRow & { chunks: ChunkInput[] }
  ): Promise<void>;
  /**
   * 素材登记 + 知识创建 + 幂等行同一事务（事务与卫生残留批 P1-4）：
   * registerMedia 与 createKnowledge 不再跨事务——任一失败整体回滚，
   * 不留孤儿素材；确定性幂等键（文件 sha256）同内容重试 → 重放返回
   * 原知识。verifyExists 保证已删除知识同键重放返回 stale_replay。
   */
  createKnowledgeSource(input: {
    adminId: string;
    media: {
      id: string;
      kind: MediaKind;
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
    };
    knowledge: KnowledgeRow & { chunks: ChunkInput[] };
    idempotencyKey: string;
    requestHash: string;
  }): Promise<IdempotentCreateResult<KnowledgeRow>>;
  listKnowledge(status?: KnowledgeStatus): Promise<KnowledgeRow[]>;
  findKnowledge(id: string): Promise<KnowledgeRow | null>;
  /**
   * 素材读取（agent knowledge add-from-media）：校验媒体行存在且
   * status=ready，并解析对象键（storedPath）读取已上传字节。
   */
  findMedia(id: string): Promise<KnowledgeSourceMediaRow | null>;
  /**
   * 从已就绪素材创建知识（远程上传路径）：知识行 + 分块 + 幂等行同一
   * 事务；媒体行已在库（不重复插入，source_media_id 指向既有素材）。
   * 幂等键为素材 sha256（与 createKnowledgeSource 同 scope 同键：
   * 同一文件经本地上传或远程上传添加知识，重复提交都重放原知识）。
   */
  createKnowledgeFromMedia(
    adminId: string,
    mediaId: string,
    knowledge: KnowledgeRow & { chunks: ChunkInput[] },
    idempotencyKey: string,
    requestHash: string
  ): Promise<IdempotentCreateResult<KnowledgeRow>>;
  setKnowledgeStatus(
    id: string,
    status: KnowledgeStatus,
    updatedAt: string,
    parseError?: string | null
  ): Promise<"updated" | "not_found">;
  /**
   * 启用/停用前校验与状态更新同一事务（事务与卫生残留批 P1-3，与
   * setPlanStatusGuarded 同类事务变式）：guard 在 BEGIN IMMEDIATE 内
   * 收到重读的知识行与来源素材状态——并发停用素材时本事务校验拒绝，
   * 状态更新不提交；UPDATE 带状态谓词（知识无 revision 列，以事务内
   * 重读的状态本身作 CAS 令牌）。
   */
  setKnowledgeStatusGuarded(
    id: string,
    status: KnowledgeStatus,
    updatedAt: string,
    guard: (
      knowledge: KnowledgeRow,
      media: { id: string; status: string } | null
    ) => string[]
  ): Promise<KnowledgeGuardedUpdateResult>;
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
    kind: MediaKind;
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
  /**
   * 幂等创建方案（事务与卫生残留批 P2-7）：与内容/公告创建同用
   * admin_idempotency（scope=agent.plan.create）；verifyExists 保证
   * 目标不存在时同键重放返回 stale_replay。
   */
  createPlanIdempotent(
    adminId: string,
    plan: PlanRow,
    idempotencyKey: string,
    requestHash: string
  ): Promise<IdempotentCreateResult<AgentPlan>>;
  listPlans(status?: PlanStatus): Promise<AgentPlan[]>;
  findPlan(id: string): Promise<AgentPlan | null>;
  updatePlan(plan: AgentPlan, expectedRevision: number): Promise<UpdatePlanResult>;
  /**
   * 内容更新与启用等价校验同一事务（与 setPlanStatusGuarded 同类事务
   * 变式）：guard 在 BEGIN IMMEDIATE 内收到合并后的新方案内容与事务内
   * 重读的视频发布状态——并发进程在另一事务下架视频时，本事务校验
   * 拒绝，内容更新不提交；校验通过才在同一事务内落库（与 updatePlan
   * 共用 CAS）。
   */
  updatePlanGuarded(
    plan: AgentPlan,
    expectedRevision: number,
    guard: (
      plan: AgentPlan,
      video: { id: string; status: string } | null
    ) => string[]
  ): Promise<PlanGuardedUpdateResult>;
  setPlanStatus(
    id: string,
    expectedRevision: number,
    status: PlanStatus,
    updatedAt: string
  ): Promise<UpdatePlanResult>;
  /**
   * 启用前校验与状态更新同一事务（评审 C 事务变式，与内容发布
   * updateGuarded 同类）：guard 在 BEGIN IMMEDIATE 内执行，视频发布
   * 状态在事务内重读——并发进程在另一事务下架视频时，本事务校验
   * 拒绝，状态更新不提交；校验通过才在同一事务内置为 enabled。
   */
  setPlanStatusGuarded(
    id: string,
    expectedRevision: number,
    status: PlanStatus,
    updatedAt: string,
    guard: (
      plan: AgentPlan,
      video: { id: string; status: string } | null
    ) => string[]
  ): Promise<PlanGuardedUpdateResult>;

  // ---- 模型设置 ----
  getModelConfig(): Promise<ModelConfigRow | null>;
  /**
   * 单行 CAS 更新（事务与卫生残留批 P2-8）：行已存在时以
   * expectedUpdatedAt 作乐观锁谓词（WHERE id = 1 AND updated_at = ?），
   * 并发覆盖被拒绝返回 "conflict"（调用方映射 version_conflict）；
   * 行不存在时直接 INSERT。
   */
  upsertModelConfig(
    row: ModelConfigRow,
    expectedUpdatedAt: string | null
  ): Promise<"updated" | "conflict">;

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
