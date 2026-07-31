import { randomUUID } from "node:crypto";

import { normalizeError, type DomainError } from "./errors.js";

export interface ResultMeta {
  schemaVersion: "1";
  requestId: string;
  timestamp: string;
}

export interface SuccessResult<T> {
  ok: true;
  command: string;
  status: "completed";
  data: T;
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

export function success<T>(
  command: string,
  data: T,
  requestId?: string
): SuccessResult<T> {
  return {
    ok: true,
    command,
    status: "completed",
    data,
    meta: meta(requestId)
  };
}

export function failure(
  command: string,
  inputError: unknown,
  requestId?: string
): FailureResult {
  const error: DomainError = normalizeError(inputError);
  const details = error.details === undefined ? {} : { details: error.details };

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
    meta: meta(requestId)
  };
}
