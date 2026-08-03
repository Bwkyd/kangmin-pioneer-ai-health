import type { PoolClient } from "pg";

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
  MediaStatus,
  UpdateMessageResult
} from "../../modules/admin/content-aux-repository.js";
import { isUniqueViolation, KangminPgDatabase } from "./pg-database.js";
import { runPgIdempotentCreate } from "./pg-idempotency.js";

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

const CATEGORY_COLUMNS = `
  id, name, kind, description, display_order, status, revision, created_at, updated_at
`;

const MEDIA_COLUMNS = `
  id, kind, filename, stored_path, size_bytes, mime_type, sha256,
  status, failure_reason, created_by, created_at, updated_at
`;

const MESSAGE_COLUMNS = `
  id, title, body, summary, category_id, status, revision,
  published_at, created_by, created_at, updated_at
`;

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

export class PgContentAuxRepository implements ContentAuxRepository {
  constructor(private readonly database: KangminPgDatabase) {}

  // ---- 分类 ----

  async listCategories(kind?: ContentCategoryRow["kind"]): Promise<ContentCategoryRow[]> {
    const { rows } = await this.database.query<CategoryRow>(
      `SELECT ${CATEGORY_COLUMNS}
       FROM content_categories
       ${kind === undefined ? "" : "WHERE kind = $1"}
       ORDER BY display_order ASC, name ASC`,
      kind === undefined ? [] : [kind]
    );
    return rows.map(toCategory);
  }

  async findCategoryById(id: string): Promise<ContentCategoryRow | null> {
    const { rows } = await this.database.query<CategoryRow>(
      `SELECT ${CATEGORY_COLUMNS}
       FROM content_categories WHERE id = $1`,
      [id]
    );
    const row = rows[0];
    return row === undefined ? null : toCategory(row);
  }

