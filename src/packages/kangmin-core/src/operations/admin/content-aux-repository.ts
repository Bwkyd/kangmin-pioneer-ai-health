// MediaKind 唯一来源是 media-validation（扩展名/魔数校验与存储行共用，
// 避免多处定义发散）；此处 re-export 保持既有 import 路径不变。
import type { MediaKind } from "./media-validation.js";

export type { MediaKind };

export type CategoryKind = "article" | "video" | "message" | "general";
export type CategoryStatus = "active" | "disabled";
export type MediaStatus = "processing" | "ready" | "failed" | "disabled";
export type MessageStatus = "draft" | "published" | "unpublished";

export interface ContentCategoryRow {
  id: string;
  name: string;
  kind: CategoryKind;
  description: string | null;
  displayOrder: number;
  status: CategoryStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContentMediaRow {
  id: string;
  kind: MediaKind;
  filename: string;
  storedPath: string;
  sizeBytes: number;
  mimeType: string | null;
  sha256: string | null;
  status: MediaStatus;
  failureReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentMessageRow {
  id: string;
  title: string;
  body: string;
  summary: string | null;
  categoryId: string | null;
  status: MessageStatus;
  revision: number;
  publishedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MediaReferenceCounts {
  contentResources: number;
  knowledgeItems: number;
  publishedResources: number;
  enabledKnowledge: number;
  enabledPlans: number;
}

export interface MediaReferenceRow {
  mediaId: string;
  entityType: "article" | "video" | "knowledge";
  entityId: string;
  name: string;
  status: string;
  role: "file" | "cover" | "body" | "knowledge_source";
}

export type UpdateMessageResult =
  | { kind: "updated"; message: ContentMessageRow }
  | { kind: "not_found" }
  | { kind: "version_conflict"; currentRevision: number };

/** 引用检查与停用写入同一事务的结果（guard 返回的 missing 由调用方映射）。 */
export type GuardedMediaUpdateResult =
  | { kind: "updated"; media: ContentMediaRow }
  | { kind: "not_found" }
  | { kind: "validation_failed"; missing: string[] };

/** 管理端幂等创建（admin_idempotency 归一语义，与内容文章创建一致）。 */
export type IdempotentCreateResult<T> =
  | { kind: "created"; item: T }
  | { kind: "replayed"; item: T }
  | { kind: "stale_replay" }
  | { kind: "conflict" };

/** 引用检查与删除同一事务的结果（guard 返回的 missing 由调用方映射）。 */
export type GuardedMediaDeleteResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "validation_failed"; missing: string[] };

type OptionalOf<T> = { [K in keyof T]?: T[K] | undefined };

export interface ContentAuxRepository {
  /** 在公告写入与审计需要共享的数据库事务中执行操作。 */
  transaction<T>(operation: () => Promise<T> | T): Promise<T>;
  // ---- 分类 ----
  listCategories(kind?: CategoryKind): Promise<ContentCategoryRow[]>;
  findCategoryById(id: string): Promise<ContentCategoryRow | null>;
  findCategoryByName(name: string): Promise<ContentCategoryRow | null>;
  createCategory(input: {
    id: string;
    name: string;
    kind: CategoryKind;
    description: string | null;
    displayOrder: number;
    revision: number;
    createdAt: string;
    updatedAt: string;
  }): Promise<"created" | "name_taken">;
  updateCategory(
    id: string,
    expectedRevision: number,
    changes: OptionalOf<Pick<ContentCategoryRow, "name" | "description" | "displayOrder" | "kind">>,
    updatedAt: string
  ): Promise<"updated" | "not_found" | "version_conflict" | "name_taken">;
  disableCategory(
    id: string,
    expectedRevision: number,
    updatedAt: string
  ): Promise<"updated" | "not_found" | "version_conflict">;

  // ---- 素材 ----
  createMedia(input: {
    id: string;
    kind: MediaKind;
    filename: string;
    storedPath: string;
    sizeBytes: number;
    mimeType: string | null;
    sha256: string | null;
    status: MediaStatus;
    failureReason: string | null;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  /**
   * 幂等创建素材（事务与卫生残留批 P2-7）：admin_idempotency
   * （scope=content.media.upload），幂等键为文件内容指纹 sha256——
   * 同文件重传走重放返回原素材，不重复登记。重放前校验素材仍存在。
   */
  createMediaIdempotent(
    adminId: string,
    media: ContentMediaRow,
    idempotencyKey: string,
    requestHash: string
  ): Promise<IdempotentCreateResult<ContentMediaRow>>;
  findMedia(id: string): Promise<ContentMediaRow | null>;
  listMedia(): Promise<ContentMediaRow[]>;
  /** 一次查询返回全部文件的业务引用，供文件管理页展示，避免逐文件查询。 */
  listMediaReferences(): Promise<MediaReferenceRow[]>;
  /**
   * 引用检查与停用写入同一事务（BEGIN IMMEDIATE）：
   * guard 在事务内用同一连接读取引用计数，返回缺失项；缺省为空即更新。
   * 并发进程不能在检查通过后、提交前创建新的已发布引用
   * （与发布校验 updateGuarded 同类竞态，消除"检查→提交"窗口）。
   */
  disableMediaGuarded(
    id: string,
    updatedAt: string,
    guard: (counts: MediaReferenceCounts) => string[]
  ): Promise<GuardedMediaUpdateResult>;
  /**
   * 引用检查与删除同一事务（BEGIN IMMEDIATE）：删除前检查 +
   * 删除写入一次提交；guard 语义同 disableMediaGuarded。
   */
  deleteMediaGuarded(
    id: string,
    guard: (counts: MediaReferenceCounts) => string[]
  ): Promise<GuardedMediaDeleteResult>;
  /** 返回全部状态及生效状态的引用计数；调用方按动作选择保护边界。 */
  countMediaReferences(mediaId: string): Promise<MediaReferenceCounts>;

  // ---- 远程上传会话（预签名直传） ----
  /**
   * 按内容指纹查素材（上传会话去重）：ready 优先于 processing，
   * processing 优先于其余状态——ready 行重放 completed、processing 行
   * 重发票据、仅 failed 行时由调用方新建草稿。
   */
  findMediaBySha256(sha256: string): Promise<ContentMediaRow | null>;
  /**
   * 远程上传会话草稿：status=processing 直入，不写幂等表
   * （同文件去重由 findMediaBySha256 在服务层先行判定）。
   */
  createMediaDraft(adminId: string, media: ContentMediaRow): Promise<void>;
  /**
   * 素材状态 CAS 流转：UPDATE 带状态谓词（expectedStatus），谓词不命中
   * （并发流转）返回 version_conflict，行不存在返回 not_found。
   */
  transitionMediaStatus(
    id: string,
    expectedStatus: MediaStatus,
    next: {
      status: MediaStatus;
      failureReason: string | null;
      updatedAt: string;
    }
  ): Promise<"updated" | "not_found" | "version_conflict">;
  /** 孤儿上传会话：status=processing 且 updated_at 早于阈值的行。 */
  listStaleProcessingMedia(cutoffIso: string): Promise<ContentMediaRow[]>;
  /** 物理删除素材行（孤儿清理专用；无引用守卫，调用方限定 processing 行）。 */
  deleteMediaRow(id: string): Promise<void>;

  // ---- 站内公告 ----
  listMessages(status?: MessageStatus): Promise<ContentMessageRow[]>;
  findMessage(id: string): Promise<ContentMessageRow | null>;
  createMessage(input: {
    id: string;
    title: string;
    body: string;
    summary: string | null;
    categoryId: string | null;
    status: MessageStatus;
    revision: number;
    publishedAt: string | null;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  /**
   * 幂等创建公告（事务与卫生残留批 P2-7）：admin_idempotency
   * （scope=content.message.create），确定性键同内容重试 → 重放返回
   * 原公告；verifyExists 保证公告不存在时同键重放返回 stale_replay。
   */
  createMessageIdempotent(
    adminId: string,
    message: ContentMessageRow,
    idempotencyKey: string,
    requestHash: string
  ): Promise<IdempotentCreateResult<ContentMessageRow>>;
  updateMessage(
    message: ContentMessageRow,
    expectedRevision: number
  ): Promise<UpdateMessageResult>;
  setMessageStatus(
    id: string,
    expectedRevision: number,
    status: MessageStatus,
    publishedAt: string | null,
    updatedAt: string
  ): Promise<UpdateMessageResult>;
}
