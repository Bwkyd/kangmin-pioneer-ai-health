import { randomUUID } from "node:crypto";

import { KangminDatabase } from "./database.js";
import type { AuditEntry, AuditPort } from "@kangmin/core/operations/system/audit-ports";

/**
 * audit_events 的 SQLite 实现：只追加，独立事务。
 *
 * 强制审计（外部评审 P1-3）：record 失败直接抛错，调用方命令失败，
 * 绝不静默丢弃强制审计；如确有观测性降级需求，由调用方显式 try/catch。
 */
export class SqliteAuditRepository implements AuditPort {
  constructor(private readonly database: KangminDatabase) {}

  async record(entry: AuditEntry): Promise<void> {
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO audit_events(
            id, actor_kind, actor_id, action,
            entity_type, entity_id, entity_revision,
            request_id, details_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          randomUUID(),
          entry.actorKind,
          entry.actorId,
          entry.action,
          entry.entityType,
          entry.entityId,
          entry.entityRevision ?? null,
          entry.requestId ?? null,
          JSON.stringify(entry.details),
          new Date().toISOString()
        );
    });
  }
}
