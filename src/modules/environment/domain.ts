import { DomainError } from "../../kernel/errors.js";

/** 未指定 --city 时的默认城市（测试替身适配器的默认数据城市）。 */
export const DEFAULT_LOCATION = "成都";

/** 环境快照缓存有效期（秒）：30 分钟。 */
export const SNAPSHOT_TTL_SECONDS = 30 * 60;

/** 预报天数上限。 */
export const MAX_FORECAST_DAYS = 7;

/** 可选城市：未提供返回默认城市；提供则必须是非空字符串。 */
export function cityOf(input: Record<string, unknown>): string {
  const value = input.city;
  if (value === undefined) {
    return DEFAULT_LOCATION;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(
      "validation_failed",
      "city 必须是非空字符串",
      { details: { field: "city" } }
    );
  }
  return value.trim();
}

/** 预报天数：默认 3，1 到 MAX_FORECAST_DAYS。 */
export function forecastDaysOf(input: Record<string, unknown>): number {
  const value = input.days;
  if (value === undefined) {
    return 3;
  }
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_FORECAST_DAYS
  ) {
    throw new DomainError(
      "validation_failed",
      `days 必须是 1 到 ${MAX_FORECAST_DAYS} 的整数`,
      { details: { field: "days", min: 1, max: MAX_FORECAST_DAYS } }
    );
  }
  return value as number;
}

/** 缓存键：以位置名称为键（provider 维度隔离在 UNIQUE(provider, cache_key)）。 */
export function cacheKeyOf(location: string): string {
  return location.trim();
}
