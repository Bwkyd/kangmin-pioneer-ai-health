import {
  createHash,
  randomUUID
} from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync
} from "node:fs";
import { basename, extname, join } from "node:path";

import { DomainError } from "../../kernel/errors.js";
import type { AuditPort } from "../system/audit-ports.js";
import type {
  AgentAdminRepository,
  ChunkInput,
  KnowledgeRow,
  ModelConfigRow,
  PlanRow,
  UpdatePlanResult
} from "./agent-admin-ports.js";
import type {
  AgentPlan,
  AgentStatusSummary,
  KnowledgeHit,
  KnowledgeItem,
  ModelConfigView,
  PlanMapping,
  PlanPreview,
  TestCaseView
} from "./contracts.js";
import type {
  KnowledgeStatus,
  PlanStatus,
  SyndromeMeta
} from "./domain.js";
import type { SyndromeRegistryPort } from "./agent-admin-ports.js";

type OptionalOf<T> = { [K in keyof T]?: T[K] | undefined };

const KNOWLEDGE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".pdf", ".docx"]);
/** 骨架分块：每块约 1200 字符，按段落切分。 */
const CHUNK_TARGET_LENGTH = 1200;

const MODEL_DEFAULTS = {
  provider: "openai-compatible",
  modelName: "",
  timeoutSeconds: 30,
  maxOutputTokens: 1024,
  knowledgeRetrievalEnabled: false,
  retrievalCount: 3,
  explanationEnabled: true
};

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function now(): string {
  return new Date().toISOString();
}

/** 骨架分块：段落切分后合并到目标长度，空文本返回空数组。 */
function chunkText(text: string): ChunkInput[] {
  const paragraphs = text
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
  const chunks: ChunkInput[] = [];
  let buffer = "";
  for (const paragraph of paragraphs) {
    if (buffer !== "" && buffer.length + paragraph.length > CHUNK_TARGET_LENGTH) {
      chunks.push({ index: chunks.length, text: buffer });
      buffer = "";
    }
    buffer = buffer === "" ? paragraph : `${buffer}\n${paragraph}`;
  }
  if (buffer !== "") {
    chunks.push({ index: chunks.length, text: buffer });
  }
  return chunks;
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

export class AgentAdminService {
  constructor(
    private readonly repository: AgentAdminRepository,
    private readonly syndromes: SyndromeRegistryPort,
    private readonly mediaDirectory: string,
    private readonly audit: AuditPort
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

  /**
   * 添加知识源文件：注册元数据 + 复制源文件 + 骨架解析分块。
   * 解析失败（PDF/Word 无解析器）如实标记 index_failed，不伪装成功。
   */
  async addKnowledge(
    adminId: string,
    filePath: string,
    input: { source?: string | undefined; description?: string | undefined } = {}
  ): Promise<KnowledgeItem> {
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
    if (!KNOWLEDGE_EXTENSIONS.has(extension)) {
      throw new DomainError(
        "validation_failed",
        `不支持的知识文件类型：${extension}（支持 .md/.txt/.pdf/.docx）`
      );
    }

    const id = newId("kno");
    const filename = basename(filePath);
    const targetDirectory = join(this.mediaDirectory, id);
    const targetPath = join(targetDirectory, filename);
    try {
      mkdirSync(targetDirectory, { recursive: true });
      copyFileSync(filePath, targetPath);
    } catch (error) {
      throw new DomainError("validation_failed", "知识源文件复制失败", {
        cause: error
      });
    }

    const buffer = readFileSync(filePath);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const mimeType = extension === ".pdf"
      ? "application/pdf"
      : extension === ".docx" || extension === ".doc"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "text/markdown";

    const parsed = this.parseSource(extension, buffer);
    const timestamp = now();
    // 知识源文件同时登记为素材：把注册时生成的 media ID 写入
    // agent_knowledge_items.source_media_id（顺序写入，先素材后知识，
    // FK 可满足），使 countMediaReferences 能检测到已启用知识的引用。
    const sourceMediaId = newId("med");
    await this.repository.registerMedia({
      id: sourceMediaId,
      kind: extension === ".pdf"
        ? "pdf"
        : extension === ".docx" || extension === ".doc"
          ? "word"
          : "markdown",
      filename,
      storedPath: targetPath,
      sizeBytes: stats.size,
      mimeType,
      sha256,
      status: "ready",
      failureReason: null,
      createdBy: adminId,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    const row: KnowledgeRow = {
      id,
      name: filename,
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
    await this.repository.createKnowledge({
      ...row,
      chunks: parsed.kind === "parsed" ? parsed.chunks : []
    });
    return row;
  }

  async listKnowledge(status?: string): Promise<KnowledgeItem[]> {
    return this.repository.listKnowledge(this.knowledgeStatusOf(status));
  }

  async getKnowledge(id: string): Promise<KnowledgeItem> {
    const item = await this.repository.findKnowledge(id);
    if (item === null) {
      throw new DomainError("resource_not_found", "知识不存在");
    }
    return item;
  }

  async indexKnowledge(id: string): Promise<KnowledgeItem> {
    const item = await this.getKnowledge(id);
    if (item.status !== "processing") {
      if (item.status === "index_failed") {
        throw new DomainError(
          "validation_failed",
          `知识解析失败，不能建立索引：${item.parseError ?? "未知原因"}`
        );
      }
      throw new DomainError("validation_failed", "知识已建立索引，无需重复索引");
    }
    if (item.chunkCount === 0) {
      throw new DomainError("validation_failed", "知识没有可索引的正文分块");
    }
    await this.repository.setKnowledgeStatus(id, "indexed", now());
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
    await this.repository.setKnowledgeStatus(id, "enabled", now());
    const updated = await this.getKnowledge(id);
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
    await this.repository.setKnowledgeStatus(id, "disabled", now());
    const updated = await this.getKnowledge(id);
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
    const rows = await this.repository.searchChunks(query, true);
    return rows.map((row) => ({
      knowledgeId: row.knowledgeId,
      name: row.name,
      chunkIndex: row.chunkIndex,
      snippet: snippetOf(row.chunkText, query),
      source: row.source,
      enabled: true
    }));
  }

  // ==== 调理方案 ====

  async createPlan(
    adminId: string,
    input: {
      name: string;
      syndrome: string;
    } & OptionalOf<{
      method: string;
      steps: string[];
      precautions: string;
      risks: string;
      contraindications: string;
      applicableAge: string;
      videoResourceId: string;
      displayOrder: number;
    }>
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
    await this.repository.createPlan(this.toPlanRow(plan));
    return plan;
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
    const syndromeMissing =
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
    await this.repository.upsertModelConfig(next);
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
    await this.repository.upsertModelConfig({
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
    });
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
    buffer: Buffer
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
    return { kind: "parsed", chunks: chunkText(text) };
  }

  private async requireSyndrome(syndrome: string): Promise<SyndromeMeta> {
    const found = await this.syndromes.find(syndrome);
    if (found === null) {
      throw new DomainError(
        "validation_failed",
        `证型不在固定证型列表：${syndrome}（不能新建或修改证型）`
      );
    }
    return found;
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
    const syndrome = await this.syndromes.find(plan.syndrome);
    if (syndrome === null) {
      missing.push("适用证型无效");
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
