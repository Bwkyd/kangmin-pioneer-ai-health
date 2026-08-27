import type {
  AdminAccountRepository,
  AdminAccountRow,
  CreateAdminAccountOutcome
} from "@kangmin/core/operations/admin/admin-account-repository";
import type {
  AdminRole,
  AdminStatus
} from "@kangmin/core/operations/admin/admin-session-repository";
import { isUniqueViolation, KangminPgDatabase } from "./database.js";

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

// 与 SQLite BEGIN IMMEDIATE 对齐的写序列化：SHARE ROW EXCLUSIVE 与自身
// 及行级写锁（INSERT/UPDATE/DELETE 的 ROW EXCLUSIVE）互斥，但不阻塞普通
// 只读 SELECT——并发写者串行执行，读者不受影响。
const LOCK_WRITE_SERIALIZATION =
  "LOCK TABLE admin_accounts IN SHARE ROW EXCLUSIVE MODE";

export class PgAdminAccountRepository implements AdminAccountRepository {
  constructor(private readonly database: KangminPgDatabase) {}

  async countAll(): Promise<number> {
    // COUNT 在 PG 返回 int8（pg 驱动映射为 string），::int 强转回 number。
    const { rows } = await this.database.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM admin_accounts"
    );
    return rows[0]?.count ?? 0;
  }

  async countActiveOwners(): Promise<number> {
    const { rows } = await this.database.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM admin_accounts
      WHERE role = 'owner' AND status = 'active'
    `);
    return rows[0]?.count ?? 0;
  }

  async findById(id: string): Promise<AdminAccountRow | null> {
    const { rows } = await this.database.query<AccountRow>(
      `${SELECT} WHERE id = $1`,
      [id]
    );
    const row = rows[0];
    return row === undefined ? null : map(row);
  }

  async findByUsername(username: string): Promise<AdminAccountRow | null> {
    const { rows } = await this.database.query<AccountRow>(
      `${SELECT} WHERE username = $1`,
      [username]
    );
    const row = rows[0];
    return row === undefined ? null : map(row);
  }

  async list(): Promise<AdminAccountRow[]> {
    const { rows } = await this.database.query<AccountRow>(
      `${SELECT} ORDER BY created_at ASC, id ASC`
    );
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
    return this.database.transaction(async (client) => {
      try {
        await this.database.queryIn(
          client,
          `INSERT INTO admin_accounts(
            id, username, password_hash, role, status,
            revision, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, 'active', 1, $5, $6)`,
          [
            input.id,
            input.username,
            input.passwordHash,
            input.role,
            input.createdAt,
            input.updatedAt
          ]
        );
        return { kind: "created" as const };
      } catch (error) {
        if (isUniqueViolation(error)) {
          return { kind: "username_taken" as const };
        }
        throw error;
      }
    });
  }

  /**
   * 首个 owner 引导（事务与卫生残留批 P1-2）：count 与 insert 在同一
   * 事务内，且先用表级写锁复刻 SQLite BEGIN IMMEDIATE 的写序列化——
   * 跨进程并发引导只有一个请求见到 count=0，另一个返回
   * owner_exists——关闭"countAll()===0 → create"竞态窗口。
   */
  async createFirstOwner(input: {
    id: string;
    username: string;
    passwordHash: string;
    createdAt: string;
    updatedAt: string;
  }): Promise<"created" | "owner_exists" | "username_taken"> {
    return this.database.transaction(async (client) => {
      await this.database.queryIn(client, LOCK_WRITE_SERIALIZATION);
      const count = await this.database.queryIn<{ count: number }>(
        client,
        "SELECT COUNT(*)::int AS count FROM admin_accounts"
      );
      if ((count.rows[0]?.count ?? 0) > 0) {
        return "owner_exists";
      }
      try {
        await this.database.queryIn(
          client,
          `INSERT INTO admin_accounts(
            id, username, password_hash, role, status,
            revision, created_at, updated_at
          ) VALUES ($1, $2, $3, 'owner', 'active', 1, $4, $5)`,
          [
            input.id,
            input.username,
            input.passwordHash,
            input.createdAt,
            input.updatedAt
          ]
        );
        return "created";
      } catch (error) {
        if (isUniqueViolation(error)) {
          return "username_taken";
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
    return this.database.transaction(async (client) => {
      const { rowCount } = await this.database.queryIn(
        client,
        `UPDATE admin_accounts
        SET status = $1, updated_at = $2, revision = revision + 1
        WHERE id = $3`,
        [status, updatedAt, id]
      );
      if (rowCount !== 1) {
        return "not_found";
      }
      return "updated";
    });
  }

  async disableAndRevokeSessions(
    id: string,
    updatedAt: string,
    reason: string
  ): Promise<"updated" | "not_found"> {
    return this.database.transaction(async (client) => {
      const { rowCount } = await this.database.queryIn(
        client,
        `UPDATE admin_accounts
        SET status = 'disabled', updated_at = $1, revision = revision + 1
        WHERE id = $2 AND status = 'active'`,
        [updatedAt, id]
      );
      if (rowCount !== 1) {
        return "not_found";
      }
      await this.database.queryIn(
        client,
        `UPDATE admin_sessions SET revoked_at = $1, revoked_reason = $2
        WHERE admin_id = $3 AND revoked_at IS NULL`,
        [updatedAt, reason, id]
      );
      return "updated";
    });
  }

  /**
   * 事务内守卫停用（评审 B P2）：count 与 disable 在同一事务内执行，
   * 并先取表级写锁复刻 SQLite BEGIN IMMEDIATE 的写序列化——跨进程
   * 并发双双停用最后一个 owner 的击穿路径被关闭。
   */
  async disableAdminIfNotLastOwner(
    id: string,
    updatedAt: string,
    reason: string
  ): Promise<"updated" | "not_found" | "last_owner"> {
    return this.database.transaction(async (client) => {
      await this.database.queryIn(client, LOCK_WRITE_SERIALIZATION);
      const accountRows = await this.database.queryIn<{
        role: AdminRole;
        status: AdminStatus;
      }>(
        client,
        "SELECT role, status FROM admin_accounts WHERE id = $1",
        [id]
      );
      const account = accountRows.rows[0];
      if (account === undefined || account.status !== "active") {
        return "not_found";
      }
      if (account.role === "owner") {
        const count = await this.database.queryIn<{ count: number }>(
          client,
          `SELECT COUNT(*)::int AS count FROM admin_accounts
          WHERE role = 'owner' AND status = 'active'`
        );
        if ((count.rows[0]?.count ?? 0) <= 1) {
          return "last_owner";
        }
      }
      const { rowCount } = await this.database.queryIn(
        client,
        `UPDATE admin_accounts
        SET status = 'disabled', updated_at = $1, revision = revision + 1
        WHERE id = $2 AND status = 'active'`,
        [updatedAt, id]
      );
      if (rowCount !== 1) {
        return "not_found";
      }
      await this.database.queryIn(
        client,
        `UPDATE admin_sessions SET revoked_at = $1, revoked_reason = $2
        WHERE admin_id = $3 AND revoked_at IS NULL`,
        [updatedAt, reason, id]
      );
      return "updated";
    });
  }
}
