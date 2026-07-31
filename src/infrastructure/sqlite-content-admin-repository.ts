import { KangminDatabase } from "./database.js";
import { runIdempotentCreate } from "./idempotency.js";
import type {
  AdminContentItem,
  ContentAdminRepository,
  ContentItemKind,
  ContentItemStatus,
  CreateContentItemOutcome,
  UpdateContentItemResult
} from "../modules/admin/content-admin-repository.js";

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

export class SqliteContentAdminRepository implements ContentAdminRepository {
  constructor(private readonly database: KangminDatabase) {}

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
            item: JSON.parse(outcome.resultJson) as AdminContentItem
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
    return rows.map(map);
  }

  async find(
    kind: ContentItemKind,
    id: string
  ): Promise<AdminContentItem | null> {
    const row = this.database.connection.prepare(`
      SELECT ${COLUMNS} FROM content_items WHERE kind = ? AND id = ?
    `).get(kind, id) as unknown as Row | undefined;
    return row === undefined ? null : map(row);
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
          cover_url = (SELECT stored_path FROM content_resource_media WHERE id = cover_media_id),
          media_url = (SELECT stored_path FROM content_resource_media WHERE id = media_id)
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
      return { kind: "updated" as const, item };
    });
  }

  private scopeOf(kind: ContentItemKind): string {
    // 兼容 #135 的既有幂等作用域：文章保持 content.article.create。
    return kind === "article"
      ? "content.article.create"
      : `content.${kind}.create`;
  }
}