  async findCategoryByName(name: string): Promise<ContentCategoryRow | null> {
    const { rows } = await this.database.query<CategoryRow>(
      `SELECT ${CATEGORY_COLUMNS}
       FROM content_categories WHERE name = $1`,
      [name]
    );
    const row = rows[0];
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
    return this.database.transaction(async (client) => {
      // SQLite 版捕获 UNIQUE 约束错误映射为 name_taken；PG 版用
      // ON CONFLICT DO NOTHING + rowCount 表达同一语义（name 或 id
      // 任一唯一冲突都归入 name_taken），避免事务进入中止状态。
      const { rowCount } = await this.database.queryIn(
        client,
        `INSERT INTO content_categories(id, name, kind, description, display_order, status, revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [
          input.id,
          input.name,
          input.kind,
          input.description,
          input.displayOrder,
          input.revision,
          input.createdAt,
          input.updatedAt
        ]
      );
      return rowCount === 1 ? "created" : "name_taken";
    });
  }

  async updateCategory(
    id: string,
    expectedRevision: number,
    changes: Partial<Pick<ContentCategoryRow, "name" | "description" | "displayOrder" | "kind">>,
    updatedAt: string
  ): Promise<"updated" | "not_found" | "version_conflict" | "name_taken"> {
    return this.database.transaction(async (client) => {
      const { rows } = await this.database.queryIn<{
        revision: number;
        status: string;
      }>(
        client,
        "SELECT revision, status FROM content_categories WHERE id = $1",
        [id]
      );
      const current = rows[0];
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
        const { rowCount } = await this.database.queryIn(
          client,
          `UPDATE content_categories SET
            name = COALESCE($1, name),
            kind = COALESCE($2, kind),
            description = COALESCE($3, description),
            display_order = COALESCE($4, display_order),
            updated_at = $5, revision = revision + 1
          WHERE id = $6`,
          [
            changes.name ?? null,
            changes.kind ?? null,
            changes.description === undefined ? null : changes.description,
            changes.displayOrder ?? null,
            updatedAt,
            id
          ]
        );
        if (rowCount !== 1) {
          return "version_conflict";
        }
        return "updated";
      } catch (error) {
        if (isUniqueViolation(error)) {
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
    return this.database.transaction(async (client) => {
      const { rows } = await this.database.queryIn<{
        revision: number;
        status: string;
      }>(
        client,
        "SELECT revision, status FROM content_categories WHERE id = $1",
        [id]
      );
      const current = rows[0];
      if (current === undefined) {
        return "not_found";
      }
      if (current.status === "disabled") {
        return "version_conflict";
      }
      if (current.revision !== expectedRevision) {
        return "version_conflict";
      }
      const { rowCount } = await this.database.queryIn(
        client,
        `UPDATE content_categories
         SET status = 'disabled', updated_at = $1, revision = revision + 1
         WHERE id = $2`,
        [updatedAt, id]
      );
      if (rowCount !== 1) {
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
    await this.database.query(
      `INSERT INTO content_resource_media(
        id, kind, filename, stored_path, size_bytes, mime_type, sha256,
        status, failure_reason, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
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
      ]
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
    return this.database.transaction(async (client) => {
      const outcome = await runPgIdempotentCreate(this.database, client, {
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
        verifyExists: async (json) => {
          const { rows } = await this.database.queryIn(
            client,
            "SELECT id FROM content_resource_media WHERE id = $1",
            [(JSON.parse(json) as ContentMediaRow).id]
          );
          return rows[0] !== undefined;
        },
        insert: async () => {
          await this.database.queryIn(
            client,
            `INSERT INTO content_resource_media(
              id, kind, filename, stored_path, size_bytes, mime_type, sha256,
              status, failure_reason, created_by, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
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
            ]
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
    const row = await this.findMediaRow(this.database, id);
    return row === undefined ? null : toMedia(row);
  }

  async listMedia(): Promise<ContentMediaRow[]> {
    const { rows } = await this.database.query<MediaRow>(
      `SELECT ${MEDIA_COLUMNS}
       FROM content_resource_media
       ORDER BY created_at DESC, id ASC`
    );
    return rows.map(toMedia);
  }

  /**
   * 引用检查与停用写入同一事务（评审 C 事务变式）：SQLite 版靠
   * BEGIN IMMEDIATE 持写锁消除"countMediaReferences 检查 →
   * setMediaStatus 提交"之间的竞态窗口；PG 版在同一事务内完成检查
   * 与写入（与发布校验 updateGuarded 同类）。
   */
  async disableMediaGuarded(
    id: string,
    updatedAt: string,
    guard: (counts: MediaReferenceCounts) => string[]
  ): Promise<GuardedMediaUpdateResult> {
    return this.database.transaction(async (client) => {
      const media = await this.findMediaIn(client, id);
      if (media === undefined) {
        return { kind: "not_found" as const };
      }
      const missing = guard(await this.countMediaReferencesIn(client, id));
      if (missing.length > 0) {
        return { kind: "validation_failed" as const, missing };
      }
      await this.database.queryIn(
        client,
        `UPDATE content_resource_media
         SET status = 'disabled', failure_reason = NULL, updated_at = $1
         WHERE id = $2`,
        [updatedAt, id]
      );
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
    return this.database.transaction(async (client) => {
      const media = await this.findMediaIn(client, id);
      if (media === undefined) {
        return { kind: "not_found" as const };
      }
      const missing = guard(await this.countMediaReferencesIn(client, id));
      if (missing.length > 0) {
        return { kind: "validation_failed" as const, missing };
      }
      // 这里清除草稿/下架内容与非启用知识的引用，避免外键约束阻断删除
      // （删除只断引用不断内容）。
      await this.database.queryIn(
        client,
        `UPDATE content_items
         SET media_id = NULL, cover_media_id = NULL
         WHERE (media_id = $1 OR cover_media_id = $2) AND status != 'published'`,
        [id, id]
      );
      await this.database.queryIn(
        client,
        `UPDATE agent_knowledge_items SET source_media_id = NULL
         WHERE source_media_id = $1`,
        [id]
      );
      await this.database.queryIn(
        client,
        "DELETE FROM content_resource_media WHERE id = $1",
        [id]
      );
      return { kind: "deleted" as const };
    });
  }

  async countMediaReferences(mediaId: string): Promise<MediaReferenceCounts> {
    // COUNT(*) 在 PG 返回 int8（node-pg 解析为 string），::int 强转保持
    // 与 SQLite 的 number 语义一致。
    const published = await this.database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM content_items
       WHERE status = 'published' AND (media_id = $1 OR cover_media_id = $2)`,
      [mediaId, mediaId]
    );
    const knowledge = await this.database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM agent_knowledge_items
       WHERE status = 'enabled' AND source_media_id = $1`,
      [mediaId]
    );
    return {
      publishedResources: published.rows[0]?.count ?? 0,
      enabledKnowledge: knowledge.rows[0]?.count ?? 0,
      // 方案引用的是视频内容（content_items），不直接引用素材。
      enabledPlans: 0
    };
  }

  // ---- 远程上传会话 ----

  /**
   * 按内容指纹查素材（上传会话去重）：ready 优先、processing 其次，
   * 排序语义与 SQLite 版一致。
   */
  async findMediaBySha256(sha256: string): Promise<ContentMediaRow | null> {
    const { rows } = await this.database.query<MediaRow>(
      `SELECT ${MEDIA_COLUMNS}
       FROM content_resource_media
       WHERE sha256 = $1
       ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
                created_at DESC, id ASC
       LIMIT 1`,
      [sha256]
    );
    const row = rows[0];
    return row === undefined ? null : toMedia(row);
  }

  /** 远程上传会话草稿：status=processing 直入，不写幂等表。 */
  async createMediaDraft(
    adminId: string,
    media: ContentMediaRow
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO content_resource_media(
        id, kind, filename, stored_path, size_bytes, mime_type, sha256,
        status, failure_reason, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
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
      ]
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
    return this.database.transaction(async (client) => {
      const { rows } = await this.database.queryIn<{ status: string }>(
        client,
        "SELECT status FROM content_resource_media WHERE id = $1",
        [id]
      );
      if (rows[0] === undefined) {
        return "not_found";
      }
      const { rowCount } = await this.database.queryIn(
        client,
        `UPDATE content_resource_media
         SET status = $1, failure_reason = $2, updated_at = $3
         WHERE id = $4 AND status = $5`,
        [next.status, next.failureReason, next.updatedAt, id, expectedStatus]
      );
      return rowCount === 1 ? "updated" : "version_conflict";
    });
  }

  /** 孤儿上传会话：status=processing 且 updated_at 早于阈值的行。 */
  async listStaleProcessingMedia(cutoffIso: string): Promise<ContentMediaRow[]> {
    const { rows } = await this.database.query<MediaRow>(
      `SELECT ${MEDIA_COLUMNS}
       FROM content_resource_media
       WHERE status = 'processing' AND updated_at < $1
       ORDER BY updated_at ASC, id ASC`,
      [cutoffIso]
    );
    return rows.map(toMedia);
  }

  /** 物理删除素材行（孤儿清理专用；无引用守卫，调用方限定 processing 行）。 */
  async deleteMediaRow(id: string): Promise<void> {
    await this.database.query(
      "DELETE FROM content_resource_media WHERE id = $1",
      [id]
    );
  }

  /** 事务内引用计数（与事务外读取共用同一 SQL，保持语义一致）。 */
  private async countMediaReferencesIn(
    client: PoolClient,
    mediaId: string
  ): Promise<MediaReferenceCounts> {
    const published = await this.database.queryIn<{ count: number }>(
      client,
      `SELECT COUNT(*)::int AS count FROM content_items
       WHERE status = 'published' AND (media_id = $1 OR cover_media_id = $2)`,
      [mediaId, mediaId]
    );
    const knowledge = await this.database.queryIn<{ count: number }>(
      client,
      `SELECT COUNT(*)::int AS count FROM agent_knowledge_items
       WHERE status = 'enabled' AND source_media_id = $1`,
      [mediaId]
    );
    return {
      publishedResources: published.rows[0]?.count ?? 0,
      enabledKnowledge: knowledge.rows[0]?.count ?? 0,
      // 方案引用的是视频内容（content_items），不直接引用素材。
      enabledPlans: 0
    };
  }

  /** 事务内素材读取（与 findMedia 同 SQL）。 */
  private async findMediaIn(
    client: PoolClient,
    id: string
  ): Promise<MediaRow | undefined> {
    const { rows } = await this.database.queryIn<MediaRow>(
      client,
      `SELECT ${MEDIA_COLUMNS}
       FROM content_resource_media WHERE id = $1`,
      [id]
    );
    return rows[0];
  }

  /** 事务外素材读取（与事务内 findMediaIn 同 SQL）。 */
  private async findMediaRow(
    database: KangminPgDatabase,
    id: string
  ): Promise<MediaRow | undefined> {
    const { rows } = await database.query<MediaRow>(
      `SELECT ${MEDIA_COLUMNS}
       FROM content_resource_media WHERE id = $1`,
      [id]
    );
    return rows[0];
  }

  // ---- 站内公告 ----

  async listMessages(status?: ContentMessageRow["status"]): Promise<ContentMessageRow[]> {
    const { rows } = await this.database.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       FROM content_messages
       ${status === undefined ? "" : "WHERE status = $1"}
       ORDER BY updated_at DESC, id ASC`,
      status === undefined ? [] : [status]
    );
    return rows.map(toMessage);
  }

  async findMessage(id: string): Promise<ContentMessageRow | null> {
    const { rows } = await this.database.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       FROM content_messages WHERE id = $1`,
      [id]
    );
    const row = rows[0];
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
    await this.database.query(
      `INSERT INTO content_messages(
        id, title, body, summary, category_id, status, revision,
        published_at, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
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
      ]
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
    return this.database.transaction(async (client) => {
      const outcome = await runPgIdempotentCreate(this.database, client, {
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
        verifyExists: async (json) => {
          const { rows } = await this.database.queryIn(
            client,
            "SELECT id FROM content_messages WHERE id = $1",
            [(JSON.parse(json) as ContentMessageRow).id]
          );
          return rows[0] !== undefined;
        },
        insert: async () => {
          await this.database.queryIn(
            client,
            `INSERT INTO content_messages(
              id, title, body, summary, category_id, status, revision,
              published_at, created_by, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
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
            ]
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
    return this.database.transaction(async (client) => {
      const current = await this.messageRevision(client, message.id);
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const { rowCount } = await this.database.queryIn(
        client,
        `UPDATE content_messages SET
          title = $1, body = $2, summary = $3, category_id = $4,
          status = $5, published_at = $6, updated_at = $7, revision = $8
        WHERE id = $9 AND revision = $10`,
        [
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
        ]
      );
      if (rowCount !== 1) {
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
    return this.database.transaction(async (client) => {
      const current = await this.messageRevision(client, id);
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const { rowCount } = await this.database.queryIn(
        client,
        `UPDATE content_messages
         SET status = $1, published_at = $2, updated_at = $3, revision = revision + 1
         WHERE id = $4 AND revision = $5`,
        [status, publishedAt, updatedAt, id, expectedRevision]
      );
      if (rowCount !== 1) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const { rows } = await this.database.queryIn<MessageRow>(
        client,
        `SELECT ${MESSAGE_COLUMNS}
         FROM content_messages WHERE id = $1`,
        [id]
      );
      const updated = rows[0];
      if (updated === undefined) {
        // 刚更新成功的行同事务内必然可读；防御性分支，结构上不可达。
        return { kind: "not_found" as const };
      }
      return { kind: "updated" as const, message: toMessage(updated) };
    });
  }

  /** 事务内读取公告当前修订（CAS 前置判定）。 */
  private async messageRevision(
    client: PoolClient,
    id: string
  ): Promise<{ revision: number } | undefined> {
    const { rows } = await this.database.queryIn<{ revision: number }>(
      client,
      "SELECT revision FROM content_messages WHERE id = $1",
      [id]
    );
    return rows[0];
  }
}
