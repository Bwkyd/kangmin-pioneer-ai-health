export type ContentItemKind = "article" | "video";
export type ContentItemStatus = "draft" | "published" | "unpublished";

export interface AdminContentItem {
  id: string;
  kind: ContentItemKind;
  title: string;
  category: string;
  summary: string;
  body: string;
  source: string;
  status: ContentItemStatus;
  revision: number;
  publishedAt: string | null;
  updatedAt: string;
  /** 引用素材库：封面与视频文件（视频必填，文章可选）。 */
  coverMediaId: string | null;
  mediaId: string | null;
  /** 视频专用字段；文章为空串。 */
  instructions: string;
  precautions: string;
  disclaimer: string;
  methodTags: string[];
  displayOrder: number;
}

/** 兼容 #135：AdminArticle 即 kind 固定为 article 的内容项。 */
export type AdminArticle = AdminContentItem;

export type CreateContentItemOutcome =
  | { kind: "created" | "replayed"; item: AdminContentItem }
  | { kind: "stale_replay" };

export interface UpdateContentItemOutcome {
  kind: "updated";
  item: AdminContentItem;
}

export type UpdateContentItemResult =
  | UpdateContentItemOutcome
  | { kind: "not_found" }
  | { kind: "version_conflict"; currentRevision: number };

/** 单个被引用素材在事务内快照的状态。 */
export type PublishMediaState =
  | { found: true; status: string; kind: string }
  | { found: false };

/**
 * 发布依赖快照：仓储在 updateGuarded 的同一数据库事务内读取，
 * 使"先校验依赖、再更新状态"与并发停用/删除之间没有窗口。
 * null 表示未引用；category 为 null 还表示分类不存在（不报错，
 * 与 preview 语义一致）；coverMedia/media 为 { found: false }
 * 表示引用了但素材不存在。
 */
export interface PublishGuardState {
  category: { status: "active" | "disabled"; kind: string } | null;
  coverMedia: PublishMediaState | null;
  media: PublishMediaState | null;
}

export type UpdateGuardedResult =
  | UpdateContentItemOutcome
  | { kind: "not_found" }
  | { kind: "version_conflict"; currentRevision: number }
  | { kind: "validation_failed"; missing: string[] };

export interface ContentAdminRepository {
  create(
    adminId: string,
    item: AdminContentItem,
    idempotencyKey: string,
    requestHash: string
  ): Promise<CreateContentItemOutcome | { kind: "conflict" }>;
  list(kind: ContentItemKind, status?: ContentItemStatus): Promise<AdminContentItem[]>;
  find(kind: ContentItemKind, id: string): Promise<AdminContentItem | null>;
  update(item: AdminContentItem, expectedRevision: number): Promise<UpdateContentItemResult>;
  /**
   * 事务内"先校验依赖再更新"的发布更新：
   * guard 在 BEGIN IMMEDIATE 内收到依赖状态快照，返回缺失清单；
   * 非空则整体回滚并返回 validation_failed，空则继续更新。
   */
  updateGuarded(
    item: AdminContentItem,
    expectedRevision: number,
    guard: (state: PublishGuardState) => string[]
  ): Promise<UpdateGuardedResult>;
}
