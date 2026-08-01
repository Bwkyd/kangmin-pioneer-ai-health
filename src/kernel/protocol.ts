import type { CommandResult } from "./result.js";

export const COMMAND_PROTOCOL_VERSION = "1" as const;
export const COMMAND_SCHEMA_VERSION = "1" as const;

export interface CommandServiceMeta {
  service: "kangmin-command-service";
  serviceVersion: string;
  protocolVersion: typeof COMMAND_PROTOCOL_VERSION;
  schemaVersion: typeof COMMAND_SCHEMA_VERSION;
  audiences: readonly ["patient", "admin"];
}

export interface RemoteCommandRequest {
  schemaVersion: typeof COMMAND_SCHEMA_VERSION;
  command: string;
  input: Record<string, unknown>;
  requestId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCommandServiceMeta(value: unknown): value is CommandServiceMeta {
  return (
    isRecord(value) &&
    value.service === "kangmin-command-service" &&
    typeof value.serviceVersion === "string" &&
    value.protocolVersion === COMMAND_PROTOCOL_VERSION &&
    value.schemaVersion === COMMAND_SCHEMA_VERSION &&
    Array.isArray(value.audiences) &&
    value.audiences.length === 2 &&
    value.audiences[0] === "patient" &&
    value.audiences[1] === "admin"
  );
}

export function isCommandResult(value: unknown): value is CommandResult {
  if (
    !isRecord(value) ||
    typeof value.ok !== "boolean" ||
    typeof value.command !== "string" ||
    !isRecord(value.receipt) ||
    typeof value.receipt.operationId !== "string" ||
    typeof value.receipt.requestId !== "string" ||
    !isRecord(value.meta) ||
    value.meta.schemaVersion !== COMMAND_SCHEMA_VERSION ||
    typeof value.meta.requestId !== "string" ||
    typeof value.meta.timestamp !== "string"
  ) {
    return false;
  }
  if (value.ok) {
    return value.status === "completed" && Object.hasOwn(value, "data");
  }
  return (
    value.status === "failed" &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    typeof value.error.retryable === "boolean"
  );
}
