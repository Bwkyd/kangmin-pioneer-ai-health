/**
 * PG 契约测试隔离库助手。
 *
 * 各契约测试文件原本共用 KANGMIN_TEST_DATABASE_URL 指向的同一个库，
 * 并行运行时互相污染。本助手为每个测试文件创建一次性数据库
 * （<前缀>_<12 位随机 hex>），测试结束用 DROP DATABASE ... WITH (FORCE)
 * 回收，迁移由 KangminPgDatabase 构造时自动执行。
 */
import { randomBytes } from "node:crypto";

import { Client } from "pg";

/** 隔离测试库句柄：url 指向新库，close() 删库并关闭管理连接。 */
export interface PgTestDatabase {
  url: string;
  close(): Promise<void>;
}

/** 数据库名合法化：小写字母/数字/下划线，且以字母或下划线开头。 */
function sanitizeNamePrefix(namePrefix: string): string {
  let cleaned = namePrefix.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!/^[a-z_]/.test(cleaned)) {
    cleaned = `t${cleaned}`;
  }
  // 标识符上限 63 字节，给 "_" + 12 位 hex 后缀留出空间。
  return cleaned.slice(0, 50);
}

/** 把连接串中的库名替换为指定库名，保留用户名、密码、端口与查询参数。 */
function withDatabaseName(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

/**
 * 基于 KANGMIN_TEST_DATABASE_URL 指向的服务器创建一次性测试库。
 * 未配置该环境变量时返回 null（调用方维持既有 skip 语义）。
 */
export async function createPgTestDatabase(
  namePrefix: string
): Promise<PgTestDatabase | null> {
  const adminUrl = process.env.KANGMIN_TEST_DATABASE_URL;
  if (adminUrl === undefined) {
    return null;
  }

  const databaseName = `${sanitizeNamePrefix(namePrefix)}_${randomBytes(6).toString("hex")}`;
  // 管理连接保持打开：DROP DATABASE 不能删除当前连接所在的库，
  // 且 KANGMIN_TEST_DATABASE_URL 通常指向 postgres 维护库，连接可复用。
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }

  return {
    url: withDatabaseName(adminUrl, databaseName),
    async close(): Promise<void> {
      try {
        await admin.query(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`
        );
      } finally {
        await admin.end();
      }
    }
  };
}
