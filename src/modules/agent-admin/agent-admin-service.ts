import {
  createHash,
  randomUUID
} from "node:crypto";
import {
  readFileSync,
  statSync
} from "node:fs";
import { basename, extname } from "node:path";

import { DomainError } from "../../kernel/errors.js";
import {
  embedKnowledgeTexts,
  type KnowledgeEmbeddingPort
} from "../agent/knowledge-ports.js";
import type { KnowledgeRetrievalPort } from "../agent/knowledge-ports.js";
import {
  assertKnowledgeExtension,
  assertSizeWithinLimit,
  DEFAULT_KNOWLEDGE_MAX_BYTES,
  extensionOf
} from "../admin/media-validation.js";
import type { AuditPort } from "../system/audit-ports.js";
import type { ObjectStoragePort } from "../system/object-storage-ports.js";
import type {
  AgentAdminRepository,
  ChunkInput,
  KnowledgeRow,
  KnowledgeFolderRow,
  ModelConfigRow,
  PlanRow,
  UpdatePlanResult
} from "./agent-admin-ports.js";
import type {
  AgentPlan,
  AgentStatusSummary,
  KnowledgeHit,
  KnowledgeFolder,
  KnowledgeItem,
  ModelConfigView,
  PlanMapping,
  PlanPreview,
  TestCaseView
} from "./contracts.js";
import type {
  KnowledgeStatus,
  PlanStatus
} from "./domain.js";
import type { SyndromeRegistryPort } from "./agent-admin-ports.js";
import { chunkKnowledgeText } from "./knowledge-markdown.js";

type OptionalOf<T> = { [K in keyof T]?: T[K] | undefined };

const MODEL_DEFAULTS = {
  provider: "openai-compatible",
  modelName: "",
  timeoutSeconds: 30,
  maxOutputTokens: 1024,
  knowledgeRetrievalEnabled: false,
  retrievalCount: 3,
  explanationEnabled: true
};

/**
 * 急性期方案在 syndrome 列的约定值（agent_plans.phase_code='acute' 的
 * 伴生标记，双方案注册表按 phase_code 而非 syndrome 查询急性期方案）。
 * 它不是固定证型，不得写入 FIXED_SYNDROMES；管理端生命周期校验需放行
 * 此单值例外（评审 P1-7），其余证型仍必须命中固定证型白名单。
 */
const ACUTE_SYNDROME = "ACUTE";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function now(): string {
  return new Date().toISOString();
}

/** 检索命中片段：命中位置前后各取上下文（骨架实现）。 */
function snippetOf(chunkText: string, query: string): string {
  const position = chunkText.toLowerCase().indexOf(query.toLowerCase());
  if (position < 0) {
    return chunkText.slice(0, 80);
  }
  const start = Math.max(0, position - 20);
  return start === 0
    ? chunkText.slice(0, 80)
    : `…${chunkText.slice(start, start + 80)}`;
}

