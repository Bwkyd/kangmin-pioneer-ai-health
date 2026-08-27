import type { PoolClient } from "pg";

import { DomainError } from "@kangmin/core/kernel/errors";
import type { IdempotentCreateOutcome } from "../idempotency.js";
import { isUniqueViolation, KangminPgDatabase } from "./pg-database.js";

/**
 * runIdempotentCreate（../idempotency.ts，node:sqlite 同步版）的
 * PostgreSQL 异步等价物：语义逐条对齐——
 * “查重 → 同 hash 重放 / 异 hash 冲突 → 写入”，幂等表名与主键列名参数化。
 *
 * 约定与 SQLite 版一致：
 * - 调用方自行包裹事务（db.transaction），本函数不开启事务；
 * - insert 抛唯一约束错误时，仅当 uniqueConflictAsDateConflict 为 true
 *   返回 date_conflict，否则原样向上抛出（由 db.transaction 回滚）；
 * - 重放分支由 verifyExists 校验原目标仍存在（删除后同键重放返回
 *   stale_replay，绝不返回幻影记录）；
 * - 幂等行写入遭遇并发同键竞态（另一事务抢先写入同一幂等键）时，
 *   映射为 retryable storage_unavailable，调用方重试后走重放分支，
 *   绝不向上泄漏裸 23505（SQLite 侧对应场景是 BEGIN IMMEDIATE 的
 *   BUSY，由数据库层映射为可重试错误）。
 */
export interface PgRunIdempotentCreateOptions {
  /** 幂等表名：idempotency_records | admin_idempotency */
  table: string;
  /** 参与者主键列：patient_id | admin_id */
  actorColumn: string;
  /** 作用域列：command_scope | scope */
  scopeColumn: string;
  /** 幂等键列：idempotency_key（两表一致） */
  keyColumn: string;
  actorId: string;
  scope: string;
  key: string;
  requestHash: string;
  /** 成功创建后写入幂等行的结果 JSON；重放时调用方解析后返回。 */
  resultJson: string;
  createdAt: string;
  /** 真实创建（写业务表）；幂等行写入紧随其后，同一事务内完成。 */
  insert: () => Promise<void>;
  /** 重放前校验原目标仍存在：不存在时返回 stale_replay，不返回幻影记录。 */
  verifyExists: (resultJson: string) => Promise<boolean>;
  /** 患者侧同日唯一约束：insert 的唯一冲突映射为 date_conflict。 */
  uniqueConflictAsDateConflict?: boolean;
}

export async function runPgIdempotentCreate(
  database: KangminPgDatabase,
  client: PoolClient,
  options: PgRunIdempotentCreateOptions
): Promise<IdempotentCreateOutcome> {
  const { rows } = await database.queryIn<{
    request_hash: string;
    result_json: string;
  }>(
    client,
    `SELECT request_hash, result_json
     FROM ${options.table}
     WHERE ${options.actorColumn} = $1
       AND ${options.scopeColumn} = $2
       AND ${options.keyColumn} = $3`,
    [options.actorId, options.scope, options.key]
  );
  const previous = rows[0];

  if (previous !== undefined) {
    if (previous.request_hash !== options.requestHash) {
      return { kind: "idempotency_conflict" };
    }
    // 重放必须返回存储的原结果（原始 id/修订），而不是本次请求携带的新记录；
    // verifyExists 校验原目标仍存在：已删除时返回 stale_replay，不返回幻影记录。
    return (await options.verifyExists(previous.result_json))
      ? { kind: "replayed", resultJson: previous.result_json }
      : { kind: "stale_replay" };
  }

  try {
    await options.insert();
  } catch (error) {
    if (
      options.uniqueConflictAsDateConflict === true &&
      isUniqueViolation(error)
    ) {
      return { kind: "date_conflict" };
    }
    throw error;
  }

  try {
    await database.queryIn(
      client,
      `INSERT INTO ${options.table}(
        ${options.actorColumn}, ${options.scopeColumn}, ${options.keyColumn},
        request_hash, result_json, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        options.actorId,
        options.scope,
        options.key,
        options.requestHash,
        options.resultJson,
        options.createdAt
      ]
    );
  } catch (error) {
    // 并发同键竞态：另一事务已抢先写入同一幂等键。映射为 retryable
    // storage_unavailable，让调用方重试后走重放分支，绝不泄漏
    // 裸 23505 给上层。
    if (isUniqueViolation(error)) {
      throw new DomainError(
        "storage_unavailable",
        "存储正被其他请求占用，请稍后重试",
        { retryable: true, cause: error }
      );
    }
    throw error;
  }

  return { kind: "created" };
}
