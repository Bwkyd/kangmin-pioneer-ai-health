export type CategoryKind = "article" | "video" | "message" | "general";
export type CategoryStatus = "active" | "disabled";
export type MediaKind = "image" | "video" | "word" | "pdf" | "markdown";
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
  publishedResources: number;
  enabledKnowledge: number;
  enabledPlans: number;
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

/** 引用检查与删除同一事务的结果（guard 返回的 missing 由调用方映射）。 */
export type GuardedMediaDeleteResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "validation_failed"; missing: string[] };

type OptionalOf<T> = { [K in keyof T]?: T[K] | undefined };

export interface ContentAuxRepository {
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
  findMedia(id: string): Promise<ContentMediaRow | null>;
  listMedia(): Promise<ContentMediaRow[]>;
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
   * 清草稿引用 + 置 deleted 一次提交；guard 语义同 disableMediaGuarded。
   */
  deleteMediaGuarded(
    id: string,
    guard: (counts: MediaReferenceCounts) => string[]
  ): Promise<GuardedMediaDeleteResult>;
  /** 被已发布内容 / 已启用知识 / 已启用方案引用的素材不可停用或删除。 */
  countMediaReferences(mediaId: string): Promise<MediaReferenceCounts>;

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
