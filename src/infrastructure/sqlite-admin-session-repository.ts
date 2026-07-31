import { KangminDatabase } from "./database.js";
import type {
  AdminSessionRepository,
  AdminSessionWithAccount
} from "../modules/admin/admin-session-repository.js";

export class SqliteAdminSessionRepository implements AdminSessionRepository {
  constructor(private readonly database: KangminDatabase) {}

  async find(tokenHash: string) {
    const row = this.database.connection.prepare(`
      SELECT sessions.admin_id, sessions.expires_at
      FROM admin_sessions AS sessions
      JOIN admin_accounts ON admin_accounts.id = sessions.admin_id
      WHERE sessions.token_hash = ?
        AND admin_accounts.status = 'active'
        AND sessions.revoked_at IS NULL
    `).get(tokenHash) as unknown as { admin_id: string; expires_at: string } | undefined;
    return row === undefined ? null : { adminId: row.admin_id, expiresAt: row.expires_at };
  }

  async findWithAccount(tokenHash: string): Promise<AdminSessionWithAccount | null> {
    const row = this.database.connection.prepare(`
      SELECT sessions.admin_id, admin_accounts.role, admin_accounts.username,
             sessions.expires_at, admin_accounts.status
      FROM admin_sessions AS sessions
      JOIN admin_accounts ON admin_accounts.id = sessions.admin_id
      WHERE sessions.token_hash = ?
        AND sessions.revoked_at IS NULL
    `).get(tokenHash) as unknown as {
      admin_id: string;
      role: "owner" | "admin";
      username: string;
      expires_at: string;
      status: "active" | "disabled";
    } | undefined;
    return row === undefined
      ? null
      : {
          adminId: row.admin_id,
          role: row.role,
          username: row.username,
          expiresAt: row.expires_at,
          status: row.status
        };
  }

  async save(input: {
    subject: string; newAdminId: string; tokenHash: string;
    expiresAt: string; createdAt: string;
  }): Promise<string> {
    return this.database.transaction(() => {
      // admins 镜像消除（评审 A P1-5）：dev 会话不再写废弃的 admins 表，
      // 只写 admin_accounts 占位行（占位密码 login 拒绝），
      // 保证 find() 的 JOIN admin_accounts 始终成立。
      const existing = this.database.connection.prepare(
        "SELECT id FROM admin_accounts WHERE username = ?"
      ).get(input.subject) as unknown as { id: string } | undefined;
      const adminId = existing?.id ?? input.newAdminId;
      if (existing === undefined) {
        this.database.connection.prepare(`
          INSERT INTO admin_accounts(
            id, username, password_hash, role, status,
            revision, created_at, updated_at
          ) VALUES (?, ?, '!dev-session-only', 'owner', 'active', 1, ?, ?)
        `).run(adminId, input.subject, input.createdAt, input.createdAt);
      }
      this.database.connection.prepare(`
        INSERT OR REPLACE INTO admin_sessions(token_hash, admin_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(input.tokenHash, adminId, input.expiresAt, input.createdAt);
      return adminId;
    });
  }

  async createSession(input: {
    adminId: string; tokenHash: string; expiresAt: string; createdAt: string;
  }): Promise<void> {
    this.database.connection.prepare(`
      INSERT INTO admin_sessions(token_hash, admin_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.tokenHash, input.adminId, input.expiresAt, input.createdAt);
  }

  async revoke(tokenHash: string, revokedAt: string, reason: string): Promise<void> {
    this.database.connection.prepare(`
      UPDATE admin_sessions SET revoked_at = ?, revoked_reason = ?
      WHERE token_hash = ?
    `).run(revokedAt, reason, tokenHash);
  }

  async revokeAllForAdmin(
    adminId: string,
    revokedAt: string,
    reason: string
  ): Promise<number> {
    const result = this.database.connection.prepare(`
      UPDATE admin_sessions SET revoked_at = ?, revoked_reason = ?
      WHERE admin_id = ? AND revoked_at IS NULL
    `).run(revokedAt, reason, adminId);
    return Number(result.changes);
  }
}
