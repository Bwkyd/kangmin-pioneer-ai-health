import { KangminDatabase } from "./database.js";
import type {
  ContentAuxRepository,
  ContentCategoryRow,
  ContentMediaRow,
  ContentMessageRow,
  GuardedMediaDeleteResult,
  GuardedMediaUpdateResult,
  MediaKind,
  MediaReferenceCounts,
  MediaStatus,
  UpdateMessageResult
} from "../modules/admin/content-aux-repository.js";

interface CategoryRow {
  id: string;
  name: string;
  kind: ContentCategoryRow["kind"];
  description: string | null;
  display_order: number;
  status: ContentCategoryRow["status"];
  revision: number;
  created_at: string;
  updated_at: string;
}

interface MediaRow {
  id: string;
  kind: MediaKind;
  filename: string;
  stored_path: string;
  size_bytes: number;
  mime_type: string | null;
  sha256: string | null;
  status: MediaStatus;
  failure_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  title: string;
  body: string;
  summary: string | null;
  category_id: string | null;
  status: ContentMessageRow["status"];
  revision: number;
  published_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function toCategory(row: CategoryRow): ContentCategoryRow {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    displayOrder: row.display_order,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMedia(row: MediaRow): ContentMediaRow {
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    storedPath: row.stored_path,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    sha256: row.sha256,
    status: row.status,
    failureReason: row.failure_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMessage(row: MessageRow): ContentMessageRow {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    summary: row.summary,
    categoryId: row.category_id,
    status: row.status,
    revision: row.revision,
    publishedAt: row.published_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class SqliteContentAuxRepository implements ContentAuxRepository {
  constructor(private readonly database: KangminDatabase) {}

  // ---- 分类 ----

  async listCategories(kind?: ContentCategoryRow["kind"]): Promise<ContentCategoryRow[]> {
    const rows = this.database.connection.prepare(`
      SELECT id, name, kind, description, display_order, status, revision, created_at, updated_at
      FROM content_categories
      ${kind === undefined ? "" : "WHERE kind = ?"}
      ORDER BY display_order ASC, name ASC
    `).all(...(kind === undefined ? [] : [kind])) as unknown as CategoryRow[];
    return rows.map(toCategory);
  }

  async findCategoryById(id: string): Promise<ContentCategoryRow | null> {
    const row = this.database.connection.prepare(`
      SELECT id, name, kind, description, display_order, status, revision, created_at, updated_at
      FROM content_categories WHERE id = ?
    `).get(id) as unknown as CategoryRow | undefined;
    return row === undefined ? null : toCategory(row);
  }

  async findCategoryByName(name: string): Promise<ContentCategoryRow | null> {
    const row = this.database.connection.prepare(`
      SELECT id, name, kind, description, display_order, status, revision, created_at, updated_at
      FROM content_categories WHERE name = ?
    `).get(name) as unknown as CategoryRow | undefined;
    return row === undefined ? null : toCategory(row);
  }

  async createCategory(input: {
    id: string;
    name: string;
    kind: ContentCategoryRow["kind"];
    description: string | null;
    displayOrder: number;
    revision: number;
    createdAt: string;
    updatedAt: string;
  }): Promise<"created" | "name_taken"> {
    return this.database.transaction(() => {
      try {
        this.database.connection.prepare(`
          INSERT INTO content_categories(id, name, kind, description, display_order, status, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `).run(input.id, input.name, input.kind, input.description, input.displayOrder, input.revision, input.createdAt, input.updatedAt);
        return "created";
      } catch (error) {
        if (String(error).includes("UNIQUE")) {
          return "name_taken";
        }
        throw error;
      }
    });
  }

  async updateCategory(
    id: string,
    expectedRevision: number,
    changes: Partial<Pick<ContentCategoryRow, "name" | "description" | "displayOrder" | "kind">>,
    updatedAt: string
  ): Promise<"updated" | "not_found" | "version_conflict" | "name_taken"> {
    return this.database.transaction(() => {
      const current = this.database.connection.prepare(
        "SELECT revision, status FROM content_categories WHERE id = ?"
      ).get(id) as unknown as { revision: number; status: string } | undefined;
      if (current === undefined) {
        return "not_found";
      }
      if (current.status !== "active") {
        return "version_conflict";
      }
      if (current.revision !== expectedRevision) {
        return "version_conflict";
      }
      try {
        const result = this.database.connection.prepare(`
          UPDATE content_categories SET
            name = COALESCE(?, name),
            kind = COALESCE(?, kind),
            description = COALESCE(?, description),
            display_order = COALESCE(?, display_order),
            updated_at = ?, revision = revision + 1
          WHERE id = ?
        `).run(
          changes.name ?? null,
          changes.kind ?? null,
          changes.description === undefined ? null : changes.description,
          changes.displayOrder ?? null,
          updatedAt,
          id
        );
        if (result.changes !== 1) {
          return "version_conflict";
        }
        return "updated";
      } catch (error) {
        if (String(error).includes("UNIQUE")) {
          return "name_taken";
        }
        throw error;
      }
    });
  }

  async disableCategory(
    id: string,
    expectedRevision: number,
    updatedAt: string
  ): Promise<"updated" | "not_found" | "version_conflict"> {
    return this.database.transaction(() => {
      const current = this.database.connection.prepare(
        "SELECT revision, status FROM content_categories WHERE id = ?"
      ).get(id) as unknown as { revision: number; status: string } | undefined;
      if (current === undefined) {
        return "not_found";
      }
      if (current.status === "disabled") {
        return "version_conflict";
      }
      if (current.revision !== expectedRevision) {
        return "version_conflict";
      }
      const result = this.database.connection.prepare(`
        UPDATE content_categories
        SET status = 'disabled', updated_at = ?, revision = revision + 1
        WHERE id = ?
      `).run(updatedAt, id);
      if (result.changes !== 1) {
        return "version_conflict";
      }
      return "updated";
    });
  }

  // ---- 素材 ----

  async createMedia(input: {
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
  }): Promise<void> {
    this.database.connection.prepare(`
      INSERT INTO content_resource_media(
        id, kind, filename, stored_path, size_bytes, mime_type, sha256,
        status, failure_reason, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.kind,
      input.filename,
      input.storedPath,
      input.sizeBytes,
      input.mimeType,
      input.sha256,
      input.status,
      input.failureReason,
      input.createdBy,
      input.createdAt,
      input.updatedAt
    );
  }

  async findMedia(id: string): Promise<ContentMediaRow | null> {
    const row = this.findMediaSync(id);
    return row === undefined ? null : toMedia(row);
  }

  async listMedia(): Promise<ContentMediaRow[]> {
    const rows = this.database.connection.prepare(`
      SELECT id, kind, filename, stored_path, size_bytes, mime_type, sha256,
             status, failure_reason, created_by, created_at, updated_at
      FROM content_resource_media
      ORDER BY created_at DESC, id ASC
    `).all() as unknown as MediaRow[];
    return rows.map(toMedia);
  }

  /**
   * 引用检查与停用写入同一事务（评审 C 事务变式）：
   * BEGIN IMMEDIATE 持写锁期间，并发进程不能创建新的已发布引用
   * 越过事务提交生效——消除"countMediaReferences 检查 → setMediaStatus
   * 提交"之间的竞态窗口（与发布校验 updateGuarded 同类）。
   */
  async disableMediaGuarded(
    id: string,
    updatedAt: string,
    guard: (counts: MediaReferenceCounts) => string[]
  ): Promise<GuardedMediaUpdateResult> {
    return this.database.transaction(() => {
      const media = this.findMediaSync(id);
      if (media === undefined) {
        return { kind: "not_found" as const };
      }
      const missing = guard(this.countMediaReferencesSync(id));
      if (missing.length > 0) {
        return { kind: "validation_failed" as const, missing };
      }
      this.database.connection.prepare(`
        UPDATE content_resource_media
        SET status = 'disabled', failure_reason = NULL, updated_at = ?
        WHERE id = ?
      `).run(updatedAt, id);
      return {
        kind: "updated" as const,
        media: { ...toMedia(media), status: "disabled", updatedAt }
      };
    });
  }

  /**
   * 引用检查与删除同一事务（评审 C 事务变式）：删除前检查 + 清除
   * 草稿/下架内容与非启用知识的引用 + 置 deleted 一次提交；已发布
   * 内容的引用由事务内 guard 判定（引用>0 → validation_failed 回滚）。
   */
  async deleteMediaGuarded(
    id: string,
    guard: (counts: MediaReferenceCounts) => string[]
  ): Promise<GuardedMediaDeleteResult> {
    return this.database.transaction(() => {
      const media = this.findMediaSync(id);
      if (media === undefined) {
        return { kind: "not_found" as const };
      }
      const missing = guard(this.countMediaReferencesSync(id));
      if (missing.length > 0) {
        return { kind: "validation_failed" as const, missing };
      }
      // 这里清除草稿/下架内容与非启用知识的引用，避免外键约束阻断删除
      // （删除只断引用不断内容）。
      this.database.connection.prepare(`
        UPDATE content_items
        SET media_id = NULL, cover_media_id = NULL
        WHERE (media_id = ? OR cover_media_id = ?) AND status != 'published'
      `).run(id, id);
      this.database.connection.prepare(`
        UPDATE agent_knowledge_items SET source_media_id = NULL
        WHERE source_media_id = ?
      `).run(id);
      this.database.connection.prepare(
        "DELETE FROM content_resource_media WHERE id = ?"
      ).run(id);
      return { kind: "deleted" as const };
    });
  }

  async countMediaReferences(mediaId: string): Promise<MediaReferenceCounts> {
    return this.countMediaReferencesSync(mediaId);
  }

  /** 事务内引用计数（与事务外读取共用同一 SQL，保持语义一致）。 */
  private countMediaReferencesSync(mediaId: string): MediaReferenceCounts {
    const published = this.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM content_items
      WHERE status = 'published' AND (media_id = ? OR cover_media_id = ?)
    `).get(mediaId, mediaId) as unknown as { count: number };
    const knowledge = this.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM agent_knowledge_items
      WHERE status = 'enabled' AND source_media_id = ?
    `).get(mediaId) as unknown as { count: number };
    return {
      publishedResources: published.count,
      enabledKnowledge: knowledge.count,
      // 方案引用的是视频内容（content_items），不直接引用素材。
      enabledPlans: 0
    };
  }

  /** 事务内素材读取（与 findMedia 同 SQL）。 */
  private findMediaSync(id: string): MediaRow | undefined {
    return this.database.connection.prepare(`
      SELECT id, kind, filename, stored_path, size_bytes, mime_type, sha256,
             status, failure_reason, created_by, created_at, updated_at
      FROM content_resource_media WHERE id = ?
    `).get(id) as unknown as MediaRow | undefined;
  }

  // ---- 站内公告 ----

  async listMessages(status?: ContentMessageRow["status"]): Promise<ContentMessageRow[]> {
    const rows = this.database.connection.prepare(`
      SELECT id, title, body, summary, category_id, status, revision,
             published_at, created_by, created_at, updated_at
      FROM content_messages
      ${status === undefined ? "" : "WHERE status = ?"}
      ORDER BY updated_at DESC, id ASC
    `).all(...(status === undefined ? [] : [status])) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  async findMessage(id: string): Promise<ContentMessageRow | null> {
    const row = this.database.connection.prepare(`
      SELECT id, title, body, summary, category_id, status, revision,
             published_at, created_by, created_at, updated_at
      FROM content_messages WHERE id = ?
    `).get(id) as unknown as MessageRow | undefined;
    return row === undefined ? null : toMessage(row);
  }

  async createMessage(input: {
    id: string;
    title: string;
    body: string;
    summary: string | null;
    categoryId: string | null;
    status: ContentMessageRow["status"];
    revision: number;
    publishedAt: string | null;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  }): Promise<void> {
    this.database.connection.prepare(`
      INSERT INTO content_messages(
        id, title, body, summary, category_id, status, revision,
        published_at, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.title,
      input.body,
      input.summary,
      input.categoryId,
      input.status,
      input.revision,
      input.publishedAt,
      input.createdBy,
      input.createdAt,
      input.updatedAt
    );
  }

  async updateMessage(
    message: ContentMessageRow,
    expectedRevision: number
  ): Promise<UpdateMessageResult> {
    return this.database.transaction(() => {
      const current = this.database.connection.prepare(
        "SELECT revision FROM content_messages WHERE id = ?"
      ).get(message.id) as unknown as { revision: number } | undefined;
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const result = this.database.connection.prepare(`
        UPDATE content_messages SET
          title = ?, body = ?, summary = ?, category_id = ?,
          status = ?, published_at = ?, updated_at = ?, revision = ?
        WHERE id = ? AND revision = ?
      `).run(
        message.title,
        message.body,
        message.summary,
        message.categoryId,
        message.status,
        message.publishedAt,
        message.updatedAt,
        message.revision,
        message.id,
        expectedRevision
      );
      if (result.changes !== 1) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      return { kind: "updated" as const, message };
    });
  }

  async setMessageStatus(
    id: string,
    expectedRevision: number,
    status: ContentMessageRow["status"],
    publishedAt: string | null,
    updatedAt: string
  ): Promise<UpdateMessageResult> {
    return this.database.transaction(() => {
      const current = this.database.connection.prepare(
        "SELECT revision FROM content_messages WHERE id = ?"
      ).get(id) as unknown as { revision: number } | undefined;
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const result = this.database.connection.prepare(`
        UPDATE content_messages
        SET status = ?, published_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
      `).run(status, publishedAt, updatedAt, id, expectedRevision);
      if (result.changes !== 1) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const updated = this.database.connection.prepare(`
        SELECT id, title, body, summary, category_id, status, revision,
               published_at, created_by, created_at, updated_at
        FROM content_messages WHERE id = ?
      `).get(id) as unknown as MessageRow;
      return { kind: "updated" as const, message: toMessage(updated) };
    });
  }
}
