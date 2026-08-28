import {
  createHash,
  randomUUID
} from "node:crypto";
import {
  readFileSync,
  statSync
} from "node:fs";
import { basename } from "node:path";

import { DomainError } from "../../kernel/errors.js";
import type { AuditPort } from "../system/audit-ports.js";
import type {
  ObjectStoragePort,
  ObjectUploadTicket
} from "../system/object-storage-ports.js";
import type {
  CategoryKind,
  ContentAuxRepository,
  ContentCategoryRow,
  ContentMediaRow,
  MediaReferenceRow
} from "./content-aux-repository.js";
import {
  assertContentMatchesDeclared,
  assertSizeWithinLimit,
  DEFAULT_MEDIA_MAX_BYTES,
  resolveMediaType,
  servableMediaContentType
} from "./media-validation.js";
import { extractArticleDocument, type ArticleDocumentDraft } from "./article-document-import.js";
import { ContentMessageService } from "./content-message-service.js";

const CATEGORY_KINDS = new Set<CategoryKind>([
  "article",
  "video",
  "message",
  "general"
]);

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function now(): string {
  return new Date().toISOString();
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** 大小上限读环境变量；未配置或非法值回退默认上限（fail-closed 仍生效）。 */
function envBytesLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** sha256 契约：64 位小写十六进制（客户端计算的内容指纹）。 */
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function assertSha256(value: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new DomainError(
      "validation_failed",
      "sha256 必须是 64 位小写十六进制字符串"
    );
  }
}

/** upload-init 返回：ready 重放 completed；新建/续传返回直传票据。 */
export type MediaUploadInitResult =
  | { status: "completed"; media: ContentMediaView }
  | {
      status: "uploading";
      mediaId: string;
      objectKey: string;
      ticket: ObjectUploadTicket;
    };

/** upload-confirm 返回：确认完成（含幂等重放）的素材视图。 */
export interface MediaUploadConfirmResult {
  status: "completed";
  media: ContentMediaView;
}

/** 远程上传内容校验失败的固定文案（failure_reason 与错误消息共用前缀）。 */
const UPLOAD_VERIFY_FAILURE_REASON = "上传内容校验失败";
const ARTICLE_DOCUMENT_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

type OptionalOf<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * 素材输出视图（事务与卫生残留批 P2-12a）：不暴露受管目录的绝对路径
 * storedPath（机器集成不需要，泄露服务器布局）。filename 保留。
 */
export type ContentMediaView = Omit<ContentMediaRow, "storedPath">;
export type MediaReferenceView = Omit<MediaReferenceRow, "mediaId">;
export type ContentMediaListView = ContentMediaView & {
  references: MediaReferenceView[];
};

