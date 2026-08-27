import { KangminDatabase } from "./database.js";
import { runIdempotentCreate } from "../shared/idempotency.js";
import type {
  ContentAuxRepository,
  ContentCategoryRow,
  ContentMediaRow,
  ContentMessageRow,
  GuardedMediaDeleteResult,
  GuardedMediaUpdateResult,
  IdempotentCreateResult,
  MediaKind,
  MediaReferenceCounts,
  MediaReferenceRow,
  MediaStatus,
  UpdateMessageResult
} from "@kangmin/core/operations/admin/content-aux-repository";

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

  /**
   * 幂等创建素材（事务与卫生残留批 P2-7）：素材行 + 幂等行同一事务；
   * 幂等键为文件内容指纹，同文件重传 → 重放返回原素材。
   */
  async createMediaIdempotent(
    adminId: string,
    media: ContentMediaRow,
    idempotencyKey: string,
    requestHash: string
  ): Promise<IdempotentCreateResult<ContentMediaRow>> {
    return this.database.transaction(() => {
      const outcome = runIdempotentCreate(this.database.connection, {
        table: "admin_idempotency",
        actorColumn: "admin_id",
        scopeColumn: "scope",
        keyColumn: "idempotency_key",
        actorId: adminId,
        scope: "content.media.upload",
        key: idempotencyKey,
        requestHash,
        resultJson: JSON.stringify(media),
        createdAt: media.createdAt,
        verifyExists: (json) =>
          this.database.connection.prepare(
            "SELECT id FROM content_resource_media WHERE id = ?"
          ).get((JSON.parse(json) as ContentMediaRow).id) !== undefined,
        insert: () => {
          this.database.connection.prepare(`
            INSERT INTO content_resource_media(
              id, kind, filename, stored_path, size_bytes, mime_type, sha256,
              status, failure_reason, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            media.id,
            media.kind,
            media.filename,
            media.storedPath,
            media.sizeBytes,
            media.mimeType,
            media.sha256,
            media.status,
            media.failureReason,
            media.createdBy,
            media.createdAt,
            media.updatedAt
          );
        }
      });
      switch (outcome.kind) {
        case "created":
          return { kind: "created" as const, item: media };
        case "replayed":
          return {
            kind: "replayed" as const,
            item: JSON.parse(outcome.resultJson) as ContentMediaRow
          };
        case "stale_replay":
          return { kind: "stale_replay" as const };
        case "idempotency_conflict":
          return { kind: "conflict" as const };
        case "date_conflict":
          // 管理端未启用 date_conflict 语义，结构上不可达；归入冲突。
          return { kind: "conflict" as const };
      }
    });
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

  async listMediaReferences(): Promise<MediaReferenceRow[]> {
    return this.database.connection.prepare(`
      SELECT media_id AS mediaId, kind AS entityType, id AS entityId,
             title AS name, status, 'file' AS role
      FROM content_items WHERE media_id IS NOT NULL
      UNION ALL
      SELECT cover_media_id, kind, id, title, status, 'cover'
      FROM content_items WHERE cover_media_id IS NOT NULL
      UNION ALL
      SELECT media.id, item.kind, item.id, item.title, item.status, 'body'
      FROM content_resource_media media
      JOIN content_items item
        ON instr(COALESCE(item.body, ''), '/v1/media/' || media.id) > 0
      UNION ALL
      SELECT source_media_id, 'knowledge', id, name, status, 'knowledge_source'
      FROM agent_knowledge_items WHERE source_media_id IS NOT NULL
      ORDER BY mediaId ASC, entityType ASC, entityId ASC, role ASC
    `).all() as unknown as MediaReferenceRow[];
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
   * 引用检查与删除同一事务：任一状态的引用由 guard 拦截；无引用时
   * 直接删除文件行，不静默修改文章、视频或知识实体。
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
      this.database.connection.prepare(
        "DELETE FROM content_resource_media WHERE id = ?"
      ).run(id);
      return { kind: "deleted" as const };
    });
  }

  async countMediaReferences(mediaId: string): Promise<MediaReferenceCounts> {
    return this.countMediaReferencesSync(mediaId);
  }

  // ---- 远程上传会话 ----

  /**
   * 按内容指纹查素材（上传会话去重）：ready 优先、processing 其次——
   * 同指纹多行时服务层按"ready 重放 / processing 重发票据 / 其余新建"
   * 判定，排序保证拿到可复用的那一行。
   */
  async findMediaBySha256(sha256: string): Promise<ContentMediaRow | null> {
    const row = this.database.connection.prepare(`
      SELECT id, kind, filename, stored_path, size_bytes, mime_type, sha256,
             status, failure_reason, created_by, created_at, updated_at
      FROM content_resource_media
      WHERE sha256 = ?
      ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
               created_at DESC, id ASC
      LIMIT 1
    `).get(sha256) as unknown as MediaRow | undefined;
    return row === undefined ? null : toMedia(row);
  }

  /** 远程上传会话草稿：status=processing 直入，不写幂等表。 */
  async createMediaDraft(
    adminId: string,
    media: ContentMediaRow
  ): Promise<void> {
    this.database.connection.prepare(`
      INSERT INTO content_resource_media(
        id, kind, filename, stored_path, size_bytes, mime_type, sha256,
        status, failure_reason, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      media.id,
      media.kind,
      media.filename,
      media.storedPath,
      media.sizeBytes,
      media.mimeType,
      media.sha256,
      media.status,
      media.failureReason,
      media.createdBy ?? adminId,
      media.createdAt,
      media.updatedAt
    );
  }

  /**
   * 素材状态 CAS 流转：UPDATE 带状态谓词（expectedStatus），谓词不命中
   * （并发流转）返回 version_conflict；行不存在返回 not_found。
   */
  async transitionMediaStatus(
    id: string,
    expectedStatus: MediaStatus,
    next: {
      status: MediaStatus;
      failureReason: string | null;
      updatedAt: string;
    }
  ): Promise<"updated" | "not_found" | "version_conflict"> {
    return this.database.transaction(() => {
      const current = this.database.connection.prepare(
        "SELECT status FROM content_resource_media WHERE id = ?"
      ).get(id) as unknown as { status: string } | undefined;
      if (current === undefined) {
        return "not_found";
      }
      const result = this.database.connection.prepare(`
        UPDATE content_resource_media
        SET status = ?, failure_reason = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `).run(next.status, next.failureReason, next.updatedAt, id, expectedStatus);
      return result.changes === 1 ? "updated" : "version_conflict";
    });
  }

  /** 孤儿上传会话：status=processing 且 updated_at 早于阈值的行。 */
  async listStaleProcessingMedia(cutoffIso: string): Promise<ContentMediaRow[]> {
    const rows = this.database.connection.prepare(`
      SELECT id, kind, filename, stored_path, size_bytes, mime_type, sha256,
             status, failure_reason, created_by, created_at, updated_at
      FROM content_resource_media
      WHERE status = 'processing' AND updated_at < ?
      ORDER BY updated_at ASC, id ASC
    `).all(cutoffIso) as unknown as MediaRow[];
    return rows.map(toMedia);
  }

  /** 物理删除素材行（孤儿清理专用；无引用守卫，调用方限定 processing 行）。 */
  async deleteMediaRow(id: string): Promise<void> {
    this.database.connection.prepare(
      "DELETE FROM content_resource_media WHERE id = ?"
    ).run(id);
  }

  /** 事务内引用计数（含正文 Markdown 附件，与事务外读取共用同一 SQL）。 */
  private countMediaReferencesSync(mediaId: string): MediaReferenceCounts {
    const content = this.database.connection.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS active
      FROM content_items WHERE (
          media_id = ?
          OR cover_media_id = ?
          OR instr(COALESCE(body, ''), '/v1/media/' || ?) > 0
        )
    `).get(mediaId, mediaId, mediaId) as unknown as { total: number; active: number | null };
    const knowledge = this.database.connection.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'enabled' THEN 1 ELSE 0 END) AS active
      FROM agent_knowledge_items WHERE source_media_id = ?
    `).get(mediaId) as unknown as { total: number; active: number | null };
    return {
      contentResources: content.total,
      knowledgeItems: knowledge.total,
      publishedResources: content.active ?? 0,
      enabledKnowledge: knowledge.active ?? 0,
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

  /**
   * 幂等创建公告（事务与卫生残留批 P2-7）：公告行 + 幂等行同一事务；
   * 确定性键同内容重试 → 重放返回原公告，不重复创建。
   */
  async createMessageIdempotent(
    adminId: string,
    message: ContentMessageRow,
    idempotencyKey: string,
    requestHash: string
  ): Promise<IdempotentCreateResult<ContentMessageRow>> {
    return this.database.transaction(() => {
      const outcome = runIdempotentCreate(this.database.connection, {
        table: "admin_idempotency",
        actorColumn: "admin_id",
        scopeColumn: "scope",
        keyColumn: "idempotency_key",
        actorId: adminId,
        scope: "content.message.create",
        key: idempotencyKey,
        requestHash,
        resultJson: JSON.stringify(message),
        createdAt: message.createdAt,
        verifyExists: (json) =>
          this.database.connection.prepare(
            "SELECT id FROM content_messages WHERE id = ?"
          ).get((JSON.parse(json) as ContentMessageRow).id) !== undefined,
        insert: () => {
          this.database.connection.prepare(`
            INSERT INTO content_messages(
              id, title, body, summary, category_id, status, revision,
              published_at, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            message.id,
            message.title,
            message.body,
            message.summary,
            message.categoryId,
            message.status,
            message.revision,
            message.publishedAt,
            message.createdBy,
            message.createdAt,
            message.updatedAt
          );
        }
      });
      switch (outcome.kind) {
        case "created":
          return { kind: "created" as const, item: message };
        case "replayed":
          return {
            kind: "replayed" as const,
            item: JSON.parse(outcome.resultJson) as ContentMessageRow
          };
        case "stale_replay":
          return { kind: "stale_replay" as const };
        case "idempotency_conflict":
          return { kind: "conflict" as const };
        case "date_conflict":
          // 管理端未启用 date_conflict 语义，结构上不可达；归入冲突。
          return { kind: "conflict" as const };
      }
    });
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
