/**
 * 错误码全集（患者端与管理端共享）。
 *
 * 与设计文档对齐的类别：
 * - 输入/命令错误 → 退出码 2 或 7
 * - 资源不存在 → 3
 * - 状态/版本/幂等冲突 → 4
 * - 同意、确认、必填配置或正式内容缺失 → 5
 * - 外部数据源未配置或不可用 → 6
 * - 输入校验失败 → 7
 * - 安全规则阻断 → 8
 * - 未登录或权限不足 → 9
 * - 批量操作部分失败 → 10
 *
 * 注：管理端设计 §11.4 与患者端设计 §12.2 的退出码表存在
 * “5”的语义差异（必填配置缺失 vs 同意/确认缺失），本实现归并为
 * 前置条件缺失类，不再区分两个 5。
 */
export type ErrorCode =
  | "command_invalid"
  | "invalid_json"
  | "payload_too_large"
  | "resource_not_found"
  | "version_conflict"
  | "date_conflict"
  | "idempotency_conflict"
  | "stale_replay"
  | "confirmation_required"
  | "config_missing"
  | "capability_unavailable"
  | "safety_blocked"
  | "more_information_required"
  | "validation_failed"
  | "authentication_required"
  | "permission_denied"
  | "storage_unavailable"
  | "provider_unavailable"
  | "projection_pending"
  | "batch_partial_failure"
  | "internal_error";

const EXIT_CODES: Record<ErrorCode, number> = {
  command_invalid: 2,
  invalid_json: 2,
  payload_too_large: 2,
  resource_not_found: 3,
  version_conflict: 4,
  date_conflict: 4,
  idempotency_conflict: 4,
  stale_replay: 4,
  confirmation_required: 5,
  config_missing: 5,
  capability_unavailable: 6,
  safety_blocked: 8,
  more_information_required: 5,
  validation_failed: 7,
  authentication_required: 9,
  permission_denied: 9,
  storage_unavailable: 6,
  provider_unavailable: 6,
  projection_pending: 6,
  batch_partial_failure: 10,
  internal_error: 1
};

const HTTP_STATUS: Record<ErrorCode, number> = {
  command_invalid: 400,
  invalid_json: 400,
  payload_too_large: 413,
  resource_not_found: 404,
  version_conflict: 409,
  date_conflict: 409,
  idempotency_conflict: 409,
  stale_replay: 409,
  confirmation_required: 409,
  config_missing: 503,
  capability_unavailable: 503,
  safety_blocked: 403,
  more_information_required: 422,
  validation_failed: 422,
  authentication_required: 401,
  permission_denied: 403,
  storage_unavailable: 503,
  provider_unavailable: 503,
  projection_pending: 202,
  batch_partial_failure: 409,
  internal_error: 500
};

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "DomainError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function exitCodeFor(error: DomainError): number {
  return EXIT_CODES[error.code];
}

export function exitCodeForCode(code: string): number {
  return EXIT_CODES[code as ErrorCode] ?? 1;
}

export function httpStatusFor(error: DomainError): number {
  return HTTP_STATUS[error.code];
}

export function httpStatusForCode(code: string): number {
  return HTTP_STATUS[code as ErrorCode] ?? 500;
}

export function normalizeError(error: unknown): DomainError {
  if (error instanceof DomainError) {
    return error;
  }

  return new DomainError(
    "internal_error",
    "系统内部错误，请稍后重试",
    { cause: error }
  );
}
