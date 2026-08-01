import { randomUUID } from "node:crypto";

import type { AuditEntry, AuditPort } from "../../modules/system/audit-ports.js";
import { KangminPgDatabase } from "./pg-database.js";

/**
 * audit_events 的 PostgreSQL 实现：只追加，独立事务。
 *
 * 强制审计（外部评审 P1-3）：record 失败直接抛错，调用方命令失败，
 * 绝不静默丢弃强制审计；如确有观测性降级需求，由调用方显式 try/catch。
 */
export class PgAuditRepository implements AuditPort {
  constructor(private readonly database: KangminPgDatabase) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.database.transaction(async (client) => {
      await this.database.queryIn(
        client,
        `INSERT INTO audit_events(
          id, actor_kind, actor_id, action,
          entity_type, entity_id, entity_revision,
          request_id, details_json, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
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
        ]
      );
    });
  }
}
