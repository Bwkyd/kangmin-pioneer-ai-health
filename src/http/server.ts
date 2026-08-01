import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type KangminApplication
} from "../app/application.js";
import { createApplication } from "../app/composition-root.js";
import {
  DomainError,
  exitCodeForCode,
  httpStatusForCode
} from "../kernel/errors.js";
import { failure, success } from "../kernel/result.js";

const MAX_BODY_BYTES = 64 * 1024;
const SESSION_COOKIE = "kangmin_session";

type AppEnvironment = "local" | "integration" | "staging" | "production";

export interface HttpServerOptions {
  appEnvironment?: AppEnvironment;
  allowDevelopmentSession?: boolean;
  webRoot?: URL;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new DomainError(
        "payload_too_large",
        "请求内容不能超过 64 KiB"
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

function json(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
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

  return createServer(async (request, response) => {
    const requestUrl = new URL(
      request.url ?? "/",
      "http://127.0.0.1"
    );

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

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/dev/session"
    ) {
      if (!developmentSessionEnabled) {
        routeNotFound(response);
        return;
      }

      try {
        const body = await readJson(request);
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
          success("development session create", {
            developmentOnly: true,
            expiresAt: session.expiresAt
          })
        );
      } catch (error) {
        const result = failure("development session create", error);
        json(response, httpStatusForCode(result.error.code), result);
      }
      return;
    }

    if (
      request.method !== "POST" ||
      requestUrl.pathname !== "/v1/commands"
    ) {
      routeNotFound(response);
      return;
    }

    try {
      const body = await readJson(request);
      if (!isRecord(body) || typeof body.command !== "string") {
        throw new DomainError(
          "command_invalid",
          "请求必须包含 command 字符串"
        );
      }
      if (
        body.input !== undefined &&
        !isRecord(body.input)
      ) {
        throw new DomainError(
          "command_invalid",
          "input 必须是 JSON 对象"
        );
      }
      if (
        body.requestId !== undefined &&
        (
          typeof body.requestId !== "string" ||
          body.requestId.trim() === "" ||
          body.requestId.length > 120
        )
      ) {
        throw new DomainError(
          "command_invalid",
          "requestId 必须是 1 到 120 个字符的字符串"
        );
      }

      const result = await application.execute({
        command: body.command,
        input: body.input ?? {},
        sessionToken: sessionToken(request),
        requestId:
          typeof body.requestId === "string"
            ? body.requestId
            : undefined
      });
      json(
        response,
        result.ok ? 200 : httpStatusForCode(result.error.code),
        result
      );
    } catch (error) {
      const result = failure("http command", error);
      json(response, httpStatusForCode(result.error.code), result);
    }
  });
}

function appEnvironment(value: string | undefined): AppEnvironment {
  return value === "local" ||
    value === "integration" ||
    value === "staging" ||
    value === "production"
    ? value
    : "production";
}

async function main(): Promise<void> {
  const databasePath = resolve(
    process.env.KANGMIN_DB_PATH ?? ".local/kangmin-mvp.sqlite"
  );
  let application;
  try {
    application = createApplication(databasePath);
  } catch (error) {
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
      process.env.KANGMIN_ALLOW_DEV_SESSION === "1"
  });
  const port = Number(process.env.PORT ?? "8787");

  server.listen(port, "127.0.0.1", () => {
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
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
