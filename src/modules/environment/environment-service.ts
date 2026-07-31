import { cacheKeyOf, SNAPSHOT_TTL_SECONDS } from "./domain.js";
import type {
  EnvironmentCacheRepository,
  EnvironmentProviderPort,
  EnvironmentSnapshot,
  ForecastDay
} from "./environment-ports.js";

/**
 * 环境服务：在 EnvironmentProviderPort 之上实现缓存语义
 * （架构 §19 外部端口与降级）：
 * - current：命中未过期缓存 → 直接返回（fresh）；命中过期缓存 →
 *   返回 stale 标记，而不是重新抓取后谎称“刚刚更新”；
 * - 无缓存时向 provider 取数并落库缓存；provider 不可用且无缓存 →
 *   抛出 provider_unavailable / provider_timeout / location_unavailable；
 * - refresh：显式重取，失败直接抛错，不回退到过期缓存；
 * - forecast：骨架，直接透传 provider 预报，本 MVP 不落缓存。
 */
export class EnvironmentService {
  constructor(
    private readonly provider: EnvironmentProviderPort,
    private readonly cache: EnvironmentCacheRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  async current(location: string): Promise<EnvironmentSnapshot> {
    const cacheKey = cacheKeyOf(location);
    const cached = await this.cache.find(this.provider.providerId, cacheKey);
    if (cached !== null) {
      const expiresAt = Date.parse(cached.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt > this.now().getTime()) {
        return { ...cached, stale: false };
      }
      // 过期快照返回 stale 标记，不伪装成刚刚更新。
      return { ...cached, stale: true };
    }
    return this.fetchAndCache(location, cacheKey);
  }

  async refresh(location: string): Promise<EnvironmentSnapshot> {
    return this.fetchAndCache(location, cacheKeyOf(location));
  }

  async forecast(location: string, days: number): Promise<ForecastDay[]> {
    return this.provider.forecast(location, days);
  }

  private async fetchAndCache(
    location: string,
    cacheKey: string
  ): Promise<EnvironmentSnapshot> {
    // provider 失败（provider_unavailable/provider_timeout/location_unavailable）
    // 原样向上传播：无缓存时绝不能伪装成空数据。
    const snapshot = await this.provider.current(location);
    const fresh: EnvironmentSnapshot = { ...snapshot, stale: false };
    await this.cache.save(
      this.provider.providerId,
      fresh,
      cacheKey,
      SNAPSHOT_TTL_SECONDS
    );
    return fresh;
  }
}
