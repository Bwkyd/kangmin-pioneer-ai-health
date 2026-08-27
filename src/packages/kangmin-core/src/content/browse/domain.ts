import { DomainError } from "../../kernel/errors.js";

/** 列表分页上限（患者 CLI 设计 §8）：服务端强制，客户端传更大值被截断为上限。 */
export const MAX_LIST_LIMIT = 100;

/** 列表默认页大小。 */
export const DEFAULT_LIST_LIMIT = 20;

/** 搜索词最大长度，避免病态输入拖垮 LIKE 查询。 */
export const MAX_QUERY_LENGTH = 200;

function integerField(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (input[key] === undefined) {
    return fallback;
  }
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

/** 列表 limit：默认 20，上限 100（超出截断而非报错，见 MAX_LIST_LIMIT）。 */
export function listLimitOf(input: Record<string, unknown>): number {
  const value = integerField(
    input,
    "limit",
    DEFAULT_LIST_LIMIT,
    1,
    Number.MAX_SAFE_INTEGER
  );
  return Math.min(value, MAX_LIST_LIMIT);
}

/** 列表 offset：默认 0，非负。 */
export function listOffsetOf(input: Record<string, unknown>): number {
  return integerField(input, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
}

/** 搜索词：必填、去空白、限制长度（沿用 browse 既有 input.query 约定）。 */
export function searchQueryOf(input: Record<string, unknown>): string {
  const value = input.query;
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(
      "validation_failed",
      "query 必须是非空搜索词",
      { details: { field: "query" } }
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new DomainError(
      "validation_failed",
      `搜索词不能超过 ${MAX_QUERY_LENGTH} 个字符`,
      { details: { field: "query", max: MAX_QUERY_LENGTH } }
    );
  }
  return trimmed;
}

/** 裸 browse 首页的可选位置：未提供返回 undefined；提供则必须是非空字符串。 */
export function optionalLocationOf(
  input: Record<string, unknown>
): string | undefined {
  const value = input.location;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(
      "validation_failed",
      "location 必须是非空字符串",
      { details: { field: "location" } }
    );
  }
  return value.trim();
}

/** show 命令的资源 ID：必填非空。 */
export function resourceIdOf(input: Record<string, unknown>): string {
  const value = input.id;
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(
      "validation_failed",
      "id 必须是非空字符串",
      { details: { field: "id" } }
    );
  }
  return value.trim();
}

/** 把用户搜索词转成 SQL LIKE 模式：转义 % _ \，避免通配符注入。 */
export function likePatternOf(query: string): string {
  const escaped = query.replace(/[\\%_]/gu, (char) => `\\${char}`);
  return `%${escaped}%`;
}