function maskApiKey(key: string | null): string | null {
  if (key === null || key === "") {
    return null;
  }
  if (key.length <= 8) {
    return "****";
  }
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/** 大小上限读环境变量；未配置或非法值回退默认上限（fail-closed 仍生效）。 */
function envBytesLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class AgentAdminService {
  constructor(
    private readonly repository: AgentAdminRepository,
    private readonly syndromes: SyndromeRegistryPort,
    private readonly storage: ObjectStoragePort,
    private readonly audit: AuditPort,
    private readonly embeddings?: KnowledgeEmbeddingPort,
    private readonly retrieval?: KnowledgeRetrievalPort
  ) {}

  // ==== 状态 ====

  async status(): Promise<AgentStatusSummary> {
    const [config, enabledKnowledge, failedKnowledge, enabledPlans, syndromes, lastCases] =
      await Promise.all([
        this.repository.getModelConfig(),
        this.repository.listKnowledge("enabled"),
        this.repository.listKnowledge("index_failed"),
        this.repository.listPlans("enabled"),
        this.syndromes.list(),
        this.repository.listTestCases(1)
      ]);
    const enabledSyndromes = new Set(enabledPlans.map((plan) => plan.syndrome));
    return {
      model: {
        provider: config?.provider ?? MODEL_DEFAULTS.provider,
        modelName: config?.modelName ?? "",
        configured: (config?.modelName ?? "") !== "",
        lastTestStatus: config?.lastTestStatus ?? null,
        lastTestAt: config?.lastTestAt ?? null
      },
      enabledKnowledgeCount: enabledKnowledge.length,
      indexFailedCount: failedKnowledge.length,
      enabledPlanCount: enabledPlans.length,
      syndromesWithoutEnabledPlan: syndromes.filter(
        (syndrome) => !enabledSyndromes.has(syndrome.id)
      ),
      lastTestCaseStatus:
        lastCases[0] === undefined ? null : this.toTestCaseView(lastCases[0])
    };
  }

  // ==== 知识库 ====

  async listKnowledgeFolders(): Promise<KnowledgeFolder[]> {
    const [folders, knowledge] = await Promise.all([
      this.repository.listKnowledgeFolders(),
      this.repository.listKnowledge()
    ]);
    return this.folderViews(folders, knowledge);
  }

  async createKnowledgeFolder(
    adminId: string,
    input: { name: string; parentId?: string | null | undefined; sortOrder?: number | undefined },
    requestId?: string
  ): Promise<KnowledgeFolder> {
    const name = input.name.trim();
    if (name === "") throw new DomainError("validation_failed", "目录名称不能为空");
    const folders = await this.repository.listKnowledgeFolders();
    const parentId = input.parentId?.trim() || null;
    if (parentId !== null) {
      const parentDepth = this.folderDepth(folders, parentId);
      if (parentDepth === null) throw new DomainError("resource_not_found", "上级目录不存在");
      if (parentDepth >= 3) throw new DomainError("validation_failed", "知识目录最多三级");
    }
    const timestamp = now();
    const row: KnowledgeFolderRow = {
      id: newId("kfd"),
      parentId,
      name,
      sortOrder: input.sortOrder ?? folders.filter((folder) => folder.parentId === parentId).length,
      createdBy: adminId,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const result = await this.repository.createKnowledgeFolder(row);
    if (result === "duplicate") throw new DomainError("validation_failed", "同级目录名称不能重复");
    await this.audit.record({ actorKind: "admin", actorId: adminId, action: "agent.knowledge-folder.create", entityType: "agent_knowledge_folder", entityId: row.id, requestId, details: { name, parentId } });
    return (await this.listKnowledgeFolders()).find((folder) => folder.id === row.id)!;
  }

  async updateKnowledgeFolder(
    adminId: string,
    id: string,
    changes: { name?: string | undefined; parentId?: string | null | undefined; sortOrder?: number | undefined },
    requestId?: string
  ): Promise<KnowledgeFolder> {
    const folders = await this.repository.listKnowledgeFolders();
    const current = folders.find((folder) => folder.id === id);
    if (current === undefined) throw new DomainError("resource_not_found", "目录不存在");
    const name = changes.name === undefined ? current.name : changes.name.trim();
    if (name === "") throw new DomainError("validation_failed", "目录名称不能为空");
    const parentId = changes.parentId === undefined ? current.parentId : changes.parentId?.trim() || null;
    if (parentId === id) throw new DomainError("validation_failed", "目录不能移动到自身下面");
    if (parentId !== null && !folders.some((folder) => folder.id === parentId)) {
      throw new DomainError("resource_not_found", "目标上级目录不存在");
    }
    const descendants = this.folderDescendants(folders, id);
    if (parentId !== null && descendants.has(parentId)) {
      throw new DomainError("validation_failed", "目录不能移动到自己的子目录下面");
    }
    const parentDepth = parentId === null ? 0 : this.folderDepth(folders, parentId);
    if (parentDepth === null) throw new DomainError("resource_not_found", "目标上级目录不存在");
    const currentDepth = this.folderDepth(folders, id)!;
    const subtreeDepth = Math.max(
      ...[id, ...descendants].map((folderId) => this.folderDepth(folders, folderId)! - currentDepth + 1)
    );
    if (parentDepth + subtreeDepth > 3) {
      throw new DomainError("validation_failed", "移动后目录会超过三级");
    }
    const result = await this.repository.updateKnowledgeFolder(id, {
      parentId,
      name,
      sortOrder: changes.sortOrder ?? current.sortOrder,
      updatedAt: now()
    });
    if (result.kind === "not_found") throw new DomainError("resource_not_found", "目录不存在");
    if (result.kind === "duplicate") throw new DomainError("validation_failed", "同级目录名称不能重复");
    await this.audit.record({ actorKind: "admin", actorId: adminId, action: "agent.knowledge-folder.update", entityType: "agent_knowledge_folder", entityId: id, requestId, details: { name, parentId, sortOrder: result.folder.sortOrder } });
    return (await this.listKnowledgeFolders()).find((folder) => folder.id === id)!;
  }

  async deleteKnowledgeFolder(adminId: string, id: string, requestId?: string): Promise<{ id: string; deleted: true }> {
    const current = (await this.repository.listKnowledgeFolders()).find((folder) => folder.id === id);
    if (current === undefined) throw new DomainError("resource_not_found", "目录不存在");
    const result = await this.repository.deleteKnowledgeFolder(id);
    if (result === "not_found") throw new DomainError("resource_not_found", "目录不存在");
    if (result === "not_empty") throw new DomainError("validation_failed", "目录中仍有知识或子目录，不能删除");
    await this.audit.record({ actorKind: "admin", actorId: adminId, action: "agent.knowledge-folder.delete", entityType: "agent_knowledge_folder", entityId: id, requestId, details: { name: current.name } });
    return { id, deleted: true };
  }

  async moveKnowledge(adminId: string, id: string, folderId: string | null, requestId?: string): Promise<KnowledgeItem> {
    const current = await this.getKnowledge(id);
    if (folderId !== null && !(await this.repository.listKnowledgeFolders()).some((folder) => folder.id === folderId)) {
      throw new DomainError("resource_not_found", "目标目录不存在");
    }
    const result = await this.repository.moveKnowledge(id, folderId, now());
    if (result === "not_found") throw new DomainError("resource_not_found", "知识不存在");
    await this.audit.record({ actorKind: "admin", actorId: adminId, action: "agent.knowledge.move", entityType: "agent_knowledge_item", entityId: id, requestId, details: { name: current.name, fromFolderId: current.folderId, toFolderId: folderId } });
    return this.getKnowledge(id);
  }

  /**
   * 添加知识源文件：注册元数据 + 源文件写入对象存储 + 骨架解析分块。
   * 解析失败（PDF/Word 无解析器）如实标记 index_failed，不伪装成功。
   *
   * 事务与卫生残留批 P1-4：素材登记与知识创建在仓储同一事务内
   * （createKnowledgeSource），任一失败整体回滚，不留孤儿素材行；
   * 失败或重放时已写入的对象在本方法内清理。幂等键为文件内容指纹
   * （sha256）：同文件重试走重放返回原知识，不重复创建。
   */
  async addKnowledge(
    adminId: string,
    filePath: string,
    input: { source?: string | undefined; description?: string | undefined; folderId?: string | null | undefined } = {}
  ): Promise<KnowledgeItem> {
    await this.assertFolderExists(input.folderId ?? null);
    let stats;
    try {
      stats = statSync(filePath);
    } catch (error) {
      throw new DomainError("validation_failed", "知识文件不存在或不可读", {
        cause: error
      });
    }
    if (!stats.isFile()) {
      throw new DomainError("validation_failed", "知识路径必须是文件");
    }
    const extension = extname(filePath).toLowerCase();
    // 扩展名白名单 + 大小上限（fail-closed）。
    assertKnowledgeExtension(filePath);
    assertSizeWithinLimit(
      stats.size,
      envBytesLimit(
        process.env.KANGMIN_KNOWLEDGE_MAX_BYTES,
        DEFAULT_KNOWLEDGE_MAX_BYTES
      ),
      "知识文件"
    );

    // 解析仍从本地文件读取（服务端直写路径）。
    const buffer = readFileSync(filePath);
    const filename = basename(filePath);
    // 确定性幂等键：文件内容指纹。同文件重试 → 同键 → 重放返回原知识。
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const mimeType = extension === ".pdf"
      ? "application/pdf"
      : extension === ".docx" || extension === ".doc"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "text/markdown";

    const parsed = this.parseSource(extension, buffer, filename);
    const timestamp = now();
    const id = newId("kno");
    const sourceMediaId = newId("med");
    const key = `${id}/${filename}`;
    // 本地实现原子落盘（临时文件 + 改名），失败不留半成品，无需清理。
    await this.storage.putObject({ key, body: buffer, contentType: mimeType });

    const row: KnowledgeRow = {
      id,
      name: filename,
      folderId: input.folderId ?? null,
      source: input.source?.trim() || null,
      description: input.description?.trim() || null,
      sourceMediaId,
      sizeBytes: stats.size,
      mimeType,
      sha256,
      status: parsed.kind === "parsed" ? "processing" : "index_failed",
      parseError: parsed.kind === "parsed" ? null : parsed.error,
      chunkCount: parsed.kind === "parsed" ? parsed.chunks.length : 0,
      createdBy: adminId,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    const removeStoredCopy = async (): Promise<void> => {
      try {
        await this.storage.deleteObject(key);
      } catch {
        // 忽略：清理失败不遮蔽原始错误。
      }
    };

    let outcome;
    try {
      outcome = await this.repository.createKnowledgeSource({
        adminId,
        // 知识源文件同时登记为素材：source_media_id 写入知识行
        // （同一事务内先素材后知识，FK 可满足），使 countMediaReferences
        // 能检测到已启用知识的引用。
        media: {
          id: sourceMediaId,
          kind: extension === ".pdf"
            ? "pdf"
            : extension === ".docx" || extension === ".doc"
              ? "word"
              : "markdown",
          filename,
          // storedPath 语义变化（对象存储接入）：改为对象存储 key
          // （`<kno_id>/<文件名>`），不再是服务器绝对路径。
          storedPath: key,
          sizeBytes: stats.size,
          mimeType,
          sha256,
          status: "ready",
          failureReason: null,
          createdBy: adminId,
          createdAt: timestamp,
          updatedAt: timestamp
        },
        knowledge: {
          ...row,
          chunks: parsed.kind === "parsed" ? parsed.chunks : []
        },
        idempotencyKey: sha256,
        requestHash: sha256
      });
    } catch (error) {
      // 事务失败（回滚，无孤儿素材行）：清理已写入的对象后抛出。
      await removeStoredCopy();
      throw error;
    }
    if (outcome.kind === "conflict") {
      await removeStoredCopy();
      throw new DomainError("idempotency_conflict", "相同幂等键已用于不同请求");
    }
    if (outcome.kind === "stale_replay") {
      await removeStoredCopy();
      throw new DomainError("stale_replay", "相同幂等键对应的知识已不存在");
    }
    if (outcome.kind === "replayed") {
      // 重放：原知识与其对象已存在，本次写入的副本多余，清理。
      await removeStoredCopy();
    }
    return outcome.item;
  }

  /**
   * 从已上传素材创建知识（远程上传路径）：素材经 upload-init/confirm
   * 就绪（status=ready）后，从对象存储读字节，复用本地 add 的
   * parseSource/chunkText 骨架解析（md/txt 分块；pdf/docx 如实标记
   * index_failed）。
   *
   * 幂等与本地 add 同 scope 同键（agent.knowledge.add + 素材 sha256）：
   * 同一文件无论经本地还是远程路径添加，重复提交都重放原知识。
   * 媒体行已在库，createKnowledgeFromMedia 同事务只插知识行 + 分块 +
   * 幂等行，不重复登记素材。
   */
  async addKnowledgeFromMedia(
    adminId: string,
    mediaId: string,
    input: { source?: string | undefined; description?: string | undefined; folderId?: string | null | undefined } = {}
  ): Promise<KnowledgeItem> {
    await this.assertFolderExists(input.folderId ?? null);
    const media = await this.repository.findMedia(mediaId);
    if (media === null) {
      throw new DomainError("resource_not_found", "素材不存在");
    }
    if (media.status !== "ready") {
      throw new DomainError("validation_failed", "素材未完成上传");
    }
    // 与本地 add 同规则：知识扩展名白名单 + 大小上限（fail-closed）。
    assertKnowledgeExtension(media.filename);
    assertSizeWithinLimit(
      media.sizeBytes,
      envBytesLimit(
        process.env.KANGMIN_KNOWLEDGE_MAX_BYTES,
        DEFAULT_KNOWLEDGE_MAX_BYTES
      ),
      "知识文件"
    );

    const buffer = await this.storage.getObject(media.storedPath);
    const extension = extensionOf(media.filename);
    // 幂等键取素材行 sha256（confirm 已校验与对象一致）；
    // 历史无指纹行兜底按内容现算。
    const sha256 =
      media.sha256 ?? createHash("sha256").update(buffer).digest("hex");
    const parsed = this.parseSource(extension, buffer, media.filename);
    const timestamp = now();
    const row: KnowledgeRow = {
      id: newId("kno"),
      name: media.filename,
      folderId: input.folderId ?? null,
      source: input.source?.trim() || null,
      description: input.description?.trim() || null,
      sourceMediaId: media.id,
      sizeBytes: media.sizeBytes,
      mimeType: media.mimeType,
      sha256,
      status: parsed.kind === "parsed" ? "processing" : "index_failed",
      parseError: parsed.kind === "parsed" ? null : parsed.error,
      chunkCount: parsed.kind === "parsed" ? parsed.chunks.length : 0,
      createdBy: adminId,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const outcome = await this.repository.createKnowledgeFromMedia(
      adminId,
      media.id,
      { ...row, chunks: parsed.kind === "parsed" ? parsed.chunks : [] },
      // 与本地 addKnowledge 同键同 hash：同文件重复提交 → 重放。
      sha256,
      sha256
    );
    if (outcome.kind === "conflict") {
      throw new DomainError("idempotency_conflict", "相同幂等键已用于不同请求");
    }
    if (outcome.kind === "stale_replay") {
      throw new DomainError("stale_replay", "相同幂等键对应的知识已不存在");
    }
    return outcome.item;
  }

  async listKnowledge(status?: string): Promise<KnowledgeItem[]> {
    return this.repository.listKnowledge(this.knowledgeStatusOf(status));
  }

  private async assertFolderExists(folderId: string | null): Promise<void> {
    if (folderId === null) return;
    if (!(await this.repository.listKnowledgeFolders()).some((folder) => folder.id === folderId)) {
      throw new DomainError("resource_not_found", "目标目录不存在");
    }
  }

  private folderDepth(folders: readonly KnowledgeFolderRow[], id: string): number | null {
    let current = folders.find((folder) => folder.id === id);
    if (current === undefined) return null;
    let depth = 1;
    const visited = new Set([id]);
    while (current.parentId !== null) {
      if (visited.has(current.parentId)) throw new DomainError("storage_unavailable", "知识目录存在循环关系");
      visited.add(current.parentId);
      const parent = folders.find((folder) => folder.id === current!.parentId);
      if (parent === undefined) throw new DomainError("storage_unavailable", "知识目录上级不存在");
      current = parent;
      depth += 1;
      if (depth > 3) throw new DomainError("storage_unavailable", "知识目录超过三级限制");
    }
    return depth;
  }

  private folderDescendants(folders: readonly KnowledgeFolderRow[], id: string): Set<string> {
    const found = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      for (const child of folders.filter((folder) => folder.parentId === parentId)) {
        if (found.has(child.id)) throw new DomainError("storage_unavailable", "知识目录存在循环关系");
        found.add(child.id);
        queue.push(child.id);
      }
    }
    return found;
  }

  private folderViews(folders: readonly KnowledgeFolderRow[], knowledge: readonly KnowledgeItem[]): KnowledgeFolder[] {
    return folders.map((folder) => ({
      id: folder.id,
      parentId: folder.parentId,
      name: folder.name,
      sortOrder: folder.sortOrder,
      depth: this.folderDepth(folders, folder.id) as 1 | 2 | 3,
      knowledgeCount: knowledge.filter((item) => item.folderId === folder.id).length,
      childCount: folders.filter((child) => child.parentId === folder.id).length,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt
    }));
  }

  async getKnowledge(id: string): Promise<KnowledgeItem> {
    const item = await this.repository.findKnowledge(id);
    if (item === null) {
      throw new DomainError("resource_not_found", "知识不存在");
    }
    return item;
  }

  async updateKnowledge(
    adminId: string,
    id: string,
    changes: { name?: string | undefined; source?: string | undefined; description?: string | undefined },
    requestId?: string
  ): Promise<KnowledgeItem> {
    const current = await this.getKnowledge(id);
    const name = changes.name === undefined ? current.name : changes.name.trim();
    if (name === "") throw new DomainError("validation_failed", "知识名称不能为空");
    const result = await this.repository.updateKnowledgeMetadata(id, {
      name,
      source: changes.source === undefined ? current.source : changes.source.trim() || null,
      description: changes.description === undefined ? current.description : changes.description.trim() || null,
      updatedAt: now()
    });
    if (result === "not_found") throw new DomainError("resource_not_found", "知识不存在");
    const updated = await this.getKnowledge(id);
    await this.audit.record({ actorKind: "admin", actorId: adminId, action: "agent.knowledge.update", entityType: "agent_knowledge_item", entityId: id, requestId, details: { name: updated.name, category: updated.category ?? null } });
    return updated;
  }

  async deleteKnowledge(adminId: string, id: string, requestId?: string): Promise<{ id: string; deleted: true }> {
    const current = await this.getKnowledge(id);
    if (current.status === "enabled") {
      throw new DomainError("validation_failed", "已启用知识需先停用再删除");
    }
    const result = await this.repository.deleteKnowledge(id);
    if (result === "not_found") throw new DomainError("resource_not_found", "知识不存在");
    await this.audit.record({ actorKind: "admin", actorId: adminId, action: "agent.knowledge.delete", entityType: "agent_knowledge_item", entityId: id, requestId, details: { name: current.name } });
    return { id, deleted: true };
  }

  async indexKnowledge(id: string): Promise<KnowledgeItem> {
    const item = await this.getKnowledge(id);
    if (item.status === "index_failed") {
      throw new DomainError(
        "validation_failed",
        `知识解析失败，不能建立索引：${item.parseError ?? "未知原因"}`
      );
    }
    if (item.chunkCount === 0) {
      throw new DomainError("validation_failed", "知识没有可索引的正文分块");
    }
    if (this.embeddings === undefined) {
      throw new DomainError("provider_unavailable", "知识语义检索尚未配置向量服务");
    }
    const chunks = await this.repository.listKnowledgeChunks(id);
    if (chunks.length !== item.chunkCount) {
      throw new DomainError("storage_unavailable", "知识正文分块数量不一致");
    }
    const encoded = await embedKnowledgeTexts(
      this.embeddings,
      chunks.map((chunk) => chunk.text)
    );
    const indexedAt = now();
    const result = await this.repository.replaceKnowledgeEmbeddings(
      id,
      encoded.modelName,
      encoded.dimensions,
      chunks.map((chunk, index) => ({
        chunkIndex: chunk.index,
        embedding: encoded.vectors[index]!
      })),
      indexedAt
    );
    if (result === "not_found") {
      throw new DomainError("resource_not_found", "知识不存在");
    }
    if (item.status === "processing") {
      await this.repository.setKnowledgeStatus(id, "indexed", indexedAt);
    }
    return this.getKnowledge(id);
  }

  async enableKnowledge(
    adminId: string,
    id: string,
    requestId?: string
  ): Promise<KnowledgeItem> {
    const item = await this.getKnowledge(id);
    if (item.status === "enabled") {
      return item;
    }
    if (item.status !== "indexed" && item.status !== "disabled") {
      throw new DomainError(
        "validation_failed",
        "只有已建立索引的知识可以启用"
      );
    }
    // 状态更新与来源素材状态校验在同一事务（setKnowledgeStatusGuarded，
    // 与 setPlanStatusGuarded 同类事务变式）：并发停用素材时，本事务
    // 重读素材状态并拒绝，不产生"已启用但源素材已停用"的中间状态。
    const outcome = await this.repository.setKnowledgeStatusGuarded(
      id,
      "enabled",
      now(),
      (knowledge, media) => this.knowledgeEnableMissing(knowledge, media)
    );
    if (outcome.kind === "not_found") {
      throw new DomainError("resource_not_found", "知识不存在");
    }
    if (outcome.kind === "validation_failed") {
      throw new DomainError("validation_failed", outcome.missing.join("、"));
    }
    const updated = outcome.knowledge;
    await this.audit.record({
      actorKind: "admin",
      actorId: adminId,
      action: "agent.knowledge.enable",
      entityType: "agent_knowledge_item",
      entityId: id,
      requestId,
      details: { name: updated.name }
    });
    return updated;
  }

  async disableKnowledge(
    adminId: string,
    id: string,
    requestId?: string
  ): Promise<KnowledgeItem> {
    const item = await this.getKnowledge(id);
    if (item.status !== "enabled") {
      throw new DomainError("validation_failed", "只有已启用知识可以停用");
    }
    // 与启用同走事务守卫：停用只要求事务内重读状态仍为 enabled
    //（状态谓词 CAS，防止并发启用/停用交错）。
    const outcome = await this.repository.setKnowledgeStatusGuarded(
      id,
      "disabled",
      now(),
      (knowledge) =>
        knowledge.status === "enabled"
          ? []
          : ["知识状态已变化，请重新读取"]
    );
    if (outcome.kind === "not_found") {
      throw new DomainError("resource_not_found", "知识不存在");
    }
    if (outcome.kind === "validation_failed") {
      throw new DomainError("validation_failed", outcome.missing.join("、"));
    }
    const updated = outcome.knowledge;
    await this.audit.record({
      actorKind: "admin",
      actorId: adminId,
      action: "agent.knowledge.disable",
      entityType: "agent_knowledge_item",
      entityId: id,
      requestId,
      details: { name: updated.name }
    });
    return updated;
  }

  /** 检索测试只命中已启用知识（未启用知识不能被 Agent 检索）。 */
  async searchKnowledge(query: string): Promise<KnowledgeHit[]> {
    if (this.retrieval === undefined) {
      throw new DomainError("capability_unavailable", "知识语义检索尚未配置");
    }
    const rows = await this.retrieval.searchEnabled(query, 3);
    return rows.map((row) => ({
      knowledgeId: row.knowledgeId,
      name: row.name,
      chunkIndex: row.chunkIndex,
      snippet: snippetOf(row.text, query),
      source: row.source,
      category: row.category,
      score: row.score,
      enabled: true
    }));
  }

  // ==== 调理方案 ====

  async createPlan(
    adminId: string,
    input: {
      name: string;
      syndrome: string;
      phaseCode?: "acute" | null;
      audience?: "adult" | "child" | null;
    } & OptionalOf<{
      method: string;
      steps: string[];
      precautions: string;
      risks: string;
      contraindications: string;
      applicableAge: string;
      videoResourceId: string;
      displayOrder: number;
    }>,
    idempotencyKey: string
  ): Promise<AgentPlan> {
    const name = input.name.trim();
    if (name === "") {
      throw new DomainError("validation_failed", "方案名称不能为空");
    }
    await this.requireSyndrome(input.syndrome);
    if (input.videoResourceId !== undefined && input.videoResourceId !== null) {
      await this.requireVideoResource(input.videoResourceId);
    }
    const timestamp = now();
    const plan: AgentPlan = {
      id: newId("plan"),
      name,
      syndrome: input.syndrome,
      // 期别×人群（智能体设计 v4，0012 迁移）：急性期方案 phaseCode='acute'
      // 且 syndrome='ACUTE'（管理端特判放行），调体方案 phaseCode=null。
      phaseCode: input.phaseCode === "acute" ? "acute" : null,
      audience: input.audience ?? null,
      method: input.method?.trim() ?? "",
      steps: (input.steps ?? []).map((step) => step.trim()).filter((step) => step !== ""),
      precautions: input.precautions?.trim() ?? "",
      risks: input.risks?.trim() ?? "",
      contraindications: input.contraindications?.trim() ?? "",
      applicableAge: input.applicableAge?.trim() || null,
      videoResourceId: input.videoResourceId ?? null,
      displayOrder: input.displayOrder ?? 0,
      status: "draft",
      revision: 1,
      createdBy: adminId,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    // 幂等创建（事务与卫生残留批 P2-7）：确定性键同内容重试 → 重放
    // 返回原方案；requestHash 取业务字段稳定哈希，重试内容一致时相同。
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          name,
          syndrome: input.syndrome,
          method: input.method?.trim() ?? "",
          steps: (input.steps ?? []).map((step) => step.trim()),
          precautions: input.precautions?.trim() ?? "",
          risks: input.risks?.trim() ?? "",
          contraindications: input.contraindications?.trim() ?? "",
          applicableAge: input.applicableAge?.trim() || null,
          videoResourceId: input.videoResourceId ?? null,
          displayOrder: input.displayOrder ?? 0
        }),
        "utf8"
      )
      .digest("hex");
    const outcome = await this.repository.createPlanIdempotent(
      adminId,
      this.toPlanRow(plan),
      idempotencyKey,
      requestHash
    );
    if (outcome.kind === "conflict") {
      throw new DomainError("idempotency_conflict", "相同幂等键已用于不同请求");
    }
    if (outcome.kind === "stale_replay") {
      throw new DomainError("stale_replay", "相同幂等键对应的方案已不存在");
    }
    return outcome.item;
  }

  async listPlans(status?: string): Promise<AgentPlan[]> {
    return this.repository.listPlans(this.planStatusOf(status));
  }

  async getPlan(id: string): Promise<AgentPlan> {
    const plan = await this.repository.findPlan(id);
    if (plan === null) {
      throw new DomainError("resource_not_found", "调理方案不存在");
    }
    return plan;
  }

  async previewPlan(id: string): Promise<PlanPreview> {
    const plan = await this.getPlan(id);
    const missing = await this.validatePlanForEnable(plan);
    return { ...plan, validation: { ok: missing.length === 0, missing } };
  }

  async updatePlan(
    id: string,
    expectedRevision: number,
    changes: OptionalOf<{
      name: string;
      syndrome: string;
      phaseCode: "acute" | null;
      audience: "adult" | "child" | null;
      method: string;
      steps: string[];
      precautions: string;
      risks: string;
      contraindications: string;
      applicableAge: string | null;
      videoResourceId: string | null;
      displayOrder: number;
    }>
  ): Promise<AgentPlan> {
    if (Object.keys(changes).length === 0) {
      throw new DomainError("validation_failed", "至少提供一个需要更新的字段");
    }
    if (changes.syndrome !== undefined) {
      await this.requireSyndrome(changes.syndrome);
    }
    if (changes.videoResourceId !== undefined && changes.videoResourceId !== null) {
      await this.requireVideoResource(changes.videoResourceId);
    }
    const current = await this.getPlan(id);
    const next: AgentPlan = {
      ...current,
      name: changes.name ?? current.name,
      syndrome: changes.syndrome ?? current.syndrome,
      phaseCode:
        changes.phaseCode === undefined
          ? current.phaseCode
          : changes.phaseCode === "acute"
            ? "acute"
            : null,
      audience:
        changes.audience === undefined ? current.audience : changes.audience,
      method: changes.method ?? current.method,
      steps: changes.steps ?? current.steps,
      precautions: changes.precautions ?? current.precautions,
      risks: changes.risks ?? current.risks,
      contraindications: changes.contraindications ?? current.contraindications,
      applicableAge:
        changes.applicableAge === undefined
          ? current.applicableAge
          : changes.applicableAge,
      videoResourceId:
        changes.videoResourceId === undefined
          ? current.videoResourceId
          : changes.videoResourceId,
      displayOrder: changes.displayOrder ?? current.displayOrder,
      revision: current.revision + 1,
      updatedAt: now()
    };
    if (current.status === "enabled") {
      // 启用状态的方案：更新后内容必须通过启用等价校验（防患者端展示被
      // 清空步骤/风险文本或换成未发布视频）。证型是固定注册表常量且新值
      // 已在上方 requireSyndrome 校验；内容完整性与视频发布状态等数据库
      // 依赖走 updatePlanGuarded 事务内重读校验（与 enablePlan 同一事务
      // 变式），校验失败整个更新拒绝，不落库。
      const outcome = await this.repository.updatePlanGuarded(
        next,
        expectedRevision,
        (plan, video) => this.planEnableMissing(plan, video)
      );
      if (outcome.kind === "validation_failed") {
        throw new DomainError(
          "validation_failed",
          `方案处于启用状态，更新后内容未通过启用校验：${outcome.missing.join("、")}`
        );
      }
      return this.planOutcome(outcome, expectedRevision);
    }
    const outcome = await this.repository.updatePlan(next, expectedRevision);
    return this.planOutcome(outcome, expectedRevision);
  }

  async enablePlan(
    adminId: string,
    id: string,
    expectedRevision: number,
    requestId?: string
  ): Promise<AgentPlan> {
    const plan = await this.getPlan(id);
    if (plan.status === "enabled") {
      return plan;
    }
    // 固定证型注册表是常量（非数据库状态），无并发窗口，事务外校验；
    // 方案内容与视频发布状态等数据库依赖在事务内重读校验
    // （repository.setPlanStatusGuarded，评审 C 事务变式）：并发进程
    // 在另一事务下架视频时，本事务校验拒绝，不产生"已启用但依赖已
    // 下架"的中间状态。
    // 急性期方案（syndrome='ACUTE'）跳过固定证型白名单校验（评审 P1-7）。
    const syndromeMissing =
      plan.syndrome !== ACUTE_SYNDROME &&
      (await this.syndromes.find(plan.syndrome)) === null
        ? ["适用证型无效"]
        : [];
    const outcome = await this.repository.setPlanStatusGuarded(
      id,
      expectedRevision,
      "enabled",
      now(),
      (current, video) => this.planEnableMissing(current, video)
    );
    if (outcome.kind === "validation_failed") {
      throw new DomainError(
        "validation_failed",
        `启用前校验未通过：${[...syndromeMissing, ...outcome.missing].join("、")}`
      );
    }
    const updated = this.planOutcome(outcome, expectedRevision);
    await this.audit.record({
      actorKind: "admin",
      actorId: adminId,
      action: "agent.plan.enable",
      entityType: "agent_plan",
      entityId: id,
      entityRevision: updated.revision,
      requestId,
      details: { name: updated.name }
    });
    return updated;
  }

  async disablePlan(
    adminId: string,
    id: string,
    expectedRevision: number,
    requestId?: string
  ): Promise<AgentPlan> {
    const plan = await this.getPlan(id);
    if (plan.status !== "enabled") {
      throw new DomainError("validation_failed", "只有已启用方案可以停用");
    }
    const outcome = await this.repository.setPlanStatus(
      id,
      expectedRevision,
      "disabled",
      now()
    );
    const updated = this.planOutcome(outcome, expectedRevision);
    await this.audit.record({
      actorKind: "admin",
      actorId: adminId,
      action: "agent.plan.disable",
      entityType: "agent_plan",
      entityId: id,
      entityRevision: updated.revision,
      requestId,
      details: { name: updated.name }
    });
    return updated;
  }

  /** 证型 → 方案映射：显示全部状态方案，标记无已启用方案的证型。 */
  async mappings(): Promise<PlanMapping[]> {
    const [syndromes, plans] = await Promise.all([
      this.syndromes.list(),
      this.repository.listPlans()
    ]);
    return syndromes.map((syndrome) => {
      const syndromePlans = plans.filter(
        (plan) => plan.syndrome === syndrome.id
      );
      return {
        syndromeId: syndrome.id,
        syndromeName: syndrome.name,
        hasEnabledPlan: syndromePlans.some((plan) => plan.status === "enabled"),
        plans: syndromePlans.map((plan) => ({
          id: plan.id,
          name: plan.name,
          status: plan.status
        }))
      };
    });
  }

  // ==== 模型设置 ====

  async showModelConfig(): Promise<ModelConfigView> {
    const config = await this.repository.getModelConfig();
    return this.toModelView(config);
  }

  async updateModelConfig(
    adminId: string,
    changes: OptionalOf<{
      provider: string;
      modelName: string;
      timeoutSeconds: number;
      maxOutputTokens: number;
      knowledgeRetrievalEnabled: boolean;
      retrievalCount: number;
      explanationEnabled: boolean;
      apiKey: string;
    }>
  ): Promise<ModelConfigView> {
    if (Object.keys(changes).length === 0) {
      throw new DomainError("validation_failed", "至少提供一个需要更新的字段");
    }
    if (changes.timeoutSeconds !== undefined) {
      this.intInRange(changes.timeoutSeconds, "timeoutSeconds", 1, 300);
    }
    if (changes.maxOutputTokens !== undefined) {
      this.intInRange(changes.maxOutputTokens, "maxOutputTokens", 128, 32768);
    }
    if (changes.retrievalCount !== undefined) {
      this.intInRange(changes.retrievalCount, "retrievalCount", 1, 20);
    }
    const current = await this.repository.getModelConfig();
    const next: ModelConfigRow = {
      provider:
        changes.provider?.trim() || (current?.provider ?? MODEL_DEFAULTS.provider),
      modelName:
        changes.modelName?.trim() ?? current?.modelName ?? "",
      timeoutSeconds:
        changes.timeoutSeconds ?? current?.timeoutSeconds ?? MODEL_DEFAULTS.timeoutSeconds,
      maxOutputTokens:
        changes.maxOutputTokens ?? current?.maxOutputTokens ?? MODEL_DEFAULTS.maxOutputTokens,
      knowledgeRetrievalEnabled:
        changes.knowledgeRetrievalEnabled === undefined
          ? current?.knowledgeRetrievalEnabled ?? 0
          : changes.knowledgeRetrievalEnabled
            ? 1
            : 0,
      retrievalCount:
        changes.retrievalCount ?? current?.retrievalCount ?? MODEL_DEFAULTS.retrievalCount,
      explanationEnabled:
        changes.explanationEnabled === undefined
          ? current?.explanationEnabled ?? 1
          : changes.explanationEnabled
            ? 1
            : 0,
      apiKey: changes.apiKey ?? current?.apiKey ?? null,
      updatedBy: adminId,
      updatedAt: now(),
      lastTestStatus: current?.lastTestStatus ?? null,
      lastTestAt: current?.lastTestAt ?? null
    };
    // 单行 CAS（事务与卫生残留批 P2-8）：以最近一次快照的 updated_at
    // 作谓词，并发覆盖被仓储拒绝 → version_conflict（与内容/方案的
    // expectedRevision 语义一致）。
    const outcome = await this.repository.upsertModelConfig(
      next,
      current?.updatedAt ?? null
    );
    if (outcome === "conflict") {
      throw new DomainError(
        "version_conflict",
        "模型配置已被其他管理员更新，请重新读取"
      );
    }
    return this.toModelView(next);
  }

  /** 模型连接测试：无真实提供方适配器，如实返回不可用并记录尝试。 */
  async testModel(adminId: string): Promise<ModelConfigView> {
    const config = await this.repository.getModelConfig();
    if ((config?.modelName ?? "") === "") {
      throw new DomainError(
        "config_missing",
        "尚未配置模型名称，无法测试连接"
      );
    }
    const timestamp = now();
    const outcome = await this.repository.upsertModelConfig({
      provider: config?.provider ?? MODEL_DEFAULTS.provider,
      modelName: config?.modelName ?? "",
      timeoutSeconds: config?.timeoutSeconds ?? MODEL_DEFAULTS.timeoutSeconds,
      maxOutputTokens: config?.maxOutputTokens ?? MODEL_DEFAULTS.maxOutputTokens,
      knowledgeRetrievalEnabled: config?.knowledgeRetrievalEnabled ?? 0,
      retrievalCount: config?.retrievalCount ?? MODEL_DEFAULTS.retrievalCount,
      explanationEnabled: config?.explanationEnabled ?? 1,
      apiKey: config?.apiKey ?? null,
      updatedBy: adminId,
      updatedAt: timestamp,
      lastTestStatus: "capability_unavailable",
      lastTestAt: timestamp
    }, config?.updatedAt ?? null);
    if (outcome === "conflict") {
      throw new DomainError(
        "version_conflict",
        "模型配置已被其他管理员更新，请重新读取"
      );
    }
    throw new DomainError(
      "capability_unavailable",
      "模型提供方适配器尚未接入（骨架阶段），无法验证真实连接"
    );
  }

  // ==== 模拟测试 ====

  /**
   * 全链路模拟测试：输入 → 安全规则 → 证型 → 方案 → 知识 → AI 解释。
   * w4-agent 规则内核（证型输出）尚未集成，正式输出阻断语义由 w4 实现；
   * 本命令如实返回 capability_unavailable，不伪造测试结果。
   */
  async runTest(): Promise<never> {
    throw new DomainError(
      "capability_unavailable",
      "规则引擎契约尚未接入（等待 w4-agent 规则内核集成），模拟测试暂不可用"
    );
  }

  async getTestCase(id: string): Promise<TestCaseView> {
    const row = await this.repository.findTestCase(id);
    if (row === null) {
      throw new DomainError("resource_not_found", "测试用例不存在");
    }
    return this.toTestCaseView(row);
  }

  // ==== 内部 ====

  private intInRange(
    value: number,
    key: string,
    min: number,
    max: number
  ): void {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new DomainError(
        "validation_failed",
        `${key} 必须是 ${min} 到 ${max} 的整数`
      );
    }
  }

  private parseSource(
    extension: string,
    buffer: Buffer,
    documentLabel: string
  ): { kind: "parsed"; chunks: ChunkInput[] } | { kind: "failed"; error: string } {
    if (extension === ".pdf" || extension === ".docx" || extension === ".doc") {
      return {
        kind: "failed",
        error: "PDF/Word 正文解析尚未实现（骨架阶段），等待真实解析器接入"
      };
    }
    const text = buffer.toString("utf8");
    if (text.trim() === "") {
      return { kind: "failed", error: "知识文件正文为空" };
    }
    return { kind: "parsed", chunks: chunkKnowledgeText(text, documentLabel) };
  }

  private async requireSyndrome(syndrome: string): Promise<void> {
    // 急性期方案例外（评审 P1-7）：ACUTE 是 phase_code='acute' 的伴生
    // 约定值而非固定证型，createPlan/updatePlan 均须放行其管理。
    if (syndrome === ACUTE_SYNDROME) {
      return;
    }
    const found = await this.syndromes.find(syndrome);
    if (found === null) {
      throw new DomainError(
        "validation_failed",
        `证型不在固定证型列表：${syndrome}（不能新建或修改证型）`
      );
    }
  }

  /** 方案引用视频必须存在（外键约束 + 服务层校验），发布状态在启用时校验。 */
  private async requireVideoResource(videoResourceId: string): Promise<void> {
    const video = await this.repository.findVideoResource(videoResourceId);
    if (video === null) {
      throw new DomainError("validation_failed", "关联视频不存在");
    }
  }

  /**
   * 启用前程序校验（预览路径）：证型存在、名称与调理方法非空、
   * 至少一个有效步骤、风险/注意事项/禁忌完整、关联视频存在且已发布。
   * 预览只读展示，允许事务外快照；启用路径改走 planEnableMissing
   * （repository.setPlanStatusGuarded 在事务内重读视频发布状态）。
   */
  private async validatePlanForEnable(plan: AgentPlan): Promise<string[]> {
    const missing: string[] = [];
    // 急性期方案（syndrome='ACUTE'）跳过固定证型白名单校验（评审 P1-7）。
    if (plan.syndrome !== ACUTE_SYNDROME) {
      const syndrome = await this.syndromes.find(plan.syndrome);
      if (syndrome === null) {
        missing.push("适用证型无效");
      }
    }
    missing.push(...this.planContentMissing(plan));
    if (plan.videoResourceId !== null) {
      const video = await this.repository.findVideoResource(plan.videoResourceId);
      if (video === null) {
        missing.push("关联视频不存在");
      } else if (video.status !== "published") {
        missing.push("关联视频未发布");
      }
    }
    return missing;
  }

  /**
   * 启用前校验的事务内变体（评审 C 事务变式）：只含数据库依赖项，
   * 由仓储在 BEGIN IMMEDIATE 内以重读的方案行与视频发布状态调用；
   * 固定证型注册表为常量，在 enablePlan 中事务外校验。
   */
  private planEnableMissing(
    plan: AgentPlan,
    video: { id: string; status: string } | null
  ): string[] {
    const missing = this.planContentMissing(plan);
    if (plan.videoResourceId !== null) {
      if (video === null) {
        missing.push("关联视频不存在");
      } else if (video.status !== "published") {
        missing.push("关联视频未发布");
      }
    }
    return missing;
  }

  /**
   * 知识启用前校验的事务内变体：只含数据库依赖项，由仓储在
   * BEGIN IMMEDIATE 内以重读的知识行与素材状态调用；并发停用素材、
   * 并发启用都在事务内被拒绝，不产生"已启用但源素材已停用"中间状态。
   */
  private knowledgeEnableMissing(
    knowledge: KnowledgeRow,
    media: { id: string; status: string } | null
  ): string[] {
    const missing: string[] = [];
    if (knowledge.status === "enabled") {
      missing.push("知识已启用");
    } else if (
      knowledge.status !== "indexed" &&
      knowledge.status !== "disabled"
    ) {
      missing.push("知识状态不允许启用");
    }
    if (knowledge.sourceMediaId !== null) {
      if (media === null) {
        missing.push("知识源素材不存在");
      } else if (media.status === "disabled") {
        missing.push("知识源素材已停用");
      }
    }
    return missing;
  }

  /** 方案自身内容完整性（与数据库状态无关，事务内外共用）。 */
  private planContentMissing(plan: AgentPlan): string[] {
    const missing: string[] = [];
    if (plan.name.trim() === "") {
      missing.push("方案名称");
    }
    if (plan.method.trim() === "") {
      missing.push("调理方法");
    }
    if (plan.steps.length === 0) {
      missing.push("操作步骤");
    }
    if (plan.risks.trim() === "") {
      missing.push("风险提示");
    }
    if (plan.precautions.trim() === "") {
      missing.push("注意事项");
    }
    if (plan.contraindications.trim() === "") {
      missing.push("禁忌");
    }
    return missing;
  }

  private planOutcome(
    outcome: UpdatePlanResult,
    expectedRevision: number
  ): AgentPlan {
    if (outcome.kind === "not_found") {
      throw new DomainError("resource_not_found", "调理方案不存在");
    }
    if (outcome.kind === "version_conflict") {
      throw new DomainError("version_conflict", "方案已更新，请重新读取", {
        details: {
          expectedRevision,
          currentRevision: outcome.currentRevision
        }
      });
    }
    return outcome.plan;
  }

  private toPlanRow(plan: AgentPlan): PlanRow {
    return {
      id: plan.id,
      name: plan.name,
      syndrome: plan.syndrome,
      phaseCode: plan.phaseCode,
      audience: plan.audience,
      method: plan.method,
      stepsJson: JSON.stringify(plan.steps),
      precautions: plan.precautions,
      risks: plan.risks,
      contraindications: plan.contraindications,
      applicableAge: plan.applicableAge,
      videoResourceId: plan.videoResourceId,
      displayOrder: plan.displayOrder,
      status: plan.status,
      revision: plan.revision,
      createdBy: plan.createdBy,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt
    };
  }

  private toModelView(config: ModelConfigRow | null): ModelConfigView {
    return {
      provider: config?.provider ?? MODEL_DEFAULTS.provider,
      modelName: config?.modelName ?? "",
      timeoutSeconds: config?.timeoutSeconds ?? MODEL_DEFAULTS.timeoutSeconds,
      maxOutputTokens: config?.maxOutputTokens ?? MODEL_DEFAULTS.maxOutputTokens,
      knowledgeRetrievalEnabled:
        (config?.knowledgeRetrievalEnabled ?? 0) === 1,
      retrievalCount: config?.retrievalCount ?? MODEL_DEFAULTS.retrievalCount,
      explanationEnabled: (config?.explanationEnabled ?? 1) === 1,
      apiKeyMasked: maskApiKey(config?.apiKey ?? null),
      updatedBy: config?.updatedBy ?? null,
      updatedAt: config?.updatedAt ?? null,
      lastTestStatus: config?.lastTestStatus ?? null,
      lastTestAt: config?.lastTestAt ?? null
    };
  }

  private toTestCaseView(row: {
    id: string;
    inputText: string;
    status: "completed" | "failed";
    resultJson: string;
    createdBy: string | null;
    createdAt: string;
  }): TestCaseView {
    return {
      id: row.id,
      inputText: row.inputText,
      status: row.status,
      result: JSON.parse(row.resultJson),
      createdBy: row.createdBy,
      createdAt: row.createdAt
    };
  }

  private knowledgeStatusOf(value: string | undefined): KnowledgeStatus | undefined {
    if (value === undefined) {
      return undefined;
    }
    const statuses: KnowledgeStatus[] = [
      "draft",
      "processing",
      "indexed",
      "enabled",
      "disabled",
      "index_failed"
    ];
    if (!statuses.includes(value as KnowledgeStatus)) {
      throw new DomainError(
        "validation_failed",
        "知识状态必须是 draft、processing、indexed、enabled、disabled 或 index_failed"
      );
    }
    return value as KnowledgeStatus;
  }

  private planStatusOf(value: string | undefined): PlanStatus | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value !== "draft" && value !== "enabled" && value !== "disabled") {
      throw new DomainError(
        "validation_failed",
        "方案状态必须是 draft、enabled 或 disabled"
      );
    }
    return value;
  }
}
