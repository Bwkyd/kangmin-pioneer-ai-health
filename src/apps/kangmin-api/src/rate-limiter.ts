import type { IncomingMessage } from "node:http";

/** 限流路由类：strict 最严，upload 次之，commands 普通命令。 */
export type RateLimitClass = "strict" | "upload" | "commands";

export const DEFAULT_RATE_LIMITS: Record<RateLimitClass, number> = {
  strict: 10,
  upload: 30,
  commands: 120
};
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

export interface RateLimitOptions {
  /** /dev/session 与登录类命令每窗口上限（默认 10）。 */
  strictPerWindow?: number;
  /** /v1/*commands 普通命令每窗口上限（默认 120）。 */
  commandsPerWindow?: number;
  /** 上传类命令每窗口上限（默认 30）。 */
  uploadPerWindow?: number;
  /** 固定窗口长度毫秒（默认 60000；测试可缩短验证窗口恢复）。 */
  windowMs?: number;
  /**
   * 是否信任反向代理写入的 x-forwarded-for。默认关闭，避免客户端伪造
   * 请求头绕过按 IP 限流；只有服务端只接受受控代理流量时才应开启。
   */
  trustProxy?: boolean;
}

interface RateBucket {
  windowStart: number;
  count: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** 进程内固定窗口限流器：维度 = 限流作用域 × 路由类。 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly limits: Record<RateLimitClass, number>,
    private readonly windowMs: number
  ) {
    this.sweeper = setInterval(() => this.sweep(), this.windowMs);
    this.sweeper.unref();
  }

  check(
    identifier: string,
    routeClass: RateLimitClass,
    scope = "client-ip"
  ): RateLimitDecision {
    const now = Date.now();
    const key = `${routeClass}:${scope}:${identifier}`;
    const existing = this.buckets.get(key);
    if (existing === undefined || now - existing.windowStart >= this.windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    existing.count += 1;
    if (existing.count > this.limits[routeClass]) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((existing.windowStart + this.windowMs - now) / 1000)
        )
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  dispose(): void {
    clearInterval(this.sweeper);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) this.buckets.delete(key);
    }
  }
}

/**
 * 客户端 IP：默认只取 TCP 对端地址；仅在明确配置受控反向代理时才
 * 使用 x-forwarded-for 首段。任意客户端可直达本进程时不得信任该头。
 */
export function clientIp(request: IncomingMessage, trustProxy: boolean): string {
  if (!trustProxy) return request.socket.remoteAddress ?? "unknown";
  const forwarded = request.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(",")[0]?.trim();
  return first !== undefined && first !== ""
    ? first
    : request.socket.remoteAddress ?? "unknown";
}

/** 登录限流同时按账号与受信客户端 IP 计数，两个维度任一超限即拒绝。 */
export function loginRateLimit(
  rateLimiter: FixedWindowRateLimiter,
  request: IncomingMessage,
  input: Record<string, unknown>,
  trustProxy: boolean
): RateLimitDecision {
  const username = typeof input.username === "string"
    ? input.username.trim().toLowerCase()
    : "<missing>";
  const accountDecision = rateLimiter.check(username || "<missing>", "strict", "account");
  const ipDecision = rateLimiter.check(clientIp(request, trustProxy), "strict", "client-ip");
  if (accountDecision.allowed && ipDecision.allowed) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(
      accountDecision.retryAfterSeconds,
      ipDecision.retryAfterSeconds
    )
  };
}

/** 命令路由类判定：登录类最严；直传票据/远程素材入库归上传类。 */
export function commandRateLimitClass(command: string): RateLimitClass {
  if (command === "account login" || command === "auth login") return "strict";
  if (
    command.includes("upload-init") ||
    command.includes("upload-confirm") ||
    command.includes("add-from-media")
  ) return "upload";
  return "commands";
}
