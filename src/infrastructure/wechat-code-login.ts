import { DomainError } from "../kernel/errors.js";
import type { WechatLoginIdentity, WechatLoginPort } from "../modules/account/wechat-login-port.js";

interface WechatCodeLoginOptions {
  appId: string;
  appSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 微信 auth.code2Session 适配器：密钥只放服务端进程环境，不写日志或响应。 */
export class WechatCodeLogin implements WechatLoginPort {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: WechatCodeLoginOptions) {
    if (options.appId.trim() === "" || options.appSecret.trim() === "") {
      throw new DomainError("config_missing", "微信小程序登录配置不完整");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  async exchangeCode(code: string): Promise<WechatLoginIdentity> {
    const normalized = code.trim();
    if (normalized === "" || normalized.length > 256) {
      throw new DomainError("validation_failed", "微信登录码格式无效");
    }
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.searchParams.set("appid", this.options.appId);
    url.searchParams.set("secret", this.options.appSecret);
    url.searchParams.set("js_code", normalized);
    url.searchParams.set("grant_type", "authorization_code");
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) {
        throw new DomainError("provider_unavailable", "微信登录服务暂时不可用", { retryable: true });
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.openid !== "string" || payload.openid.trim() === "") {
        throw new DomainError("authentication_required", "微信登录码无效或已过期");
      }
      return { appId: this.options.appId, openId: payload.openid };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("provider_unavailable", "微信登录服务暂时不可用", { retryable: true, cause: error });
    }
  }
}
