import type { DatabaseSync } from "node:sqlite";

/**
 * 幂等创建公共辅助（评审 A P1-4 收缩版）：
 * 患者侧 idempotency_records 与管理侧 admin_idempotency 复用同一套
 * “查重 → 同 hash 重放 / 异 hash 冲突 → 写入” 语义，幂等表名与
 * 主键列名参数化；物理表不合并（表归一列为后续迁移项，记录在评审决议）。
 *
 * 约定：
 * - 调用方自行包裹事务，本函数不开启事务；
 * - insert 抛 UNIQUE 约束错误时，仅当 uniqueConflictAsDateConflict
 *   为 true 返回 date_conflict，否则原样向上抛出；
 * - 重放分支由 verifyExists 校验原目标仍存在（删除后同键重放返回
 *   stale_replay，绝不返回幻影记录）。
 */
export type IdempotentCreateOutcome =
  | { kind: "created" }
  | { kind: "replayed"; resultJson: string }
  | { kind: "stale_replay" }
  | { kind: "idempotency_conflict" }
  | { kind: "date_conflict" };

export interface RunIdempotentCreateOptions {
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
  insert: () => void;
  /** 重放前校验原目标仍存在：不存在时返回 stale_replay，不返回幻影记录。 */
  verifyExists: (resultJson: string) => boolean;
  /** 患者侧同日唯一约束：insert 的 UNIQUE 错误映射为 date_conflict。 */
  uniqueConflictAsDateConflict?: boolean;
}

export function runIdempotentCreate(
  connection: DatabaseSync,
  options: RunIdempotentCreateOptions
): IdempotentCreateOutcome {
  const previous = connection
    .prepare(`
      SELECT request_hash, result_json
      FROM ${options.table}
      WHERE ${options.actorColumn} = ?
        AND ${options.scopeColumn} = ?
        AND ${options.keyColumn} = ?
    `)
    .get(
      options.actorId,
      options.scope,
      options.key
    ) as unknown as { request_hash: string; result_json: string } | undefined;

  if (previous !== undefined) {
    if (previous.request_hash !== options.requestHash) {
      return { kind: "idempotency_conflict" };
    }
    // 重放必须返回存储的原结果（原始 id/修订），而不是本次请求携带的新记录；
    // verifyExists 校验原目标仍存在：已删除时返回 stale_replay，不返回幻影记录。
    return options.verifyExists(previous.result_json)
      ? { kind: "replayed", resultJson: previous.result_json }
      : { kind: "stale_replay" };
  }

  try {
    options.insert();
  } catch (error) {
    if (
      options.uniqueConflictAsDateConflict === true &&
      String(error).includes("UNIQUE constraint failed")
    ) {
      return { kind: "date_conflict" };
    }
    throw error;
  }

  connection
    .prepare(`
      INSERT INTO ${options.table}(
        ${options.actorColumn}, ${options.scopeColumn}, ${options.keyColumn},
        request_hash, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      options.actorId,
      options.scope,
      options.key,
      options.requestHash,
      options.resultJson,
      options.createdAt
    );

  return { kind: "created" };
}
