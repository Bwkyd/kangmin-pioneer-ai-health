/**
 * PostgreSQL 连接与迁移设施。
 *
 * 与 KangminDatabase（SQLite）对齐的职责：
 * - 构造时启动版本化迁移（ready Promise），仓储方法一律先 await ready，
 *   保持组合根同步装配、端口方法异步的既有形态；
 * - 迁移用 advisory lock 防止多实例并发建表，逐个版本在事务内执行并
 *   写入 schema_migrations 账本；已应用版本中出现未知版本（数据库比
 *   代码更新）时 fail-closed，不静默继续；
 * - transaction() 提供 BEGIN/COMMIT/ROLLBACK 包装，序列化冲突、死锁和
 *   锁超时映射为可重试的 storage_unavailable，与 SQLite 的 BUSY 映射对齐。
 */
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { DomainError } from "../../kernel/errors.js";
import { PG_MIGRATIONS } from "./pg-migrations.js";

/** 迁移互斥锁 key（任意稳定常量，全实例共享）。 */
const MIGRATION_LOCK_KEY = 834_927_101;

/** PostgreSQL 错误码。 */
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_SERIALIZATION_FAILURE = "40001";
const PG_DEADLOCK_DETECTED = "40P01";
const PG_LOCK_NOT_AVAILABLE = "55P03";

interface PgErrorLike {
  code?: string;
}

function pgCode(error: unknown): string | undefined {
  return (error as PgErrorLike | null)?.code;
}

/** 唯一约束冲突（对应 SQLite 的 UNIQUE constraint failed）。 */
export function isUniqueViolation(error: unknown): boolean {
  return pgCode(error) === PG_UNIQUE_VIOLATION;
}

/** 外键约束冲突（对应 SQLite 的 FOREIGN KEY constraint failed）。 */
export function isForeignKeyViolation(error: unknown): boolean {
  return pgCode(error) === PG_FOREIGN_KEY_VIOLATION;
}

/** 可重试的并发冲突：序列化失败、死锁、锁等待超时。 */
function isRetryableConcurrency(error: unknown): boolean {
  const code = pgCode(error);
  return (
    code === PG_SERIALIZATION_FAILURE ||
    code === PG_DEADLOCK_DETECTED ||
    code === PG_LOCK_NOT_AVAILABLE
  );
}

export class KangminPgDatabase {
  private readonly pool: Pool;
  /**
   * 迁移完成 Promise。仓储方法必须先 await；迁移失败时所有方法
   * 统一抛出迁移期的 DomainError（fail-closed，不带病运行）。
   */
  readonly ready: Promise<void>;

  constructor(connectionUrl: string) {
    this.pool = new Pool({
      connectionString: connectionUrl,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000
    });
    // pg 对空闲连接的服务端终止（如测试隔离库 DROP ... WITH (FORCE)、
    // 服务端重启）发 error 事件；无监听会升级为 uncaughtException。
    // 空闲连接被杀不需要进程级崩溃：活跃查询路径的错误本就各自抛出。
    this.pool.on("error", () => {});
    this.ready = this.migrate();
    // 标记 rejection 已被处理：仓储方法尚未 await ready 时（如构造后
    // 直接关闭），避免 Node 报 unhandledRejection；后续 await 仍能
    // 拿到原始迁移错误。
    void this.ready.catch(() => {});
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<{ rows: T[]; rowCount: number }> {
    await this.ready;
    const result = await this.pool.query<T>(text, [...params]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  /**
   * 写事务：同一连接上 BEGIN → operation → COMMIT；任何失败 ROLLBACK。
   * 并发冲突映射为 retryable 的 storage_unavailable；DomainError 原样透传。
   */
  async transaction<T>(
    operation: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // 保留原始领域/存储错误。
      }
      if (error instanceof DomainError) {
        throw error;
      }
      if (isRetryableConcurrency(error)) {
        throw new DomainError(
          "storage_unavailable",
          "健康记录存储正被其他请求占用，请稍后重试",
          { retryable: true, cause: error }
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** 事务内查询的简洁封装。 */
  async queryIn<T extends QueryResultRow = QueryResultRow>(
    client: PoolClient,
    text: string,
    params: readonly unknown[] = []
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await client.query<T>(text, [...params]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async migrate(): Promise<void> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        )
      `);
      const appliedRows = await client.query<{ version: string }>(
        "SELECT version FROM schema_migrations"
      );
      const applied = new Set(appliedRows.rows.map((row) => row.version));
      const known = new Set(PG_MIGRATIONS.map((migration) => migration.version));
      const unknown = [...applied].filter((version) => !known.has(version));
      if (unknown.length > 0) {
        throw new DomainError(
          "storage_unavailable",
          "数据库迁移版本比当前代码更新，拒绝启动",
          { retryable: false }
        );
      }
      for (const migration of PG_MIGRATIONS) {
        if (applied.has(migration.version)) {
          continue;
        }
        await client.query("BEGIN");
        try {
          for (const statement of migration.statements) {
            await client.query(statement);
          }
          await client.query(
            "INSERT INTO schema_migrations(version, applied_at) VALUES ($1, $2)",
            [migration.version, new Date().toISOString()]
          );
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // 保留原始迁移错误。
          }
          throw error;
        }
      }
    } catch (error) {
      // DomainError（版本不符等）原样透传，不重包误导排障。
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        "storage_unavailable",
        "健康记录存储不可用",
        { retryable: true, cause: error }
      );
    } finally {
      if (client !== undefined) {
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [
            MIGRATION_LOCK_KEY
          ]);
        } catch {
          // 连接故障时锁随会话释放。
        }
        client.release();
      }
    }
  }
}

/** 已应用迁移版本（doctor 用）。 */
export async function appliedPgMigrationVersions(
  database: KangminPgDatabase
): Promise<string[]> {
  const { rows } = await database.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version"
  );
  return rows.map((row) => row.version);
}
