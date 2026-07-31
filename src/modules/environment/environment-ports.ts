/**
 * 环境端口（架构 §19 EnvironmentProviderPort）。
 *
 * 本 MVP 只接测试替身适配器，不接真实外部供应商：
 * - 花粉风险是风险指数（1-5 级），不得表述为实测花粉浓度；
 * - 环境快照只作浏览展示，绝不自动写入患者暴露记录
 *   （暴露记录是 record 模块职责，browse 不写）；
 * - 快照落库缓存：过期快照返回 stale 标记而不是“刚刚更新”。
 */

/** 环境快照：JSON 字段保持 provider 原始载荷字符串，由服务层决定展示。 */
export interface EnvironmentSnapshot {
  /** 解析后的城市名（如 “成都”）。 */
  city: string;
  /** provider 原始天气载荷（JSON 字符串）。 */
  weatherJson: string;
  /** provider 原始空气质量载荷（JSON 字符串）。 */
  airQualityJson: string;
  /** provider 原始花粉风险载荷（JSON 字符串，风险指数而非实测浓度）。 */
  pollenRiskJson: string;
  /** 观测时间（provider 数据时间，ISO 8601）。 */
  observedAt: string;
  /** 抓取时间（本系统拿到数据的时间，ISO 8601）。 */
  fetchedAt: string;
  /** 数据来源标签（如 “test-double”）。 */
  sourceLabel: string;
  /**
   * 过期标记：true 表示来自过期缓存，展示时必须提示“数据可能过时”，
   * 不得当作刚刚更新的数据。
   */
  stale: boolean;
}

/** provider 提供的预报日条目（forecast 骨架：本 MVP 不落缓存）。 */
export interface ForecastDay {
  city: string;
  /** 预报目标日期（YYYY-MM-DD）。 */
  date: string;
  weatherJson: string;
  airQualityJson: string;
  pollenRiskJson: string;
  sourceLabel: string;
  /** 明确标注这是预报而非实测。 */
  isForecast: true;
}

/**
 * 环境数据供应商端口。错误码：
 * - provider_unavailable：供应商不可用（未配置/服务中断）；
 * - provider_timeout：供应商超时；
 * - location_unavailable：供应商无法解析该位置。
 * 实现不得返回伪造数据冒充真实观测。
 */
export interface EnvironmentProviderPort {
  /** 供应商标识，用于缓存键隔离（如 “test-double”）。 */
  readonly providerId: string;

  /** 获取指定位置当前环境快照。 */
  current(location: string): Promise<EnvironmentSnapshot>;

  /** 获取指定位置未来 N 天预报（骨架实现）。 */
  forecast(location: string, days: number): Promise<ForecastDay[]>;
}

/** 缓存中的快照：额外携带 expiresAt（由 save 按 ttl 计算）。 */
export type CachedEnvironmentSnapshot = EnvironmentSnapshot & {
  expiresAt: string;
};

/** 环境快照缓存：按 (provider, cache_key) 唯一，过期语义由服务层判定。 */
export interface EnvironmentCacheRepository {
  find(
    providerId: string,
    cacheKey: string
  ): Promise<CachedEnvironmentSnapshot | null>;
  /** 保存快照并计算 expires_at = fetchedAt + ttlSeconds。 */
  save(
    providerId: string,
    snapshot: EnvironmentSnapshot,
    cacheKey: string,
    ttlSeconds: number
  ): Promise<void>;
}