export interface AdminMediaPreview {
  body: Buffer;
  contentType: string;
}

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
  private readonly messages: ContentMessageService;

  constructor(
    private readonly repository: ContentAuxRepository,
    private readonly storage: ObjectStoragePort,
    private readonly audit: AuditPort
  ) {
    this.messages = new ContentMessageService(repository, audit);
  }

  // ==== 素材 ====

  /**
   * 上传本地文件：注册元数据 + 写入对象存储（本地后端即 mediaDirectory，
   * S3 后端即 bucket；对象键 `<med_id>/<原始文件名>`）。写入失败不会注册为成功。
   *
   * 事务与卫生残留批 P2-7/P2-10：幂等键取文件内容指纹（sha256），同文件
   * 重传 → 重放返回原素材，不重复登记；createMedia 抛错（含幂等冲突）
   * 时删除已写入的对象，不留孤儿副本。
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

    // 双校验第一步：扩展名/--kind 白名单 + 大小上限（fail-closed）。
    const { kind, mimeType } = resolveMediaType(filePath, kindHint);
    assertSizeWithinLimit(
      stats.size,
      envBytesLimit(process.env.KANGMIN_MEDIA_MAX_BYTES, DEFAULT_MEDIA_MAX_BYTES),
      "素材文件"
    );

    // 全量读入计算内容指纹：超限文件已被大小上限拦截，不会走到这里。
    const fileBuffer = readFileSync(filePath);
    const sha256 = createHash("sha256").update(fileBuffer).digest("hex");
    // 双校验第二步：内容魔数嗅探（前 16 字节），声明类型与内容不符即拒绝。
    assertContentMatchesDeclared(kind, fileBuffer.subarray(0, 16));

    const id = newId("med");
    const filename = basename(filePath);
    const key = `${id}/${filename}`;
    // 本地实现原子落盘（临时文件 + 改名），失败不留半成品，无需清理。
    await this.storage.putObject({ key, body: fileBuffer, contentType: mimeType });

    const timestamp = now();
    const media: ContentMediaRow = {
      id,
      kind,
      filename,
      // storedPath 语义变化（对象存储接入）：改为对象存储 key
      // （`<med_id>/<文件名>`），不再是服务器绝对路径；本地后端即
      // mediaDirectory 下的相对路径，S3 后端即 bucket 内对象键。
      storedPath: key,
      sizeBytes: stats.size,
      mimeType,
      sha256,
      status: "ready",
      failureReason: null,
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
      outcome = await this.repository.createMediaIdempotent(
        adminId,
        media,
        // 确定性幂等键：文件内容指纹（与请求内容一一对应）。
        sha256,
        hash({ kind, filename, sha256, sizeBytes: stats.size })
      );
    } catch (error) {
      // 注册失败：清理已写入的对象，不留孤儿副本（P2-10）。
      await removeStoredCopy();
      throw error;
    }
    if (outcome.kind === "conflict") {
      await removeStoredCopy();
      throw new DomainError("idempotency_conflict", "相同幂等键已用于不同请求");
    }
    if (outcome.kind === "stale_replay") {
      await removeStoredCopy();
      throw new DomainError("stale_replay", "相同幂等键对应的素材已不存在");
    }
    if (outcome.kind === "replayed") {
      // 重放：原素材与其对象已存在，本次写入的副本多余，清理。
      await removeStoredCopy();
    }
    return toMediaView(outcome.item);
  }

  async listMedia(): Promise<ContentMediaListView[]> {
    const [media, references] = await Promise.all([
      this.repository.listMedia(),
      this.repository.listMediaReferences()
    ]);
    const byMedia = new Map<string, MediaReferenceView[]>();
    for (const { mediaId, ...reference } of references) {
      const current = byMedia.get(mediaId) ?? [];
      current.push(reference);
      byMedia.set(mediaId, current);
    }
    return media.map((item) => ({
      ...toMediaView(item),
      references: byMedia.get(item.id) ?? []
    }));
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

  /** 将已通过上传校验的 Word/PDF 提取为可人工校对的文章草稿。 */
  async importArticleDocument(id: string): Promise<ArticleDocumentDraft> {
    const media = await this.repository.findMedia(id);
    if (media === null) {
      throw new DomainError("resource_not_found", "文档素材不存在");
    }
    if (media.status !== "ready") {
      throw new DomainError("validation_failed", "文档素材尚未上传完成");
    }
    if (media.kind !== "word" && media.kind !== "pdf") {
      throw new DomainError("validation_failed", "文章导入仅支持 Word 和 PDF 文件");
    }
    assertSizeWithinLimit(
      media.sizeBytes,
      ARTICLE_DOCUMENT_IMPORT_MAX_BYTES,
      "文章导入文档"
    );
    const buffer = await this.storage.getObject(media.storedPath);
    return extractArticleDocument(media.filename, buffer);
  }

  /** 管理端预览专用：仅返回已完成素材，调用方必须先通过管理员会话。 */
  async previewMedia(id: string): Promise<AdminMediaPreview | null> {
    const media = await this.repository.findMedia(id);
    if (media === null || media.status !== "ready") {
      return null;
    }
    return {
      body: await this.storage.getObject(media.storedPath),
      contentType: servableMediaContentType(media.mimeType, media.storedPath)
    };
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
    // 删除前检查与写入一次提交；任一状态的业务引用都阻止删除，避免
    // 删除文件时静默切断草稿、下架内容或停用知识的来源。
    const outcome = await this.repository.deleteMediaGuarded(id, (references) =>
      references.contentResources > 0 || references.knowledgeItems > 0
        ? ["文件仍被文章、视频或 AI 知识使用，请先在对应业务中更换或移除"]
        : []
    );
    if (outcome.kind === "not_found") {
      throw new DomainError("resource_not_found", "素材不存在");
    }
    if (outcome.kind === "validation_failed") {
      throw new DomainError("validation_failed", outcome.missing.join("、"));
    }
    // 删除存储对象；失败不阻断删除（孤儿对象由后续对账统一回收）。
    try {
      await this.storage.deleteObject(media.storedPath);
    } catch {
      // 忽略：仅存储副本清理失败。
    }
    return { id, deleted: true };
  }

  // ==== 远程上传会话（预签名直传：init → 客户端直传 → confirm） ====

  /**
   * 上传会话申请（远程模式第一步）：双校验第一步（扩展名白名单 + 大小
   * 上限，与本地直写一致）+ sha256 形状校验。
   *
   * 去重/幂等：同指纹 ready 行 → 重放 completed（重复上传不发新票据）；
   * processing 行 → 复用该行重发票据（中断重试）；failed 行或不存在 →
   * 新建 processing 草稿（createMediaDraft）并签发新票据。
   *
   * 本地文件系统返回由 HTTP 层消费的一次性同源票据，S3 返回预签名
   * 直传 URL；两者都先签发票据再创建 processing 草稿。
   */
  async uploadInit(
    adminId: string,
    input: {
      filename: string;
      kind?: string | undefined;
      sizeBytes: number;
      sha256: string;
    },
    requestId?: string
  ): Promise<MediaUploadInitResult> {
    // 文件名只取 basename：对象键 `<med_id>/<文件名>`，拒绝路径成分。
    const filename = basename(input.filename);
    const { kind, mimeType } = resolveMediaType(filename, input.kind);
    assertSizeWithinLimit(
      input.sizeBytes,
      envBytesLimit(process.env.KANGMIN_MEDIA_MAX_BYTES, DEFAULT_MEDIA_MAX_BYTES),
      "素材文件"
    );
    assertSha256(input.sha256);

    const existing = await this.repository.findMediaBySha256(input.sha256);
    if (existing !== null && existing.status === "ready") {
      // 重复上传重放：原素材已就绪，直接返回，不发新票据。
      return { status: "completed", media: toMediaView(existing) };
    }
    if (existing !== null && existing.status === "processing") {
      // 中断重试：复用原行与对象键，重发票据。
      const ticket = await this.storage.createUploadTicket({
        key: existing.storedPath,
        contentType: existing.mimeType ?? mimeType,
        sizeBytes: existing.sizeBytes,
        sha256: existing.sha256 ?? input.sha256
      });
      return {
        status: "uploading",
        mediaId: existing.id,
        objectKey: existing.storedPath,
        ticket
      };
    }

    const id = newId("med");
    const objectKey = `${id}/${filename}`;
    const ticket = await this.storage.createUploadTicket({
      key: objectKey,
      contentType: mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256
    });
    const timestamp = now();
    await this.repository.createMediaDraft(adminId, {
      id,
      kind,
      filename,
      storedPath: objectKey,
      sizeBytes: input.sizeBytes,
      mimeType,
      sha256: input.sha256,
      status: "processing",
      failureReason: null,
      createdBy: adminId,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await this.audit.record({
      actorKind: "admin",
      actorId: adminId,
      action: "media.upload_init",
      entityType: "content_media",
      entityId: id,
      requestId,
      details: { filename, sizeBytes: input.sizeBytes, sha256: input.sha256 }
    });
    return { status: "uploading", mediaId: id, objectKey, ticket };
  }

  /**
   * 上传完成确认（远程模式第三步）：verifyObject 校验对象存在、大小与
   * sha256 一致；通过后再做双校验第二步（读取真实字节魔数嗅探，类型
   * 伪装防线，与本地落库前一致）。全部通过 → CAS 转 ready；任一失败 →
   * 转 failed（固定 failure_reason）+ 删除对象 + validation_failed。
   * 已 ready 且 sha 匹配 → 幂等重放 completed。
   */
  async uploadConfirm(
    adminId: string,
    input: { mediaId: string; sha256: string },
    requestId?: string
  ): Promise<MediaUploadConfirmResult> {
    assertSha256(input.sha256);
    const media = await this.repository.findMedia(input.mediaId);
    if (media === null) {
      throw new DomainError("resource_not_found", "素材不存在");
    }
    if (media.sha256 !== input.sha256) {
      throw new DomainError("validation_failed", "sha256 与上传会话不符");
    }
    if (media.status === "ready") {
      // 幂等重放：重复确认返回原视图。
      return { status: "completed", media: toMediaView(media) };
    }
    if (media.status !== "processing") {
      throw new DomainError(
        "validation_failed",
        "素材不在上传中状态，无法确认"
      );
    }

    const verified = await this.storage.verifyObject({
      key: media.storedPath,
      sha256: input.sha256,
      sizeBytes: media.sizeBytes
    });
    let contentMatches = false;
    if (verified) {
      // 类型伪装双校验第二步：魔数嗅探只抛 validation_failed，
      // 其余存储错误（verify 刚成功，结构上不可达）原样向上抛。
      const body = await this.storage.getObject(media.storedPath);
      try {
        assertContentMatchesDeclared(media.kind, body.subarray(0, 16));
        contentMatches = true;
      } catch (error) {
        if (error instanceof DomainError && error.code === "validation_failed") {
          contentMatches = false;
        } else {
          throw error;
        }
      }
    }

    if (!verified || !contentMatches) {
      await this.repository.transitionMediaStatus(media.id, "processing", {
        status: "failed",
        failureReason: UPLOAD_VERIFY_FAILURE_REASON,
        updatedAt: now()
      });
      try {
        await this.storage.deleteObject(media.storedPath);
      } catch {
        // 忽略：清理失败不遮蔽校验失败语义。
      }
      await this.audit.record({
        actorKind: "admin",
        actorId: adminId,
        action: "media.upload_confirm",
        entityType: "content_media",
        entityId: media.id,
        requestId,
        details: { status: "failed", reason: UPLOAD_VERIFY_FAILURE_REASON }
      });
      throw new DomainError(
        "validation_failed",
        `${UPLOAD_VERIFY_FAILURE_REASON}，请重新上传`
      );
    }

    const outcome = await this.repository.transitionMediaStatus(
      media.id,
      "processing",
      { status: "ready", failureReason: null, updatedAt: now() }
    );
    if (outcome === "not_found") {
      throw new DomainError("resource_not_found", "素材不存在");
    }
    if (outcome === "version_conflict") {
      // 并发 confirm 抢先完成：已是 ready 时按幂等重放处理。
      const reread = await this.repository.findMedia(media.id);
      if (reread !== null && reread.status === "ready") {
        return { status: "completed", media: toMediaView(reread) };
      }
      throw new DomainError("version_conflict", "素材状态已变化，请重新读取");
    }
    const updated = await this.repository.findMedia(media.id);
    if (updated === null) {
      throw new DomainError("internal_error", "素材状态流转后读取失败");
    }
    await this.audit.record({
      actorKind: "admin",
      actorId: adminId,
      action: "media.upload_confirm",
      entityType: "content_media",
      entityId: media.id,
      requestId,
      details: { status: "ready" }
    });
    return { status: "completed", media: toMediaView(updated) };
  }

  /**
   * 孤儿上传会话清理：status=processing 且 updated_at 早于阈值的行
   * （客户端中断后残留），逐条删除存储对象 + 物理删行。
   * 高影响操作：--yes 门禁在 application 层（requireConfirmation）。
   */
  async cleanupOrphans(
    adminId: string,
    input: { olderThanMinutes?: number | undefined } = {},
    requestId?: string
  ): Promise<{ cleaned: number }> {
    const olderThanMinutes = input.olderThanMinutes ?? 60;
    if (
      !Number.isInteger(olderThanMinutes) ||
      olderThanMinutes < 5 ||
      olderThanMinutes > 10080
    ) {
      throw new DomainError(
        "validation_failed",
        "olderThanMinutes 必须是 5 到 10080 的整数"
      );
    }
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
    const stale = await this.repository.listStaleProcessingMedia(cutoff);
    for (const media of stale) {
      try {
        await this.storage.deleteObject(media.storedPath);
      } catch {
        // 忽略：对象可能从未上传成功；删行不因此被阻断。
      }
      await this.repository.deleteMediaRow(media.id);
      await this.audit.record({
        actorKind: "admin",
        actorId: adminId,
        action: "media.cleanup_orphan",
        entityType: "content_media",
        entityId: media.id,
        requestId,
        details: { filename: media.filename, olderThanMinutes }
      });
    }
    return { cleaned: stale.length };
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

  createMessage(...args: Parameters<ContentMessageService["createMessage"]>): ReturnType<ContentMessageService["createMessage"]> {
    return this.messages.createMessage(...args);
  }

  listMessages(...args: Parameters<ContentMessageService["listMessages"]>): ReturnType<ContentMessageService["listMessages"]> {
    return this.messages.listMessages(...args);
  }

  getMessage(...args: Parameters<ContentMessageService["getMessage"]>): ReturnType<ContentMessageService["getMessage"]> {
    return this.messages.getMessage(...args);
  }

  updateMessage(...args: Parameters<ContentMessageService["updateMessage"]>): ReturnType<ContentMessageService["updateMessage"]> {
    return this.messages.updateMessage(...args);
  }

  publishMessage(...args: Parameters<ContentMessageService["publishMessage"]>): ReturnType<ContentMessageService["publishMessage"]> {
    return this.messages.publishMessage(...args);
  }

  unpublishMessage(...args: Parameters<ContentMessageService["unpublishMessage"]>): ReturnType<ContentMessageService["unpublishMessage"]> {
    return this.messages.unpublishMessage(...args);
  }
}
