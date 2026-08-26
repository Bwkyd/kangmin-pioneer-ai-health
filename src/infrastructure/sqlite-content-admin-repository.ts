import { KangminDatabase } from "./database.js";
import { runIdempotentCreate } from "./idempotency.js";
import type {
  AdminContentItem,
  ContentAdminRepository,
  ContentItemKind,
  ContentItemStatus,
  CreateContentItemOutcome,
  PublishGuardState,
  PublishMediaState,
  UpdateContentItemResult,
  UpdateGuardedResult
} from "../modules/admin/content-admin-repository.js";
import { mediaIdsInContentBody } from "../modules/content-body-references.js";

interface Row {
  id: string;
  kind: ContentItemKind;
  title: string;
  category: string;
  summary: string;
  body: string;
  source: string;
  status: ContentItemStatus;
  revision: number;
  published_at: string | null;
  updated_at: string;
  cover_media_id: string | null;
  media_id: string | null;
  instructions: string | null;
  precautions: string | null;
  disclaimer: string | null;
  method_tags: string | null;
  display_order: number;
}

const COLUMNS = `
  id, kind, title, category, summary, body, source, status, revision,
  published_at, updated_at, cover_media_id, media_id,
  instructions, precautions, disclaimer, method_tags, display_order
`;

function map(row: Row): AdminContentItem {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    category: row.category,
    categoryIds: [],
    summary: row.summary,
    body: row.body,
    source: row.source,
    status: row.status,
    revision: row.revision,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    coverMediaId: row.cover_media_id,
    mediaId: row.media_id,
    instructions: row.instructions ?? "",
    precautions: row.precautions ?? "",
    disclaimer: row.disclaimer ?? "",
    methodTags:
      row.method_tags === null || row.method_tags === ""
        ? []
        : (JSON.parse(row.method_tags) as string[]),
    displayOrder: row.display_order
  };
}

function methodTagsJson(tags: readonly string[]): string {
  return JSON.stringify(tags);
}

/**
 * 患者侧公开引用（媒体交付链）：cover_url/media_url 不落对象存储键
 * （stored_path 是受管存储内部地址），更新时改写为公开媒体路由
 * /v1/media/<med_id>；cover_media_id/media_id 为 NULL 时 SQL 字符串
 * 拼接得 NULL，与旧 SELECT stored_path 的 NULL 语义一致。旧库的裸键
 * 存量由迁移 0014_content_media_public_urls 一次性改写。
 */
export class SqliteContentAdminRepository implements ContentAdminRepository {
  constructor(private readonly database: KangminDatabase) {}

  async listCategoryRegistry(kind: ContentItemKind) {
    return this.database.connection.prepare(`
      SELECT id, name, kind, parent_id, audience, node_type, status, selectable, display_order
      FROM content_category_registry
      WHERE kind = ?
      ORDER BY display_order ASC, id ASC
    `).all(kind).map((raw) => {
      const row = raw as {
        id: string; name: string; kind: ContentItemKind; parent_id: string | null;
        audience: "adult" | "child" | "all"; node_type: "audience" | "group" | "leaf";
        status: "active" | "disabled"; selectable: number; display_order: number;
      };
      const { parent_id, node_type, display_order, selectable, ...rest } = row;
      return { ...rest, parentId: parent_id, nodeType: node_type,
        selectable: selectable === 1, displayOrder: display_order };
    });
  }

