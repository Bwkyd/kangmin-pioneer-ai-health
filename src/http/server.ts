import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type KangminApplication
} from "../app/application.js";
import {
  createApplicationWithOps,
  createStructuredRequestLogger,
  logLevelForStatus,
  type ReadinessProbe,
  type RequestLogger
} from "../app/composition-root.js";
import {
  type KangminAdminApplication
} from "../app/admin-application.js";
import { createAdminApplicationWithOps } from "../app/admin-composition-root.js";
import {
  DomainError,
  exitCodeForCode,
  httpStatusForCode,
  type ErrorCode
} from "../kernel/errors.js";
import { failure, success, type FailureResult } from "../kernel/result.js";
import {
  COMMAND_PROTOCOL_VERSION,
  COMMAND_SCHEMA_VERSION,
  type CommandServiceMeta
} from "../kernel/protocol.js";

/**
 * 请求体大小上限默认值：保持既有 64 KiB 契约（http.e2e 既有断言）。
 * 生产入口 main() 按 KANGMIN_HTTP_BODY_LIMIT 覆盖，缺省放宽到 1 MiB。
 */
const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const SESSION_COOKIE = "kangmin_session";

/** 限流路由类：strict 最严，upload 次之，commands 普通命令。 */
type RateLimitClass = "strict" | "upload" | "commands";

const DEFAULT_RATE_LIMITS: Record<RateLimitClass, number> = {
  strict: 10,
  upload: 30,
  commands: 120
};
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

type AppEnvironment = "local" | "integration" | "staging" | "production";

export interface RateLimitOptions {
  /** /dev/session 与登录类命令每窗口上限（默认 10）。 */
  strictPerWindow?: number;
  /** /v1/*commands 普通命令每窗口上限（默认 120）。 */
  commandsPerWindow?: number;
  /** 上传类命令每窗口上限（默认 30）。 */
  uploadPerWindow?: number;
  /** 固定窗口长度毫秒（默认 60000；测试可缩短验证窗口恢复）。 */
  windowMs?: number;
}

export interface HttpServerOptions {
  appEnvironment?: AppEnvironment;
  allowDevelopmentSession?: boolean;
  webRoot?: URL;
  adminApplication?: KangminAdminApplication | undefined;
  serviceVersion?: string | undefined;
  /** /ready 探针（组合根注入；缺省为空集，语义上不就绪项为零）。 */
  readinessProbes?: ReadinessProbe[];
  /** 请求体大小上限字节（默认 64 KiB，保持既有契约）。 */
  bodyLimitBytes?: number;
  /** 单请求整体超时毫秒（默认 30000），超限返回 408。 */
  requestTimeoutMs?: number;
  /** 进程内固定窗口限流配置（默认见 DEFAULT_RATE_LIMITS）。 */
  rateLimits?: RateLimitOptions;
  /** 结构化请求日志（默认写 stderr 单行 JSON，字段固定且脱敏）。 */
  requestLogger?: RequestLogger;
}

interface RateBucket {
  windowStart: number;
  count: number;
}

interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * 进程内固定窗口限流器：维度 = 客户端 IP × 路由类。
 * 窗口过期条目由定时器定期清理，避免长期运行内存膨胀。
 */
class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly limits: Record<RateLimitClass, number>,
    private readonly windowMs: number
  ) {
    // unref：清理定时器不阻止进程退出。
    this.sweeper = setInterval(() => {
      this.sweep();
    }, this.windowMs);
    this.sweeper.unref();
  }

  check(ip: string, routeClass: RateLimitClass): RateLimitDecision {
    const now = Date.now();
    const key = `${routeClass}:${ip}`;
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
      if (now - bucket.windowStart >= this.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}

/** 客户端 IP：x-forwarded-for 首段，缺省回退 socket 对端地址。 */
function clientIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(",")[0]?.trim();
  if (first !== undefined && first !== "") {
    return first;
  }
  return request.socket.remoteAddress ?? "unknown";
}

/** 命令路由类判定：登录类最严；直传票据/远程素材入库归上传类。 */
function commandRateLimitClass(command: string): RateLimitClass {
  if (command === "account login" || command === "auth login") {
    return "strict";
  }
  if (
    command.includes("upload-init") ||
    command.includes("upload-confirm") ||
    command.includes("add-from-media")
  ) {
    return "upload";
  }
  return "commands";
}

