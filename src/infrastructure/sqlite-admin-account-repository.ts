import { KangminDatabase } from "./database.js";
import type {
  AdminAccountRepository,
  AdminAccountRow,
  CreateAdminAccountOutcome
} from "../modules/admin/admin-account-repository.js";
import type { AdminRole, AdminStatus } from "../modules/admin/admin-session-repository.js";

interface AccountRow {
  id: string;
  username: string;
  password_hash: string;
  role: "owner" | "admin";
  status: "active" | "disabled";
  revision: number;
  created_at: string;
  updated_at: string;
}

function map(row: AccountRow): AdminAccountRow {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const SELECT = `
  SELECT id, username, password_hash, role, status, revision, created_at, updated_at
  FROM admin_accounts
`;

export class SqliteAdminAccountRepository implements AdminAccountRepository {
  constructor(private readonly database: KangminDatabase) {}

  async countAll(): Promise<number> {
    const row = this.database.connection.prepare(
      "SELECT COUNT(*) AS count FROM admin_accounts"
    ).get() as unknown as { count: number };
    return row.count;
  }

  async countActiveOwners(): Promise<number> {
    const row = this.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM admin_accounts
      WHERE role = 'owner' AND status = 'active'
    `).get() as unknown as { count: number };
    return row.count;
  }

  async findById(id: string): Promise<AdminAccountRow | null> {
    const row = this.database.connection.prepare(
      `${SELECT} WHERE id = ?`
    ).get(id) as unknown as AccountRow | undefined;
    return row === undefined ? null : map(row);
  }

  async findByUsername(username: string): Promise<AdminAccountRow | null> {
    const row = this.database.connection.prepare(
      `${SELECT} WHERE username = ?`
    ).get(username) as unknown as AccountRow | undefined;
    return row === undefined ? null : map(row);
  }

  async list(): Promise<AdminAccountRow[]> {
    const rows = this.database.connection.prepare(
      `${SELECT} ORDER BY created_at ASC, id ASC`
    ).all() as unknown as AccountRow[];
    return rows.map(map);
  }

  async create(input: {
    id: string;
    username: string;
    passwordHash: string;
    role: "owner" | "admin";
    createdAt: string;
    updatedAt: string;
  }): Promise<CreateAdminAccountOutcome> {
    return this.database.transaction(() => {
      try {
        this.database.connection.prepare(`
          INSERT INTO admin_accounts(
            id, username, password_hash, role, status,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?)
        `).run(
          input.id,
          input.username,
          input.passwordHash,
          input.role,
          input.createdAt,
          input.updatedAt
        );
        // 与 dev-admin 的同步写入互补：admin_idempotency 外键指向 dev 侧
        // admins 表，密码登录创建的真实账号同样镜像一行，保证幂等表 FK 成立。
        this.database.connection.prepare(`
          INSERT INTO admins(id, development_subject, role, enabled, created_at)
          VALUES (?, ?, ?, 1, ?)
        `).run(input.id, input.username, input.role, input.createdAt);
        return { kind: "created" as const };
      } catch (error) {
        if (String(error).includes("UNIQUE")) {
          return { kind: "username_taken" as const };
        }
        throw error;
      }
    });
  }

  async updateStatus(
    id: string,
    status: "active" | "disabled",
    updatedAt: string
  ): Promise<"updated" | "not_found"> {
    return this.database.transaction(() => {
      const result = this.database.connection.prepare(`
        UPDATE admin_accounts
        SET status = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?
      `).run(status, updatedAt, id);
      if (result.changes !== 1) {
        return "not_found";
      }
      this.syncDevEnabledFlag(id, status === "active" ? 1 : 0);
      return "updated";
    });
  }

  async disableAndRevokeSessions(
    id: string,
    updatedAt: string,
    reason: string
  ): Promise<"updated" | "not_found"> {
    return this.database.transaction(() => {
      const result = this.database.connection.prepare(`
        UPDATE admin_accounts
        SET status = 'disabled', updated_at = ?, revision = revision + 1
        WHERE id = ? AND status = 'active'
      `).run(updatedAt, id);
      if (result.changes !== 1) {
        return "not_found";
      }
      this.database.connection.prepare(`
        UPDATE admin_sessions SET revoked_at = ?, revoked_reason = ?
        WHERE admin_id = ? AND revoked_at IS NULL
      `).run(updatedAt, reason, id);
      this.syncDevEnabledFlag(id, 0);
      return "updated";
    });
  }

  /**
   * 事务内守卫停用（评审 B P2）：count 与 disable 在同一 BEGIN IMMEDIATE
   * 事务内执行，跨进程并发双双停用最后一个 owner 的击穿路径被关闭。
   */
  async disableAdminIfNotLastOwner(
    id: string,
    updatedAt: string,
    reason: string
  ): Promise<"updated" | "not_found" | "last_owner"> {
    return this.database.transaction(() => {
      const account = this.database.connection.prepare(`
        SELECT role, status FROM admin_accounts WHERE id = ?
      `).get(id) as unknown as
        | { role: AdminRole; status: AdminStatus }
        | undefined;
      if (account === undefined || account.status !== "active") {
        return "not_found";
      }
      if (account.role === "owner") {
        const count = this.database.connection.prepare(`
          SELECT COUNT(*) AS count FROM admin_accounts
          WHERE role = 'owner' AND status = 'active'
        `).get() as unknown as { count: number };
        if (count.count <= 1) {
          return "last_owner";
        }
      }
      const result = this.database.connection.prepare(`
        UPDATE admin_accounts
        SET status = 'disabled', updated_at = ?, revision = revision + 1
        WHERE id = ? AND status = 'active'
      `).run(updatedAt, id);
      if (result.changes !== 1) {
        return "not_found";
      }
      this.database.connection.prepare(`
        UPDATE admin_sessions SET revoked_at = ?, revoked_reason = ?
        WHERE admin_id = ? AND revoked_at IS NULL
      `).run(updatedAt, reason, id);
      this.syncDevEnabledFlag(id, 0);
      return "updated";
    });
  }

  /** dev 侧 admins 表的 enabled 与 admin_accounts.status 保持同步。 */
  private syncDevEnabledFlag(id: string, enabled: number): void {
    this.database.connection.prepare(`
      UPDATE admins SET enabled = ? WHERE id = ?
    `).run(enabled, id);
  }
}
