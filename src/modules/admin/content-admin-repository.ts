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
}
