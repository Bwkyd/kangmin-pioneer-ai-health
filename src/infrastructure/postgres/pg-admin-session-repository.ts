import type {
  AdminSessionRepository,
  AdminSessionWithAccount
} from "@kangmin/core/operations/admin/admin-session-repository";
import { KangminPgDatabase } from "./pg-database.js";

export class PgAdminSessionRepository implements AdminSessionRepository {
  constructor(private readonly database: KangminPgDatabase) {}

  async find(tokenHash: string) {
    const { rows } = await this.database.query<{
      admin_id: string;
      expires_at: string;
    }>(
      `SELECT sessions.admin_id, sessions.expires_at
      FROM admin_sessions AS sessions
      JOIN admin_accounts ON admin_accounts.id = sessions.admin_id
      WHERE sessions.token_hash = $1
        AND admin_accounts.status = 'active'
        AND sessions.revoked_at IS NULL`,
      [tokenHash]
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { adminId: row.admin_id, expiresAt: row.expires_at };
  }

  async findWithAccount(
    tokenHash: string
  ): Promise<AdminSessionWithAccount | null> {
    // 与 SQLite 版一致：此处不过滤账号 status——禁用账号的会话仍要返回
    // status，由服务端做二次校验；活跃性过滤只在 find() 中做。
    const { rows } = await this.database.query<{
      admin_id: string;
      role: "owner" | "admin";
      username: string;
      expires_at: string;
      status: "active" | "disabled";
    }>(
      `SELECT sessions.admin_id, admin_accounts.role, admin_accounts.username,
             sessions.expires_at, admin_accounts.status
      FROM admin_sessions AS sessions
      JOIN admin_accounts ON admin_accounts.id = sessions.admin_id
      WHERE sessions.token_hash = $1
        AND sessions.revoked_at IS NULL`,
      [tokenHash]
    );
    const row = rows[0];
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
    return this.database.transaction(async (client) => {
      // admins 镜像消除（评审 A P1-5）：dev 会话不再写废弃的 admins 表，
      // 只写 admin_accounts 占位行（占位密码 login 拒绝），
      // 保证 find() 的 JOIN admin_accounts 始终成立。
      const existing = await this.database.queryIn<{ id: string }>(
        client,
        "SELECT id FROM admin_accounts WHERE username = $1",
        [input.subject]
      );
      const adminId = existing.rows[0]?.id ?? input.newAdminId;
      if (existing.rows[0] === undefined) {
        await this.database.queryIn(
          client,
          `INSERT INTO admin_accounts(
            id, username, password_hash, role, status,
            revision, created_at, updated_at
          ) VALUES ($1, $2, '!dev-session-only', 'owner', 'active', 1, $3, $3)`,
          [adminId, input.subject, input.createdAt]
        );
      }
      // 事务与卫生残留批 P2-11：同 patient_sessions——不用 INSERT OR
      // REPLACE，避免同 token 再存复活已撤销会话；ON CONFLICT DO NOTHING
      // 保留原有行（含 revoked 标记），撤销语义不被绕过。
      await this.database.queryIn(
        client,
        `INSERT INTO admin_sessions(token_hash, admin_id, expires_at, created_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(token_hash) DO NOTHING`,
        [input.tokenHash, adminId, input.expiresAt, input.createdAt]
      );
      return adminId;
    });
  }

  async createSession(input: {
    adminId: string; tokenHash: string; expiresAt: string; createdAt: string;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO admin_sessions(token_hash, admin_id, expires_at, created_at)
      VALUES ($1, $2, $3, $4)`,
      [input.tokenHash, input.adminId, input.expiresAt, input.createdAt]
    );
  }

  async revoke(
    tokenHash: string,
    revokedAt: string,
    reason: string
  ): Promise<void> {
    await this.database.query(
      `UPDATE admin_sessions SET revoked_at = $1, revoked_reason = $2
      WHERE token_hash = $3`,
      [revokedAt, reason, tokenHash]
    );
  }

  async revokeAllForAdmin(
    adminId: string,
    revokedAt: string,
    reason: string
  ): Promise<number> {
    const { rowCount } = await this.database.query(
      `UPDATE admin_sessions SET revoked_at = $1, revoked_reason = $2
      WHERE admin_id = $3 AND revoked_at IS NULL`,
      [revokedAt, reason, adminId]
    );
    return rowCount;
  }
}
