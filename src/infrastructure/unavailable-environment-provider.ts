import { DomainError } from "../kernel/errors.js";
import type {
  EnvironmentProviderPort,
  EnvironmentSnapshot,
  ForecastDay
} from "../modules/environment/environment-ports.js";

/**
 * 不可用环境 Provider（组合根环境门禁的 fail-closed 实现）。
 *
 * 测试替身（TestEnvironmentProvider）只允许在 local/integration 或显式
 * KANGMIN_ALLOW_DEV_SESSION=1（且非 staging/production）时使用；其余
 * 环境（含 CLI 默认未设 KANGMIN_APP_ENV）由组合根改注入本实现——
 * 所有方法抛 provider_unavailable，绝不在非开发环境返回固定假数据。
 */
export class UnavailableEnvironmentProvider
  implements EnvironmentProviderPort
{
  readonly providerId = "unavailable";

  current(_location: string): Promise<EnvironmentSnapshot> {
    return Promise.reject(this.unavailable());
  }

  forecast(_location: string, _days: number): Promise<ForecastDay[]> {
    return Promise.reject(this.unavailable());
  }

  private unavailable(): DomainError {
    return new DomainError(
      "provider_unavailable",
      "当前环境未配置环境数据供应商（测试替身仅限 local/integration 或显式 KANGMIN_ALLOW_DEV_SESSION=1）",
      { retryable: true }
    );
  }
}
