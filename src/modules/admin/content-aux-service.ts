import {
  createHash,
  randomUUID
} from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  rmSync,
  statSync
} from "node:fs";
import { basename, extname, join } from "node:path";

import { DomainError } from "../../kernel/errors.js";
import type { AuditPort } from "../system/audit-ports.js";
import type {
  CategoryKind,
  ContentAuxRepository,
  ContentCategoryRow,
  ContentMediaRow,
  ContentMessageRow,
  MediaKind,
  MessageStatus
} from "./content-aux-repository.js";

const CATEGORY_KINDS = new Set<CategoryKind>([
  "article",
  "video",
  "message",
  "general"
]);

const MEDIA_EXTENSIONS: Record<string, MediaKind> = {
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".webp": "image",
  ".gif": "image",
  ".mp4": "video",
  ".webm": "video",
  ".docx": "word",
  ".doc": "word",
  ".pdf": "pdf",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "markdown"
};

const MEDIA_MIME: Record<MediaKind, string> = {
  image: "image/*",
  video: "video/*",
  word: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  markdown: "text/markdown"
};

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function now(): string {
  return new Date().toISOString();
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type OptionalOf<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * 素材输出视图（事务与卫生残留批 P2-12a）：不暴露受管目录的绝对路径
 * storedPath（机器集成不需要，泄露服务器布局）。filename 保留。
 */
export type ContentMediaView = Omit<ContentMediaRow, "storedPath">;

function toMediaView(media: ContentMediaRow): ContentMediaView {
  const { storedPath: _storedPath, ...view } = media;
  return view;
}

function requireChange(changes: Record<string, unknown>): void {
  if (Object.keys(changes).length === 0) {
    throw new DomainError("validation_failed", "至少提供一个需要更新的字段");
  }
}

export class ContentAuxService {
  constructor(
    private readonly repository: ContentAuxRepository,
    private readonly mediaDirectory: string,
    private readonly audit: AuditPort
  ) {}

  // ==== 素材 ====

  /**
   * 上传本地文件：注册元数据 + 复制到受管媒体目录（对象存储后续阶段接入）。
   * 复制失败不会注册为成功。
   *
   * 事务与卫生残留批 P2-7/P2-10：幂等键取文件内容指纹（sha256），同文件
   * 重传 → 重放返回原素材，不重复登记；createMedia 抛错（含幂等冲突）
   * 时在 catch 中删除已复制的文件，不留孤儿副本。
   */
  async uploadMedia(
    adminId: string,
    filePath: string,
    kindHint?: string
  ): Promise<ContentMediaView> {
    let stats;
    try {
      stats = statSync(filePath);
    } catch (error) {
      throw new DomainError("validation_failed", "素材文件不存在或不可读", {
        cause: error
      });
    }
    if (!stats.isFile()) {
      throw new DomainError("validation_failed", "素材路径必须是文件");
    }

    const kind = kindHint === undefined
      ? MEDIA_EXTENSIONS[extname(filePath).toLowerCase()]
      : kindHint;
    if (kind === undefined || !Object.hasOwn(MEDIA_MIME, kind)) {
      throw new DomainError(
        "validation_failed",
        `不支持的文件类型：${extname(filePath)}（支持图片/视频/Word/PDF/Markdown）`
      );
    }

    const id = newId("med");
    const targetDirectory = join(this.mediaDirectory, id);
    const filename = basename(filePath);
    const targetPath = join(targetDirectory, filename);
    try {
      mkdirSync(targetDirectory, { recursive: true });
      copyFileSync(filePath, targetPath);
    } catch (error) {
      // 复制失败：清理可能残留的半成品目录后抛出。
      try {
        rmSync(targetDirectory, { recursive: true, force: true });
      } catch {
        // 忽略：清理失败不遮蔽原始错误。
      }
      throw new DomainError("validation_failed", "素材文件复制失败", {
        cause: error
      });
    }

    const fileBuffer = (await import("node:fs")).readFileSync(filePath);
    const sha256 = createHash("sha256").update(fileBuffer).digest("hex");
    const timestamp = now();
    const media: ContentMediaRow = {
      id,
      kind: kind as MediaKind,
      filename,
      storedPath: targetPath,
      sizeBytes: stats.size,
      mimeType: MEDIA_MIME[kind as MediaKind],
      sha256,
      status: "ready",
      failureReason: null,
      createdBy: adminId,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    let outcome;
    try {
      outcome = await this.repository.createMediaIdempotent(
        adminId,
        media,
        // 确定性幂等键：文件内容指纹（与请求内容一一对应）。
        sha256,
        hash({ kind, filename, sha256, sizeBytes: stats.size })
      );
    } catch (error) {
      // 注册失败：清理已复制的文件，不留孤儿副本（P2-10）。
      try {
        rmSync(targetDirectory, { recursive: true, force: true });
      } catch {
        // 忽略：清理失败不遮蔽原始错误。
      }
      throw error;
    }
    if (outcome.kind === "conflict") {
      try {
        rmSync(targetDirectory, { recursive: true, force: true });
      } catch {
        // 忽略。
      }
      throw new DomainError("idempotency_conflict", "相同幂等键已用于不同请求");
    }
    if (outcome.kind === "stale_replay") {
      try {
        rmSync(targetDirectory, { recursive: true, force: true });
      } catch {
        // 忽略。
      }
      throw new DomainError("stale_replay", "相同幂等键对应的素材已不存在");
    }
    if (outcome.kind === "replayed") {
      // 重放：原素材与其文件副本已存在，本次复制的副本多余，清理。
      try {
        rmSync(targetDirectory, { recursive: true, force: true });
      } catch {
        // 忽略。
      }
    }
    return toMediaView(outcome.item);
  }

  async listMedia(): Promise<ContentMediaView[]> {
    return (await this.repository.listMedia()).map(toMediaView);
  }

  async getMedia(
    id: string
  ): Promise<ContentMediaView & { referencedBy: unknown }> {
    const media = await this.repository.findMedia(id);
    if (media === null) {
      throw new DomainError("resource_not_found", "素材不存在");
    }
    const referencedBy = await this.repository.countMediaReferences(id);
    return { ...toMediaView(media), referencedBy };
  }

  async disableMedia(id: string): Promise<ContentMediaView> {
    const media = await this.repository.findMedia(id);
    if (media === null) {
      throw new DomainError("resource_not_found", "素材不存在");
    }
    if (media.status === "disabled") {
      throw new DomainError("validation_failed", "该素材已停用");
    }
    // 引用检查与停用写入同一事务（repository.disableMediaGuarded）：
    // BEGIN IMMEDIATE 持写锁期间，并发进程不能创建新的已发布引用——
    // 消除"countMediaReferences 检查 → setMediaStatus 提交"之间的
    // 竞态窗口（与发布校验 updateGuarded 同类，评审 C 事务变式）。
    const outcome = await this.repository.disableMediaGuarded(
      id,
      now(),
      (references) =>
        references.publishedResources > 0 || references.enabledKnowledge > 0
          ? ["素材仍被已发布内容或已启用知识引用，不能停用"]
          : []
    );
    if (outcome.kind === "not_found") {
      throw new DomainError("resource_not_found", "素材不存在");
    }
    if (outcome.kind === "validation_failed") {
      throw new DomainError("validation_failed", outcome.missing.join("、"));
    }
    return toMediaView(outcome.media);
  }

  async deleteMedia(id: string): Promise<{ id: string; deleted: true }> {
    const media = await this.repository.findMedia(id);
    if (media === null) {
      throw new DomainError("resource_not_found", "素材不存在");
    }
    // 引用检查与删除同一事务（repository.deleteMediaGuarded）：
    // 删除前检查 + 清草稿引用 + 置 deleted 一次提交，并发进程不能在
    // 检查通过后、提交前创建新的已发布引用（评审 C 事务变式）。
    const outcome = await this.repository.deleteMediaGuarded(id, (references) =>
      references.publishedResources > 0 || references.enabledKnowledge > 0
        ? ["素材仍被已发布内容或已启用知识引用，不能删除"]
        : []
    );
    if (outcome.kind === "not_found") {
      throw new DomainError("resource_not_found", "素材不存在");
    }
    if (outcome.kind === "validation_failed") {
      throw new DomainError("validation_failed", outcome.missing.join("、"));
    }
    // 删除受管副本；失败不阻断删除（对象存储后续阶段统一回收）。
    try {
      rmSync(media.storedPath, { force: true });
    } catch {
      // 忽略：仅本地副本清理失败。
    }
    return { id, deleted: true };
  }

  // ==== 分类 ====

  async createCategory(
    adminId: string,
    input: {
      name: string;
      kind: string;
      description?: string | undefined;
      displayOrder?: number | undefined;
    }
  ): Promise<ContentCategoryRow> {
    const name = input.name.trim();
    if (name === "") {
      throw new DomainError("validation_failed", "分类名称不能为空");
    }
    const kind = input.kind as CategoryKind;
    if (!CATEGORY_KINDS.has(kind)) {
      throw new DomainError(
        "validation_failed",
        "分类类型必须是 article、video、message 或 general"
      );
    }
    const timestamp = now();
    const outcome = await this.repository.createCategory({
      id: newId("cat"),
      name,
      kind,
      description: input.description?.trim() || null,
      displayOrder: input.displayOrder ?? 0,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    if (outcome === "name_taken") {
      throw new DomainError("validation_failed", "分类名称已存在");
    }
    const created = await this.repository.findCategoryByName(name);
    if (created === null) {
      throw new DomainError("internal_error", "分类创建后读取失败");
    }
    return created;
  }

  async listCategories(kind?: string): Promise<ContentCategoryRow[]> {
    if (kind !== undefined && !CATEGORY_KINDS.has(kind as CategoryKind)) {
      throw new DomainError(
        "validation_failed",
        "分类类型必须是 article、video、message 或 general"
      );
    }
    return this.repository.listCategories(kind as CategoryKind | undefined);
  }

  async getCategory(id: string): Promise<ContentCategoryRow> {
    const category = await this.repository.findCategoryById(id);
    if (category === null) {
      throw new DomainError("resource_not_found", "分类不存在");
    }
    return category;
  }

  async updateCategory(
    id: string,
    expectedRevision: number,
    changes: OptionalOf<Pick<ContentCategoryRow, "name" | "description" | "displayOrder">> & {
      kind?: string | undefined;
    }
  ): Promise<ContentCategoryRow> {
    requireChange(changes);
    if (changes.kind !== undefined && !CATEGORY_KINDS.has(changes.kind as CategoryKind)) {
      throw new DomainError(
        "validation_failed",
        "分类类型必须是 article、video、message 或 general"
      );
    }
    const outcome = await this.repository.updateCategory(
      id,
      expectedRevision,
      {
        name: changes.name,
        description: changes.description,
        displayOrder: changes.displayOrder,
        kind:
          changes.kind === undefined ? undefined : (changes.kind as CategoryKind)
      },
      now()
    );
    if (outcome === "not_found") {
      throw new DomainError("resource_not_found", "分类不存在");
    }
    if (outcome === "version_conflict") {
      throw new DomainError("version_conflict", "分类已更新，请重新读取");
    }
    if (outcome === "name_taken") {
      throw new DomainError("validation_failed", "分类名称已存在");
    }
    const updated = await this.repository.findCategoryById(id);
    return updated ?? (await this.getCategory(id));
  }

  async disableCategory(id: string, expectedRevision: number): Promise<ContentCategoryRow> {
    const outcome = await this.repository.disableCategory(id, expectedRevision, now());
    if (outcome === "not_found") {
      throw new DomainError("resource_not_found", "分类不存在");
    }
    if (outcome === "version_conflict") {
      throw new DomainError(
        "version_conflict",
        "分类已停用或已更新，请重新读取"
      );
    }
    const updated = await this.repository.findCategoryById(id);
    return updated ?? (await this.getCategory(id));
  }

  // ==== 站内公告 ====

  async createMessage(
    adminId: string,
    input: {
      title: string;
      body: string;
      summary?: string | undefined;
      categoryId?: string | undefined;
    },
    idempotencyKey: string
  ): Promise<ContentMessageRow> {
    const title = input.title.trim();
    const body = input.body.trim();
    if (title === "") {
      throw new DomainError("validation_failed", "公告标题不能为空");
    }
    if (body === "") {
      throw new DomainError("validation_failed", "公告正文不能为空");
    }
    const timestamp = now();
    const message: ContentMessageRow = {
      id: newId("msg"),
      title,
      body,
      summary: input.summary?.trim() || null,
      categoryId: input.categoryId ?? null,
      status: "draft",
      revision: 1,
      publishedAt: null,
      createdBy: adminId,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    // 幂等创建（事务与卫生残留批 P2-7）：确定性键同内容重试 → 重放
    // 返回原公告；requestHash 取业务字段稳定哈希，重试内容一致时相同。
    const outcome = await this.repository.createMessageIdempotent(
      adminId,
      message,
      idempotencyKey,
      hash({
        title,
        body,
        summary: input.summary?.trim() || null,
        categoryId: input.categoryId ?? null
      })
    );
    if (outcome.kind === "conflict") {
      throw new DomainError("idempotency_conflict", "相同幂等键已用于不同请求");
    }
    if (outcome.kind === "stale_replay") {
      throw new DomainError("stale_replay", "相同幂等键对应的公告已不存在");
    }
    return outcome.item;
  }

  async listMessages(status?: string): Promise<ContentMessageRow[]> {
    return this.repository.listMessages(
      status === undefined ? undefined : (status as MessageStatus)
    );
  }

  async getMessage(id: string): Promise<ContentMessageRow> {
    const message = await this.repository.findMessage(id);
    if (message === null) {
      throw new DomainError("resource_not_found", "公告不存在");
    }
    return message;
  }

  async updateMessage(
    id: string,
    expectedRevision: number,
    changes: OptionalOf<Pick<ContentMessageRow, "title" | "body" | "summary" | "categoryId">>
  ): Promise<ContentMessageRow> {
    requireChange(changes);
    const current = await this.getMessage(id);
    const next: ContentMessageRow = {
      ...current,
      title: changes.title ?? current.title,
      body: changes.body ?? current.body,
      summary: changes.summary === undefined ? current.summary : changes.summary,
      categoryId:
        changes.categoryId === undefined ? current.categoryId : changes.categoryId,
      revision: current.revision + 1,
      updatedAt: now()
    };
    const outcome = await this.repository.updateMessage(next, expectedRevision);
    return this.messageOutcome(outcome, expectedRevision);
  }

  async publishMessage(
    adminId: string,
    id: string,
    expectedRevision: number,
    requestId?: string
  ): Promise<ContentMessageRow> {
    const current = await this.getMessage(id);
    if (current.status === "published") {
      throw new DomainError("validation_failed", "公告已经发布");
    }
    if (current.title.trim() === "" || current.body.trim() === "") {
      throw new DomainError("validation_failed", "发布前公告标题和正文不能为空");
    }
    const timestamp = now();
    const outcome = await this.repository.setMessageStatus(
      id,
      expectedRevision,
      "published",
      timestamp,
      timestamp
    );
    const published = this.messageOutcome(outcome, expectedRevision);
    await this.audit.record({
      actorKind: "admin",
      actorId: adminId,
      action: "content.message.publish",
      entityType: "content_message",
      entityId: id,
      entityRevision: published.revision,
      requestId,
      details: { title: published.title }
    });
    return published;
  }

  async unpublishMessage(
    adminId: string,
    id: string,
    expectedRevision: number,
    requestId?: string
  ): Promise<ContentMessageRow> {
    const current = await this.getMessage(id);
    if (current.status !== "published") {
      throw new DomainError("validation_failed", "只有已发布公告可以下架");
    }
    const outcome = await this.repository.setMessageStatus(
      id,
      expectedRevision,
      "unpublished",
      null,
      now()
    );
    const unpublished = this.messageOutcome(outcome, expectedRevision);
    await this.audit.record({
      actorKind: "admin",
      actorId: adminId,
      action: "content.message.unpublish",
      entityType: "content_message",
      entityId: id,
      entityRevision: unpublished.revision,
      requestId,
      details: { title: unpublished.title }
    });
    return unpublished;
  }

  private messageOutcome(
    outcome:
      | { kind: "updated"; message: ContentMessageRow }
      | { kind: "not_found" }
      | { kind: "version_conflict"; currentRevision: number },
    expectedRevision: number
  ): ContentMessageRow {
    if (outcome.kind === "not_found") {
      throw new DomainError("resource_not_found", "公告不存在");
    }
    if (outcome.kind === "version_conflict") {
      throw new DomainError("version_conflict", "公告已更新，请重新读取", {
        details: {
          expectedRevision,
          currentRevision: outcome.currentRevision
        }
      });
    }
    return outcome.message;
  }
}
