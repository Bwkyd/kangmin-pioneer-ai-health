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
  setMediaStatus(
    id: string,
    status: MediaStatus,
    updatedAt: string,
    failureReason?: string | null
  ): Promise<"updated" | "not_found">;
  deleteMedia(id: string): Promise<"deleted" | "not_found">;
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