  async create(
    adminId: string,
    item: AdminContentItem,
    key: string,
    requestHash: string
  ): Promise<CreateContentItemOutcome | { kind: "conflict" }> {
    return this.database.transaction(() => {
      const scope = this.scopeOf(item.kind);
      // 幂等归一（评审 A P1-4 收缩版）：查重/重放/冲突/写入语义与患者侧
      // 共用 runIdempotentCreate（表名与主键列参数化，物理表不合并）。
      // 重放前校验目标仍存在：已删除的内容同键重放返回 stale_replay，
      // 不返回幻影记录（评审 B P2，与患者侧语义一致）。
      const outcome = runIdempotentCreate(this.database.connection, {
        table: "admin_idempotency",
        actorColumn: "admin_id",
        scopeColumn: "scope",
        keyColumn: "idempotency_key",
        actorId: adminId,
        scope,
        key,
        requestHash,
        resultJson: JSON.stringify(item),
        createdAt: item.updatedAt,
        verifyExists: (json) =>
          this.database.connection.prepare(
            "SELECT id FROM content_items WHERE id = ?"
          ).get((JSON.parse(json) as AdminContentItem).id) !== undefined,
        insert: () => {
          this.database.connection.prepare(`
            INSERT INTO content_items(
              id, kind, title, category, summary, body, source,
              cover_url, media_url, status, patient_visible, version_valid,
              media_available, published_at, updated_at, revision, created_by,
              cover_media_id, media_id, instructions, precautions, disclaimer,
              method_tags, display_order
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'draft', 0, 1, 1, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            item.id,
            item.kind,
            item.title,
            item.category,
            item.summary,
            item.body,
            item.source,
            item.updatedAt,
            adminId,
            item.coverMediaId,
            item.mediaId,
            item.instructions,
            item.precautions,
            item.disclaimer,
            methodTagsJson(item.methodTags),
            item.displayOrder
          );
          this.syncCategoryLinks(item);
        }
      });
      switch (outcome.kind) {
        case "created":
          return { kind: "created" as const, item };
        case "idempotency_conflict":
          return { kind: "conflict" as const };
        case "stale_replay":
          return { kind: "stale_replay" as const };
        case "replayed":
          // 重放返回存储的原内容（原始 id），与患者侧语义一致。
          return {
            kind: "replayed" as const,
            item: this.findStored(item.kind, (JSON.parse(outcome.resultJson) as AdminContentItem).id) ?? item
          };
        case "date_conflict":
          // 管理端未启用 uniqueConflictAsDateConflict，结构上不可达；
          // 归入冲突，不向调用方泄露内部状态。
          return { kind: "conflict" as const };
      }
    });
  }

  async list(
    kind: ContentItemKind,
    status?: ContentItemStatus
  ): Promise<AdminContentItem[]> {
    const rows = this.database.connection.prepare(`
      SELECT ${COLUMNS} FROM content_items
      WHERE kind = ? ${status === undefined ? "" : "AND status = ?"}
      ORDER BY updated_at DESC, id ASC
    `).all(...(status === undefined ? [kind] : [kind, status])) as unknown as Row[];
    return rows.map((row) => this.withCategoryIds(map(row)));
  }

  async find(
    kind: ContentItemKind,
    id: string
  ): Promise<AdminContentItem | null> {
    const row = this.database.connection.prepare(`
      SELECT ${COLUMNS} FROM content_items WHERE kind = ? AND id = ?
    `).get(kind, id) as unknown as Row | undefined;
    return row === undefined ? null : this.withCategoryIds(map(row));
  }

  async update(
    item: AdminContentItem,
    expectedRevision: number
  ): Promise<UpdateContentItemResult> {
    return this.database.transaction(() => {
      const current = this.database.connection.prepare(
        "SELECT revision FROM content_items WHERE kind = ? AND id = ?"
      ).get(item.kind, item.id) as unknown as { revision: number } | undefined;
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const result = this.database.connection.prepare(`
        UPDATE content_items SET
          title = ?, category = ?, summary = ?, body = ?, source = ?,
          status = ?, patient_visible = ?, published_at = ?, updated_at = ?,
          revision = ?, cover_media_id = ?, media_id = ?,
          instructions = ?, precautions = ?, disclaimer = ?,
          method_tags = ?, display_order = ?,
          cover_url = '/v1/media/' || cover_media_id,
          media_url = '/v1/media/' || media_id
        WHERE id = ? AND kind = ? AND revision = ?
      `).run(
        item.title,
        item.category,
        item.summary,
        item.body,
        item.source,
        item.status,
        item.status === "published" ? 1 : 0,
        item.publishedAt,
        item.updatedAt,
        item.revision,
        item.coverMediaId,
        item.mediaId,
        item.instructions,
        item.precautions,
        item.disclaimer,
        methodTagsJson(item.methodTags),
        item.displayOrder,
        item.id,
        item.kind,
        expectedRevision
      );
      if (result.changes !== 1) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      this.syncCategoryLinks(item);
      return { kind: "updated" as const, item };
    });
  }

  /**
   * 发布专用更新（外部评审 P1-2）：依赖校验与状态更新在同一事务内。
   * BEGIN IMMEDIATE 持有写锁期间，并发停用分类/素材/删除都不可能越过
   * 事务提交生效，消除"校验后到提交间依赖被并发停用"的竞态窗口。
   */
  async updateGuarded(
    item: AdminContentItem,
    expectedRevision: number,
    guard: (state: PublishGuardState) => string[]
  ): Promise<UpdateGuardedResult> {
    return this.database.transaction(() => {
      const current = this.database.connection.prepare(
        "SELECT revision FROM content_items WHERE kind = ? AND id = ?"
      ).get(item.kind, item.id) as unknown as { revision: number } | undefined;
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const missing = guard(this.publishGuardStateOf(item));
      if (missing.length > 0) {
        return { kind: "validation_failed" as const, missing };
      }
      const result = this.database.connection.prepare(`
        UPDATE content_items SET
          title = ?, category = ?, summary = ?, body = ?, source = ?,
          status = ?, patient_visible = ?, published_at = ?, updated_at = ?,
          revision = ?, cover_media_id = ?, media_id = ?,
          instructions = ?, precautions = ?, disclaimer = ?,
          method_tags = ?, display_order = ?,
          cover_url = '/v1/media/' || cover_media_id,
          media_url = '/v1/media/' || media_id
        WHERE id = ? AND kind = ? AND revision = ?
      `).run(
        item.title,
        item.category,
        item.summary,
        item.body,
        item.source,
        item.status,
        item.status === "published" ? 1 : 0,
        item.publishedAt,
        item.updatedAt,
        item.revision,
        item.coverMediaId,
        item.mediaId,
        item.instructions,
        item.precautions,
        item.disclaimer,
        methodTagsJson(item.methodTags),
        item.displayOrder,
        item.id,
        item.kind,
        expectedRevision
      );
      if (result.changes !== 1) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      this.syncCategoryLinks(item);
      return { kind: "updated" as const, item };
    });
  }

  /** 事务内读取发布依赖状态（分类/封面/视频素材），与提交同连接同锁。 */
  private publishGuardStateOf(item: AdminContentItem): PublishGuardState {
    const categoryRow =
      item.category.trim() === ""
        ? undefined
        : (this.database.connection.prepare(
            "SELECT status, kind FROM content_categories WHERE name = ?"
          ).get(item.category) as unknown as
            | { status: "active" | "disabled"; kind: string }
            | undefined);
    const mediaState = (mediaId: string | null): PublishMediaState | null => {
      if (mediaId === null) {
        return null;
      }
      const row = this.database.connection.prepare(
        "SELECT status, kind FROM content_resource_media WHERE id = ?"
      ).get(mediaId) as unknown as
        | { status: string; kind: string }
        | undefined;
      return row === undefined
        ? { found: false }
        : { found: true, status: row.status, kind: row.kind };
    };
    const bodyMedia = mediaIdsInContentBody(item.body).map((mediaId) =>
      mediaState(mediaId)
    ).filter((media): media is PublishMediaState => media !== null);
    return {
      category: categoryRow ?? null,
      categories: item.categoryIds.map((categoryId) => {
        const row = this.database.connection.prepare(`
          SELECT id, status, kind, selectable
          FROM content_category_registry WHERE id = ?
        `).get(categoryId) as unknown as {
          id: string; status: "active" | "disabled";
          kind: ContentItemKind; selectable: number;
        } | undefined;
        return row === undefined ? null : { ...row, selectable: row.selectable === 1 };
      }).filter((row): row is NonNullable<typeof row> => row !== null),
      coverMedia: mediaState(item.coverMediaId),
      media: mediaState(item.mediaId),
      bodyMedia
    };
  }

  private categoryIdsOf(contentId: string): string[] {
    return (this.database.connection.prepare(`
      SELECT category_id FROM content_item_category_links
      WHERE content_id = ? ORDER BY category_id ASC
    `).all(contentId) as unknown as Array<{ category_id: string }>).map((row) => row.category_id);
  }

  private withCategoryIds(item: AdminContentItem): AdminContentItem {
    const categoryIds = this.categoryIdsOf(item.id);
    return { ...item, categoryIds, category: this.categoryPathsOf(categoryIds).join("；") };
  }

  private categoryPathsOf(categoryIds: readonly string[]): string[] {
    const path = this.database.connection.prepare(`
      WITH RECURSIVE ancestors(id, parent_id, name, depth) AS (
        SELECT id, parent_id, name, 0 FROM content_category_registry WHERE id = ?
        UNION ALL
        SELECT parent.id, parent.parent_id, parent.name, ancestors.depth + 1
        FROM content_category_registry AS parent
        JOIN ancestors ON ancestors.parent_id = parent.id
      )
      SELECT name FROM ancestors ORDER BY depth DESC
    `);
    return categoryIds.map((id) =>
      (path.all(id) as unknown as Array<{ name: string }>).map((row) => row.name).join(" / ")
    );
  }

  private findStored(kind: ContentItemKind, id: string): AdminContentItem | null {
    const row = this.database.connection.prepare(`
      SELECT ${COLUMNS} FROM content_items WHERE kind = ? AND id = ?
    `).get(kind, id) as unknown as Row | undefined;
    return row === undefined ? null : this.withCategoryIds(map(row));
  }

  private syncCategoryLinks(item: AdminContentItem): void {
    this.database.connection.prepare(
      "DELETE FROM content_item_category_links WHERE content_id = ?"
    ).run(item.id);
    const insert = this.database.connection.prepare(`
      INSERT INTO content_item_category_links(content_id, category_id, created_at)
      VALUES (?, ?, ?)
    `);
    for (const categoryId of [...new Set(item.categoryIds)]) {
      insert.run(item.id, categoryId, item.updatedAt);
    }
  }

  private scopeOf(kind: ContentItemKind): string {
    // 兼容 #135 的既有幂等作用域：文章保持 content.article.create。
    return kind === "article"
      ? "content.article.create"
      : `content.${kind}.create`;
  }
}
