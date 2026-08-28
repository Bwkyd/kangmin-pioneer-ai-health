import type { PoolClient } from "pg";

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
} from "@kangmin/core/operations/admin/content-admin-repository";
import { mediaIdsInContentBody } from "@kangmin/core/content/content-body-references";
import { KangminPgDatabase } from "./database.js";
import { runPgIdempotentCreate } from "./idempotency.js";

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
 * 存量由迁移 0002_content_media_public_urls 一次性改写。
 */
export class PgContentAdminRepository implements ContentAdminRepository {
  constructor(private readonly database: KangminPgDatabase) {}

  async transaction<T>(operation: () => Promise<T> | T): Promise<T> {
    return this.database.transaction(async () => operation());
  }

  async listCategoryRegistry(kind: ContentItemKind) {
    const { rows } = await this.database.query<{
      id: string; name: string; kind: ContentItemKind; parent_id: string | null;
      audience: "adult" | "child" | "all"; node_type: "audience" | "group" | "leaf";
      status: "active" | "disabled"; selectable: number; display_order: number;
    }>(`SELECT id, name, kind, parent_id, audience, node_type, status, selectable, display_order
        FROM content_category_registry WHERE kind = $1
        ORDER BY display_order ASC, id ASC`, [kind]);
    return rows.map(({ parent_id, node_type, display_order, selectable, ...row }) => ({
      ...row, parentId: parent_id, nodeType: node_type,
      selectable: selectable === 1, displayOrder: display_order
    }));
  }

