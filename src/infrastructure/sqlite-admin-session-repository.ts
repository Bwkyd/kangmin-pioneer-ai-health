import { KangminDatabase } from "./database.js";
import type { AdminSessionRepository } from "../modules/admin/admin-session-repository.js";

export class SqliteAdminSessionRepository implements AdminSessionRepository {
  constructor(private readonly database: KangminDatabase) {}

  async find(tokenHash: string) {
    const row = this.database.connection.prepare(`
      SELECT sessions.admin_id, sessions.expires_at
      FROM admin_sessions AS sessions
      JOIN admins ON admins.id = sessions.admin_id
      WHERE sessions.token_hash = ? AND admins.enabled = 1
    `).get(tokenHash) as unknown as { admin_id: string; expires_at: string } | undefined;
    return row === undefined ? null : { adminId: row.admin_id, expiresAt: row.expires_at };
  }

  async save(input: {
    subject: string; newAdminId: string; tokenHash: string;
    expiresAt: string; createdAt: string;
  }): Promise<string> {
    return this.database.transaction(() => {
      const existing = this.database.connection.prepare(
        "SELECT id FROM admins WHERE development_subject = ?"
      ).get(input.subject) as unknown as { id: string } | undefined;
      const adminId = existing?.id ?? input.newAdminId;
      if (existing === undefined) {
        this.database.connection.prepare(`
          INSERT INTO admins(id, development_subject, role, enabled, created_at)
          VALUES (?, ?, 'owner', 1, ?)
        `).run(adminId, input.subject, input.createdAt);
      }
      this.database.connection.prepare(`
        INSERT OR REPLACE INTO admin_sessions(token_hash, admin_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(input.tokenHash, adminId, input.expiresAt, input.createdAt);
      return adminId;
    });
  }
}
