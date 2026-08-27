import { DomainError } from "@kangmin/core/kernel/errors";
import type {
  EnvironmentProviderPort,
  EnvironmentSnapshot,
  ForecastDay
} from "@kangmin/core/content/environment/environment-ports";

/** 测试替身支持模拟的故障模式。 */
export type TestProviderMode = "fixed" | "unavailable" | "timeout";

export interface TestEnvironmentProviderOptions {
  mode?: TestProviderMode | undefined;
  /** 已知城市；请求未知城市抛 location_unavailable。 */
  knownCities?: string[] | undefined;
  /** 固定快照的观测时间（默认固定为示例观测时间，便于断言）。 */
  observedAt?: string | undefined;
}

const DEFAULT_KNOWN_CITIES = ["成都", "北京", "上海"];

const FIXED_OBSERVED_AT = "2026-07-31T08:00:00.000Z";

/**
 * 环境 Provider 测试替身（本 MVP 唯一适配器，不接真实外部供应商）。
 *
 * - 固定返回成都示例数据；
 * - 花粉风险是风险指数（1-5 级），不是实测花粉浓度；
 * - 支持模拟 unavailable（供应商不可用）、timeout（超时）与
 *   location_unavailable（未知城市）三种故障；
 * - 不产生任何副作用（不写患者暴露记录——那是 record 模块的职责）。
 */
export class TestEnvironmentProvider implements EnvironmentProviderPort {
  readonly providerId = "test-double";

  private readonly knownCities: ReadonlySet<string>;
  private readonly observedAt: string;
  private mode: TestProviderMode;

  constructor(options: TestEnvironmentProviderOptions = {}) {
    this.mode = options.mode ?? "fixed";
    this.knownCities = new Set(options.knownCities ?? DEFAULT_KNOWN_CITIES);
    this.observedAt = options.observedAt ?? FIXED_OBSERVED_AT;
  }

  /** 测试用：动态切换故障模式。 */
  setMode(mode: TestProviderMode): void {
    this.mode = mode;
  }

  async current(location: string): Promise<EnvironmentSnapshot> {
    this.throwIfUnavailable();
    if (!this.knownCities.has(location)) {
      throw new DomainError(
        "location_unavailable",
        `环境供应商无法解析位置：${location}`,
        { retryable: false, details: { location } }
      );
    }
    const fetchedAt = new Date().toISOString();
    return {
      city: location,
      weatherJson: JSON.stringify({
        condition: "多云",
        temperatureCelsius: 26,
        humidityPercent: 62
      }),
      airQualityJson: JSON.stringify({
        aqi: 58,
        level: "良",
        primaryPollutant: "PM2.5"
      }),
      pollenRiskJson: JSON.stringify({
        // 风险指数而非实测花粉浓度：1-5 级定性评级。
        riskIndex: 3,
        riskLabel: "较高",
        scaleMax: 5,
        note: "风险指数（1-5 级），非实测花粉浓度"
      }),
      observedAt: this.observedAt,
      fetchedAt,
      sourceLabel: "test-double",
      stale: false
    };
  }

  async forecast(location: string, days: number): Promise<ForecastDay[]> {
    this.throwIfUnavailable();
    if (!this.knownCities.has(location)) {
      throw new DomainError(
        "location_unavailable",
        `环境供应商无法解析位置：${location}`,
        { retryable: false, details: { location } }
      );
    }
    const entries: ForecastDay[] = [];
    const base = Date.parse(this.observedAt);
    for (let index = 1; index <= days; index += 1) {
      const date = new Date(base + index * 86_400_000);
      entries.push({
        city: location,
        date: date.toISOString().slice(0, 10),
        weatherJson: JSON.stringify({
          condition: "多云",
          temperatureCelsius: 25 + (index % 3),
          humidityPercent: 60
        }),
        airQualityJson: JSON.stringify({ aqi: 55, level: "良" }),
        pollenRiskJson: JSON.stringify({
          riskIndex: Math.min(2 + (index % 3), 5),
          riskLabel: "中等",
          scaleMax: 5,
          note: "预报风险指数（1-5 级），非实测花粉浓度"
        }),
        sourceLabel: "test-double",
        isForecast: true
      });
    }
    return entries;
  }

  private throwIfUnavailable(): void {
    if (this.mode === "unavailable") {
      throw new DomainError(
        "provider_unavailable",
        "环境供应商当前不可用",
        { retryable: true }
      );
    }
    if (this.mode === "timeout") {
      throw new DomainError(
        "provider_timeout",
        "环境供应商请求超时",
        { retryable: true }
      );
    }
  }
}
