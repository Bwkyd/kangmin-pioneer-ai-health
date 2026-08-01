import { randomUUID } from "node:crypto";

import { normalizeError, type DomainError } from "./errors.js";

export interface ResultMeta {
  schemaVersion: "1";
  requestId: string;
  timestamp: string;
}

/** 操作凭证：一次命令执行唯一，供审计、幂等重放和排障关联。 */
export interface Receipt {
  operationId: string;
  requestId: string;
}

export interface SuccessResult<T> {
  ok: true;
  command: string;
  status: "completed";
  data: T;
  receipt: Receipt;
  meta: ResultMeta;
}

export interface FailureResult {
  ok: false;
  command: string;
  status: "failed";
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  receipt: Receipt;
  meta: ResultMeta;
}

export type CommandResult<T = unknown> = SuccessResult<T> | FailureResult;

function meta(requestId: string = randomUUID()): ResultMeta {
  return {
    schemaVersion: "1",
    requestId,
    timestamp: new Date().toISOString()
  };
}

function receipt(requestId: string = randomUUID()): Receipt {
  return {
    operationId: randomUUID(),
    requestId
  };
}

export function success<T>(
  command: string,
  data: T,
  requestId?: string
): SuccessResult<T> {
  // requestId 只生成一次：receipt 与 meta 必须一致（跨层关联用同一关联号）。
  const id = requestId ?? randomUUID();
  return {
    ok: true,
    command,
    status: "completed",
    data,
    receipt: receipt(id),
    meta: meta(id)
  };
}

export function failure(
  command: string,
  inputError: unknown,
  requestId?: string
): FailureResult {
  const error: DomainError = normalizeError(inputError);
  const details = error.details === undefined ? {} : { details: error.details };
  const id = requestId ?? randomUUID();

  return {
    ok: false,
    command,
    status: "failed",
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...details
    },
    receipt: receipt(id),
    meta: meta(id)
  };
}
