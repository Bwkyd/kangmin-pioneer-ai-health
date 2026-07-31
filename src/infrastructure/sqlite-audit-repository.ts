import { randomUUID } from "node:crypto";

import { KangminDatabase } from "./database.js";
import type { AuditEntry, AuditPort } from "../modules/system/audit-ports.js";

/** audit_events 的 SQLite 实现：只追加，独立事务，失败不阻断主操作。 */
export class SqliteAuditRepository implements AuditPort {
  constructor(private readonly database: KangminDatabase) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
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
    } catch {
      // 审计失败不阻断业务主操作（审计是观测，不是业务前置条件）；
      // 调用方自行决定是否需要告警。
    }
  }
}
