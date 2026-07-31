import { createServer, type IncomingMessage, type Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createApplication,
  type KangminApplication
} from "../app/application.js";
import { DomainError, httpStatusForCode } from "../kernel/errors.js";
import { failure } from "../kernel/result.js";

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new Error("request_too_large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function bearer(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  return undefined;
}

export function createKangminHttpServer(
  application: KangminApplication
): Server {
  return createServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");

    if (request.method === "GET" && request.url === "/health") {
      response.statusCode = 200;
      response.end(JSON.stringify({ ok: true, status: "ready" }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/v1/commands") {
      response.statusCode = 404;
      response.end(
        JSON.stringify(
          failure(
            "http route",
            new DomainError("resource_not_found", "接口不存在")
          )
        )
      );
      return;
    }

    try {
      const body = await readJson(request);
      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { command?: unknown }).command !== "string"
      ) {
        throw new DomainError(
          "command_invalid",
          "请求必须包含 command 字符串"
        );
      }

      const commandBody = body as {
        command: string;
        input?: Record<string, unknown>;
        requestId?: string;
      };
      const result = application.execute({
        command: commandBody.command,
        input: commandBody.input ?? {},
        sessionToken: bearer(request),
        requestId: commandBody.requestId
      });
      response.statusCode = result.ok
        ? 200
        : httpStatusForCode(result.error.code);
      response.end(JSON.stringify(result));
    } catch (error) {
      const result = failure("http command", error);
      response.statusCode = 400;
      response.end(JSON.stringify(result));
    }
  });
}

async function main(): Promise<void> {
  const databasePath = resolve(
    process.env.KANGMIN_DB_PATH ?? ".local/kangmin-mvp.sqlite"
  );
  const application = createApplication(databasePath);
  const server = createKangminHttpServer(application);
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
