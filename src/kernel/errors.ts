export type ErrorCode =
  | "command_invalid"
  | "invalid_json"
  | "payload_too_large"
  | "resource_not_found"
  | "version_conflict"
  | "idempotency_conflict"
  | "confirmation_required"
  | "capability_unavailable"
  | "validation_failed"
  | "authentication_required"
  | "permission_denied"
  | "storage_unavailable"
  | "internal_error";

const EXIT_CODES: Record<ErrorCode, number> = {
  command_invalid: 2,
  invalid_json: 2,
  payload_too_large: 2,
  resource_not_found: 3,
  version_conflict: 4,
  idempotency_conflict: 4,
  confirmation_required: 5,
  capability_unavailable: 6,
  validation_failed: 7,
  authentication_required: 9,
  permission_denied: 9,
  storage_unavailable: 6,
  internal_error: 1
};

const HTTP_STATUS: Record<ErrorCode, number> = {
  command_invalid: 400,
  invalid_json: 400,
  payload_too_large: 413,
  resource_not_found: 404,
  version_conflict: 409,
  idempotency_conflict: 409,
  confirmation_required: 409,
  capability_unavailable: 503,
  validation_failed: 422,
  authentication_required: 401,
  permission_denied: 403,
  storage_unavailable: 503,
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
