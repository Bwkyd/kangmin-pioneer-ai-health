const WINDOW_MS = 60_000;

interface WindowEntry {
  count: number;
  startedAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class InMemoryAgentLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private activeModelRequests = 0;

  consume(
    key: string,
    limit: number,
    now = Date.now(),
    windowMs = WINDOW_MS,
  ): RateLimitResult {
    const current = this.windows.get(key);
    const entry =
      !current || now - current.startedAt >= windowMs
        ? { count: 0, startedAt: now }
        : current;

    entry.count += 1;
    this.windows.set(key, entry);

    if (entry.count <= limit) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((entry.startedAt + windowMs - now) / 1_000),
      ),
    };
  }

  acquireModelSlot(maxConcurrent = 2): (() => void) | null {
    if (this.activeModelRequests >= maxConcurrent) {
      return null;
    }

    this.activeModelRequests += 1;
    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activeModelRequests = Math.max(0, this.activeModelRequests - 1);
    };
  }
}

export function getRequestClientKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const candidate =
    forwardedFor?.split(",")[0]?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    "anonymous";

  return candidate.slice(0, 128);
}

export const agentLimiter = new InMemoryAgentLimiter();
