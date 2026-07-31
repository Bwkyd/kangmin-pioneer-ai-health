import { DomainError } from "./errors.js";

export function requiredString(
  input: Record<string, unknown>,
  key: string
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(
      "validation_failed",
      `${key} 必须是非空字符串`,
      { details: { field: key } }
    );
  }
  return value.trim();
}

export function optionalString(
  input: Record<string, unknown>,
  key: string
): string | null | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainError(
      "validation_failed",
      `${key} 必须是字符串`,
      { details: { field: key } }
    );
  }
  return value.trim();
}

export function integerInRange(
  input: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number {
  const value = input[key];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new DomainError(
      "validation_failed",
      `${key} 必须是 ${min} 到 ${max} 的整数`,
      { details: { field: key, min, max } }
    );
  }
  return value as number;
}

export function optionalIntegerInRange(
  input: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | undefined {
  if (input[key] === undefined) {
    return undefined;
  }
  return integerInRange(input, key, min, max);
}

export function positiveInteger(
  input: Record<string, unknown>,
  key: string
): number {
  return integerInRange(input, key, 1, Number.MAX_SAFE_INTEGER);
}

export function localDate(input: Record<string, unknown>, key: string): string {
  const value = requiredString(input, key);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new DomainError(
      "validation_failed",
      `${key} 必须使用 YYYY-MM-DD`,
      { details: { field: key } }
    );
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new DomainError(
      "validation_failed",
      `${key} 不是有效日期`,
      { details: { field: key } }
    );
  }
  return value;
}

export function requiredStringArray(
  input: Record<string, unknown>,
  key: string
): string[] {
  const value = input[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string" && item.trim() !== "")
  ) {
    throw new DomainError(
      "validation_failed",
      `${key} 必须是非空字符串数组`,
      { details: { field: key } }
    );
  }
  return value.map((item) => (item as string).trim());
}

export function optionalStringArray(
  input: Record<string, unknown>,
  key: string
): string[] | undefined {
  if (input[key] === undefined) {
    return undefined;
  }
  return requiredStringArray(input, key);
}

export function optionalLocalDate(
  input: Record<string, unknown>,
  key: string
): string | null | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  return localDate(input, key);
}

export function monthString(input: Record<string, unknown>, key: string): string {
  const value = requiredString(input, key);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(value)) {
    throw new DomainError(
      "validation_failed",
      `${key} 必须使用 YYYY-MM`,
      { details: { field: key } }
    );
  }
  return value;
}