  async create(
    adminId: string,
    item: AdminContentItem,
    key: string,
    requestHash: string
  ): Promise<CreateContentItemOutcome | { kind: "conflict" }> {
    return this.database.transaction(async (client) => {
      const scope = this.scopeOf(item.kind);
      // 幂等归一（评审 A P1-4 收缩版）：查重/重放/冲突/写入语义与患者侧
      // 共用同一套幂等流程（表名与主键列参数化，物理表不合并）。
      // 重放前校验目标仍存在：已删除的内容同键重放返回 stale_replay，
      // 不返回幻影记录（评审 B P2，与患者侧语义一致）。
      const outcome = await runPgIdempotentCreate(this.database, client, {
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
        verifyExists: async (json) => {
          const { rows } = await this.database.queryIn(
            client,
            "SELECT id FROM content_items WHERE id = $1",
            [(JSON.parse(json) as AdminContentItem).id]
          );
          return rows[0] !== undefined;
        },
        insert: async () => {
          await this.database.queryIn(
            client,
            `INSERT INTO content_items(
              id, kind, title, category, summary, body, source,
              cover_url, media_url, status, patient_visible, version_valid,
              media_available, published_at, updated_at, revision, created_by,
              cover_media_id, media_id, instructions, precautions, disclaimer,
              method_tags, display_order
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, 'draft', 0, 1, 1, NULL, $8, 1, $9, $10, $11, $12, $13, $14, $15, $16)`,
            [
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
            ]
          );
          await this.syncCategoryLinks(client, item);
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
          {
            const replayed = JSON.parse(outcome.resultJson) as AdminContentItem;
            const stored = await this.find(item.kind, replayed.id);
            if (stored === null) return { kind: "stale_replay" as const };
          return {
            kind: "replayed" as const,
              item: stored
          };
          }
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
    const { rows } = await this.database.query<Row>(
      `SELECT ${COLUMNS} FROM content_items
       WHERE kind = $1 ${status === undefined ? "" : "AND status = $2"}
       ORDER BY updated_at DESC, id ASC`,
      status === undefined ? [kind] : [kind, status]
    );
    return Promise.all(rows.map(async (row) => this.withCategoryIds(map(row))));
  }

  async find(
    kind: ContentItemKind,
    id: string
  ): Promise<AdminContentItem | null> {
    const { rows } = await this.database.query<Row>(
      `SELECT ${COLUMNS} FROM content_items WHERE kind = $1 AND id = $2`,
      [kind, id]
    );
    const row = rows[0];
    return row === undefined ? null : this.withCategoryIds(map(row));
  }

  async update(
    item: AdminContentItem,
    expectedRevision: number
  ): Promise<UpdateContentItemResult> {
    return this.database.transaction(async (client) => {
      const current = await this.currentRevision(client, item.kind, item.id);
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const { rowCount } = await this.database.queryIn(
        client,
        `UPDATE content_items SET
          title = $1, category = $2, summary = $3, body = $4, source = $5,
          status = $6, patient_visible = $7, published_at = $8, updated_at = $9,
          revision = $10, cover_media_id = $11, media_id = $12,
          instructions = $13, precautions = $14, disclaimer = $15,
          method_tags = $16, display_order = $17,
          cover_url = '/v1/media/' || cover_media_id,
          media_url = '/v1/media/' || media_id
        WHERE id = $18 AND kind = $19 AND revision = $20`,
        [
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
        ]
      );
      if (rowCount !== 1) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      await this.syncCategoryLinks(client, item);
      return { kind: "updated" as const, item };
    });
  }

  /**
   * 发布专用更新（外部评审 P1-2）：依赖校验与状态更新在同一事务内。
   * SQLite 版靠 BEGIN IMMEDIATE 持写锁消除"校验后到提交间依赖被并发
   * 停用"的竞态窗口；PG 版在同一事务内读取依赖快照并由 CAS
   * （WHERE revision = expectedRevision）保证更新本身的原子性。
   */
  async updateGuarded(
    item: AdminContentItem,
    expectedRevision: number,
    guard: (state: PublishGuardState) => string[]
  ): Promise<UpdateGuardedResult> {
    return this.database.transaction(async (client) => {
      const current = await this.currentRevision(client, item.kind, item.id);
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const missing = guard(await this.publishGuardStateOf(client, item));
      if (missing.length > 0) {
        return { kind: "validation_failed" as const, missing };
      }
      const { rowCount } = await this.database.queryIn(
        client,
        `UPDATE content_items SET
          title = $1, category = $2, summary = $3, body = $4, source = $5,
          status = $6, patient_visible = $7, published_at = $8, updated_at = $9,
          revision = $10, cover_media_id = $11, media_id = $12,
          instructions = $13, precautions = $14, disclaimer = $15,
          method_tags = $16, display_order = $17,
          cover_url = '/v1/media/' || cover_media_id,
          media_url = '/v1/media/' || media_id
        WHERE id = $18 AND kind = $19 AND revision = $20`,
        [
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
        ]
      );
      if (rowCount !== 1) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      await this.syncCategoryLinks(client, item);
      return { kind: "updated" as const, item };
    });
  }

  /** 事务内读取当前修订（CAS 前置判定 not_found / version_conflict）。 */
  private async currentRevision(
    client: PoolClient,
    kind: ContentItemKind,
    id: string
  ): Promise<{ revision: number } | undefined> {
    const { rows } = await this.database.queryIn<{ revision: number }>(
      client,
      "SELECT revision FROM content_items WHERE kind = $1 AND id = $2",
      [kind, id]
    );
    return rows[0];
  }

  /** 事务内读取发布依赖状态（分类/封面/视频素材），与提交同连接同事务。 */
  private async publishGuardStateOf(
    client: PoolClient,
    item: AdminContentItem
  ): Promise<PublishGuardState> {
    let categoryRow:
      | { status: "active" | "disabled"; kind: string }
      | undefined;
    if (item.category.trim() !== "") {
      const { rows } = await this.database.queryIn<{
        status: "active" | "disabled";
        kind: string;
      }>(
        client,
        "SELECT status, kind FROM content_categories WHERE name = $1",
        [item.category]
      );
      categoryRow = rows[0];
    }
    const mediaState = async (
      mediaId: string | null
    ): Promise<PublishMediaState | null> => {
      if (mediaId === null) {
        return null;
      }
      const { rows } = await this.database.queryIn<{
        status: string;
        kind: string;
      }>(
        client,
        "SELECT status, kind FROM content_resource_media WHERE id = $1",
        [mediaId]
      );
      const row = rows[0];
      return row === undefined
        ? { found: false }
        : { found: true, status: row.status, kind: row.kind };
    };
    const bodyMedia = (await Promise.all(
      mediaIdsInContentBody(item.body).map((mediaId) => mediaState(mediaId))
    )).filter((media): media is PublishMediaState => media !== null);
    const { rows: categories } = await this.database.queryIn<{
      id: string; status: "active" | "disabled";
      kind: ContentItemKind; selectable: number;
    }>(client, `SELECT id, status, kind, selectable
                FROM content_category_registry WHERE id = ANY($1::text[])
                FOR SHARE`,
      [item.categoryIds]);
    return {
      category: categoryRow ?? null,
      categories: categories.map((category) => ({
        ...category, selectable: category.selectable === 1
      })),
      coverMedia: await mediaState(item.coverMediaId),
      media: await mediaState(item.mediaId),
      bodyMedia
    };
  }

  private async withCategoryIds(item: AdminContentItem): Promise<AdminContentItem> {
    const { rows } = await this.database.query<{ category_id: string; path: string }>(`
      WITH RECURSIVE paths(id, parent_id, name, path) AS (
        SELECT id, parent_id, name, name::text
        FROM content_category_registry WHERE parent_id IS NULL
        UNION ALL
        SELECT child.id, child.parent_id, child.name, paths.path || ' / ' || child.name
        FROM content_category_registry AS child
        JOIN paths ON child.parent_id = paths.id
      )
      SELECT links.category_id, paths.path
      FROM content_item_category_links AS links
      JOIN paths ON paths.id = links.category_id
      WHERE links.content_id = $1 ORDER BY links.category_id ASC
    `, [item.id]);
    return {
      ...item,
      categoryIds: rows.map((row) => row.category_id),
      category: rows.length === 0 ? item.category : rows.map((row) => row.path).join("；")
    };
  }

  private async syncCategoryLinks(client: PoolClient, item: AdminContentItem): Promise<void> {
    await this.database.queryIn(client,
      "DELETE FROM content_item_category_links WHERE content_id = $1", [item.id]);
    for (const categoryId of [...new Set(item.categoryIds)]) {
      await this.database.queryIn(client, `
        INSERT INTO content_item_category_links(content_id, category_id, created_at)
        VALUES ($1, $2, $3)
      `, [item.id, categoryId, item.updatedAt]);
    }
  }

  private scopeOf(kind: ContentItemKind): string {
    // 兼容 #135 的既有幂等作用域：文章保持 content.article.create。
    return kind === "article"
      ? "content.article.create"
      : `content.${kind}.create`;
  }
}