async function readJson(
  request: IncomingMessage,
  maxBodyBytes: number
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new DomainError(
        "payload_too_large",
        "请求内容超过大小限制"
      );
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new DomainError(
      "invalid_json",
      "请求必须是有效 JSON",
      { cause: error }
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function cookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) {
    return undefined;
  }

  for (const part of header.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) {
      const value = valueParts.join("=");
      if (value === "") {
        return undefined;
      }
      try {
        return decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function sessionToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  return cookie(request, SESSION_COOKIE);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
}

function json(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  // 整体超时已结束响应时，后续迟到的写入一律丢弃（处理器无法中断，
  // 但绝不允许二次写响应）。
  if (response.writableEnded) {
    return;
  }
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.end(JSON.stringify(body));
}

async function staticAsset(
  response: ServerResponse,
  webRoot: URL,
  filename: string,
  contentType: string
): Promise<void> {
  try {
    const body = await readFile(new URL(filename, webRoot));
    if (response.writableEnded) {
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", contentType);
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );
    response.end(body);
  } catch (error) {
    json(
      response,
      503,
      failure(
        "web asset",
        new DomainError(
          "storage_unavailable",
          "患者页面资源不可用",
          { retryable: true, cause: error }
        )
      )
    );
  }
}

function routeNotFound(response: ServerResponse): void {
  json(
    response,
    404,
    failure(
      "http route",
      new DomainError("resource_not_found", "接口不存在")
    )
  );
}

/**
 * 媒体 id 白名单：照 newId("med") 生成格式 med_<12 位小写十六进制>。
 * 含 ..、斜杠、编码绕过或任何非法字符一律不匹配（路由按 404 处理，
 * 不区分 400/404，不泄露资源存在性）。
 */
const MEDIA_ID_PATTERN = /^med_[0-9a-f]{12}$/;

/**
 * 公开媒体路由（GET /v1/media/:id，媒体交付链 issue-151）：不套命令
 * 信封，直接发字节流；公开范围门禁（仅 published 内容引用）与素材
 * 可用性由 browse 服务判定，这里只做 id 白名单与响应头。
 * 不套用命令限流分类（与静态资源一致：公开只读、按 id 寻址且不可变，
 * 缓存语义清晰），媒体内容不可变故 Cache-Control 公开缓存 1 小时。
 */
async function mediaAsset(
  response: ServerResponse,
  application: KangminApplication,
  pathname: string
): Promise<void> {
  let mediaId: string;
  try {
    mediaId = decodeURIComponent(pathname.slice("/v1/media/".length));
  } catch {
    mediaId = "";
  }
  if (!MEDIA_ID_PATTERN.test(mediaId)) {
    routeNotFound(response);
    return;
  }
  try {
    const media = await application.getPublishedMedia(mediaId);
    if (media === null) {
      routeNotFound(response);
      return;
    }
    if (response.writableEnded) {
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", media.contentType);
    response.setHeader("content-length", media.body.length);
    response.setHeader("cache-control", "public, max-age=3600");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.end(media.body);
  } catch (error) {
    json(
      response,
      503,
      failure(
        "media asset",
        new DomainError(
          "storage_unavailable",
          "媒体资源不可用",
          { retryable: true, cause: error }
        )
      )
    );
  }
}

/**
 * 429 信封：rate_limited 是 HTTP 传输层补充码，不在 kernel 错误码表
 * （该表由其它 issue 维护），这里显式构造并保持 CommandResult 信封
 * 风格；retryAfter 作为信封附加顶层字段，同时回写 Retry-After 头。
 */
function rateLimitedResult(
  command: string,
  requestId: string,
  retryAfterSeconds: number
): FailureResult & { retryAfter: number } {
  const result = failure(
    command,
    new DomainError(
      "rate_limited" as ErrorCode,
      "请求过于频繁，请稍后重试",
      { retryable: true }
    ),
    requestId
  );
  return { ...result, retryAfter: retryAfterSeconds };
}

/** 408 信封：与 rate_limited 同理的 HTTP 传输层补充码。 */
function requestTimeoutResult(
  requestId: string
): FailureResult {
  return failure(
    "http request",
    new DomainError(
      "request_timeout" as ErrorCode,
      "请求处理超时，请稍后重试",
      { retryable: true }
    ),
    requestId
  );
}

export function createKangminHttpServer(
  application: KangminApplication,
  options: HttpServerOptions = {}
): Server {
  const environment = options.appEnvironment ?? "production";
  const developmentSessionEnabled =
    options.allowDevelopmentSession === true &&
    (environment === "local" || environment === "integration");
  const webRoot =
    options.webRoot ?? new URL("../web/", import.meta.url);
  const serviceMeta: CommandServiceMeta = {
    service: "kangmin-command-service",
    serviceVersion: options.serviceVersion ?? "0.1.0",
    protocolVersion: COMMAND_PROTOCOL_VERSION,
    schemaVersion: COMMAND_SCHEMA_VERSION,
    audiences: ["patient", "admin"]
  };
  const readinessProbes = options.readinessProbes ?? [];
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const requestLogger =
    options.requestLogger ?? createStructuredRequestLogger();
  const rateLimiter = new FixedWindowRateLimiter(
    {
      strict:
        options.rateLimits?.strictPerWindow ?? DEFAULT_RATE_LIMITS.strict,
      upload:
        options.rateLimits?.uploadPerWindow ?? DEFAULT_RATE_LIMITS.upload,
      commands:
        options.rateLimits?.commandsPerWindow ?? DEFAULT_RATE_LIMITS.commands
    },
    options.rateLimits?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS
  );

  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    // 请求关联号：优先请求体 requestId（命令路由解析后回写），否则生成
    // uuid；始终回写 x-request-id 响应头供排障关联。
    let requestId: string = randomUUID();
    response.setHeader("x-request-id", requestId);

    // 单请求整体超时：超时即 408（传输层补充码 request_timeout），
    // 处理器迟到的写入由 json/staticAsset 的 writableEnded 守卫丢弃。
    const timeout = setTimeout(() => {
      json(response, 408, requestTimeoutResult(requestId));
    }, requestTimeoutMs);
    timeout.unref();

    // 结构化请求日志：响应完成时写一行；字段固定，绝不记录请求体、
    // 令牌、手机号、健康内容（429 的 warn 行即限流审计记录）。
    response.on("finish", () => {
      clearTimeout(timeout);
      requestLogger({
        ts: new Date().toISOString(),
        level: logLevelForStatus(response.statusCode),
        requestId,
        method: request.method ?? "UNKNOWN",
        path: requestUrl.pathname,
        status: response.statusCode,
        durationMs: Date.now() - startedAt
      });
    });

    const requestUrl = new URL(
      request.url ?? "/",
      "http://127.0.0.1"
    );

    // 存活探针：无任何依赖，进程能响应即 ok。
    if (request.method === "GET" && requestUrl.pathname === "/live") {
      json(response, 200, { status: "ok" });
      return;
    }

    // 就绪探针：逐项执行组合根注入的探针；全 ok 才 200 ready:true，
    // 任一 failed 或 not_configured 一律 503 ready:false。
    if (request.method === "GET" && requestUrl.pathname === "/ready") {
      const checks = await Promise.all(
        readinessProbes.map(async (probe) => {
          try {
            const result = await probe.run();
            return {
              name: probe.name,
              status: result.status,
              message: result.message
            };
          } catch {
            // 探针自身抛错视同 failed：不就绪必须显式可见。
            return {
              name: probe.name,
              status: "failed" as const,
              message: "探针执行失败"
            };
          }
        })
      );
      const ready = checks.every((check) => check.status === "ok");
      json(response, ready ? 200 : 503, { ready, checks });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/v1/meta") {
      json(response, 200, serviceMeta);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      json(response, 200, { ok: true, status: "ready" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/") {
      await staticAsset(
        response,
        webRoot,
        "index.html",
        "text/html; charset=utf-8"
      );
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/assets/app.js"
    ) {
      await staticAsset(
        response,
        webRoot,
        "app.js",
        "text/javascript; charset=utf-8"
      );
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/assets/styles.css"
    ) {
      await staticAsset(
        response,
        webRoot,
        "styles.css",
        "text/css; charset=utf-8"
      );
      return;
    }

    // 公开媒体路由：已发布内容引用的媒体字节（非命令信封）。
    if (
      request.method === "GET" &&
      requestUrl.pathname.startsWith("/v1/media/")
    ) {
      await mediaAsset(response, application, requestUrl.pathname);
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/dev/session"
    ) {
      if (!developmentSessionEnabled) {
        routeNotFound(response);
        return;
      }

      // 开发会话路由按路径归 strict 类，解析请求体之前先限流。
      const decision = rateLimiter.check(clientIp(request), "strict");
      if (!decision.allowed) {
        response.setHeader("retry-after", String(decision.retryAfterSeconds));
        json(
          response,
          429,
          rateLimitedResult(
            "development session create",
            requestId,
            decision.retryAfterSeconds
          )
        );
        return;
      }

      try {
        const body = await readJson(request, bodyLimitBytes);
        if (!isRecord(body) || typeof body.subject !== "string") {
          throw new DomainError(
            "command_invalid",
            "开发会话请求必须包含 subject 字符串"
          );
        }
        const session =
          await application.sessions.createDevelopmentSession(body.subject);
        response.setHeader(
          "set-cookie",
          `${SESSION_COOKIE}=${encodeURIComponent(session.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`
        );
        json(
          response,
          201,
          success(
            "development session create",
            {
              developmentOnly: true,
              expiresAt: session.expiresAt
            },
            requestId
          )
        );
      } catch (error) {
        const result = failure("development session create", error, requestId);
        json(response, httpStatusForCode(result.error.code), result);
      }
      return;
    }

    const patientCommandRoute =
      requestUrl.pathname === "/v1/commands" ||
      requestUrl.pathname === "/v1/patient/commands";
    const adminCommandRoute = requestUrl.pathname === "/v1/admin/commands";
    if (request.method !== "POST" || (!patientCommandRoute && !adminCommandRoute)) {
      routeNotFound(response);
      return;
    }

    try {
      const body = await readJson(request, bodyLimitBytes);
      if (!isRecord(body) || typeof body.command !== "string") {
        throw new DomainError(
          "command_invalid",
          "请求必须包含 command 字符串"
        );
      }
      const versionedCommandRoute = requestUrl.pathname !== "/v1/commands";
      if (
        versionedCommandRoute &&
        body.schemaVersion !== COMMAND_SCHEMA_VERSION
      ) {
        throw new DomainError(
          "protocol_incompatible",
          `命令 schemaVersion 必须是 ${COMMAND_SCHEMA_VERSION}`
        );
      }
      if (
        (versionedCommandRoute && !isRecord(body.input)) ||
        (body.input !== undefined && !isRecord(body.input))
      ) {
        throw new DomainError(
          "command_invalid",
          "input 必须是 JSON 对象"
        );
      }
      if (
        (versionedCommandRoute && body.requestId === undefined) ||
        (body.requestId !== undefined &&
          (
            typeof body.requestId !== "string" ||
            body.requestId.trim() === "" ||
            body.requestId.length > 120
          ))
      ) {
        throw new DomainError(
          "command_invalid",
          "requestId 必须是 1 到 120 个字符的字符串"
        );
      }

      // 请求体验证通过后采用客户端 requestId 作为关联号并回写响应头。
      if (typeof body.requestId === "string") {
        requestId = body.requestId;
        response.setHeader("x-request-id", requestId);
      }

      // 命令路由按命令归类限流（登录类 strict、上传类 upload、其余
      // commands）；超限返回 429，信封保持 CommandResult 风格。
      const decision = rateLimiter.check(
        clientIp(request),
        commandRateLimitClass(body.command)
      );
      if (!decision.allowed) {
        response.setHeader("retry-after", String(decision.retryAfterSeconds));
        json(
          response,
          429,
          rateLimitedResult(
            body.command,
            requestId,
            decision.retryAfterSeconds
          )
        );
        return;
      }

      const result = adminCommandRoute
        ? options.adminApplication === undefined
          ? failure(
              body.command,
              new DomainError("capability_unavailable", "管理命令服务未配置"),
              requestId
            )
          : await options.adminApplication.execute({
              command: body.command,
              input: body.input ?? {},
              adminToken: bearerToken(request),
              requestId
            })
        : await application.execute({
            command: body.command,
            input: body.input ?? {},
            sessionToken: sessionToken(request),
            requestId
          });
      json(
        response,
        result.ok ? 200 : httpStatusForCode(result.error.code),
        result
      );
    } catch (error) {
      const result = failure("http command", error, requestId);
      json(response, httpStatusForCode(result.error.code), result);
    }
  });
  server.on("close", () => {
    rateLimiter.dispose();
  });
  return server;
}

function appEnvironment(value: string | undefined): AppEnvironment {
  return value === "local" ||
    value === "integration" ||
    value === "staging" ||
    value === "production"
    ? value
    : "production";
}

/** 正整数环境变量解析：未设置或非法时返回 undefined（回退默认值）。 */
function positiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : undefined;
}

async function main(): Promise<void> {
  const databasePath = resolve(
    process.env.KANGMIN_DB_PATH ?? ".local/kangmin-mvp.sqlite"
  );
  let application;
  let adminApplication;
  let readinessProbes: ReadinessProbe[] = [];
  try {
    // 组合根负责生产 fail-closed 校验与探针装配；server 不直接触碰仓储。
    const patientOps = createApplicationWithOps(databasePath);
    application = patientOps.application;
    const adminOps = createAdminApplicationWithOps(databasePath, {
      mediaDirectory: resolve(
        process.env.KANGMIN_ADMIN_MEDIA_DIR ??
          join(dirname(databasePath), "admin-media")
      )
    });
    adminApplication = adminOps.application;
    readinessProbes = [
      patientOps.readinessProbes.database,
      adminOps.readinessProbes.objectStorage,
      patientOps.readinessProbes.encryption,
      patientOps.readinessProbes.environmentProvider,
      patientOps.readinessProbes.rulePackage
    ];
  } catch (error) {
    application?.close();
    // 启动前置条件缺失（如生产缺加密密钥的 config_missing）走友好
    // 消息 + 对应退出码，不抛未捕获堆栈；非领域错误原样透传。
    if (error instanceof DomainError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      process.exitCode = exitCodeForCode(error.code);
      return;
    }
    throw error;
  }
  const server = createKangminHttpServer(application, {
    appEnvironment: appEnvironment(process.env.KANGMIN_APP_ENV),
    allowDevelopmentSession:
      process.env.KANGMIN_ALLOW_DEV_SESSION === "1",
    adminApplication,
    readinessProbes,
    // 生产默认 1 MiB（KANGMIN_HTTP_BODY_LIMIT 可覆盖）；直接创建
    // server 的调用方保持 64 KiB 既有默认契约。
    bodyLimitBytes:
      positiveIntegerEnv(process.env.KANGMIN_HTTP_BODY_LIMIT) ?? 1024 * 1024,
    requestTimeoutMs:
      positiveIntegerEnv(process.env.KANGMIN_HTTP_TIMEOUT_MS) ??
      DEFAULT_REQUEST_TIMEOUT_MS,
    rateLimits: {
      strictPerWindow:
        positiveIntegerEnv(process.env.KANGMIN_RATE_LIMIT_STRICT_PER_MINUTE) ??
        DEFAULT_RATE_LIMITS.strict,
      commandsPerWindow:
        positiveIntegerEnv(
          process.env.KANGMIN_RATE_LIMIT_COMMANDS_PER_MINUTE
        ) ?? DEFAULT_RATE_LIMITS.commands,
      uploadPerWindow:
        positiveIntegerEnv(process.env.KANGMIN_RATE_LIMIT_UPLOAD_PER_MINUTE) ??
        DEFAULT_RATE_LIMITS.upload
    }
  });
  const port = Number(process.env.PORT ?? "8787");
  // 默认仅回环（防误暴露）；容器/编排部署用 KANGMIN_HTTP_HOST=0.0.0.0。
  const host = process.env.KANGMIN_HTTP_HOST ?? "127.0.0.1";

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort =
      typeof address === "object" && address !== null ? address.port : port;
    process.stdout.write(
      `${JSON.stringify({ ok: true, port: actualPort })}\n`
    );
  });

  const shutdown = (): void => {
    server.close(() => {
      application.close();
      adminApplication.close();
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
