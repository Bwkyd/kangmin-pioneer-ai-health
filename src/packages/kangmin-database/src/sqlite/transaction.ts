import type { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

import { DomainError } from "@kangmin/core/kernel/errors";

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null &&
    "then" in value && typeof value.then === "function";
}

function rollbackFailure(connection: DatabaseSync, error: unknown): never {
  try {
    connection.exec("ROLLBACK");
  } catch {
    // Preserve the original domain/storage failure.
  }
  if (String(error).includes("database is locked")) {
    throw new DomainError(
      "storage_unavailable",
      "健康记录存储正被其他进程占用，请稍后重试",
      { retryable: true, cause: error }
    );
  }
  throw error;
}

function commit<T>(connection: DatabaseSync, value: T): T {
  try {
    connection.exec("COMMIT");
    return value;
  } catch (error) {
    return rollbackFailure(connection, error);
  }
}

/** 支持同步调用方与跨 await 的异步调用方共享同一个 SQLite 事务。 */
export function runSqliteTransaction<T>(
  connection: DatabaseSync,
  context: AsyncLocalStorage<symbol>,
  begin: () => void,
  operation: () => T | Promise<T>
): T | Promise<T> {
  if (context.getStore() !== undefined) return operation();

  begin();
  const marker = Symbol("sqlite-transaction");
  try {
    const result = context.run(marker, operation);
    if (isPromiseLike(result)) {
      return result.then(
        (value) => commit(connection, value),
        (error) => rollbackFailure(connection, error)
      );
    }
    return commit(connection, result);
  } catch (error) {
    return rollbackFailure(connection, error);
  }
}
