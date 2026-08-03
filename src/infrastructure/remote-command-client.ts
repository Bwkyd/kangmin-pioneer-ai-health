import { randomUUID } from "node:crypto";

import { DomainError } from "../kernel/errors.js";
import {
  COMMAND_PROTOCOL_VERSION,
  COMMAND_SCHEMA_VERSION,
  isCommandResult,
  isCommandServiceMeta,
  type RemoteCommandRequest
} from "../kernel/protocol.js";
import type { CommandResult } from "../kernel/result.js";

export type CommandAudience = "patient" | "admin";

export interface RemoteCommandClientOptions {
  baseUrl: string;
  audience: CommandAudience;
  token?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface RemoteCommandInput {
  command: string;
  input?: Record<string, unknown> | undefined;
  requestId?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function normalizedBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new DomainError("config_missing", "KANGMIN_API_BASE_URL 必须是有效 URL", {
      cause: error
    });
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new DomainError(
      "config_missing",
      "KANGMIN_API_BASE_URL 只允许不含凭据、查询和片段的 http(s) 地址"
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url;
}

function timeoutOf(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120_000) {
    throw new DomainError(
      "config_missing",
      "KANGMIN_API_TIMEOUT_MS 必须是 100 到 120000 的整数"
    );
  }
  return timeout;
}

export class RemoteCommandClient {
  private readonly baseUrl: URL;
  private readonly audience: CommandAudience;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RemoteCommandClientOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    this.audience = options.audience;
    this.token = options.token;
    this.timeoutMs = timeoutOf(options.timeoutMs);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(input: RemoteCommandInput): Promise<CommandResult> {
    await this.assertCompatible();
    const request: RemoteCommandRequest = {
      schemaVersion: COMMAND_SCHEMA_VERSION,
      command: input.command,
      input: input.input ?? {},
      requestId: input.requestId ?? randomUUID()
    };
    const response = await this.request(
      new URL(`v1/${this.audience}/commands`, this.baseUrl),
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(request)
      }
    );
    const body = await this.jsonBody(response);
    if (
      !isCommandResult(body) ||
      body.meta.requestId !== request.requestId ||
      body.receipt.requestId !== request.requestId
    ) {
      throw new DomainError(
        "protocol_incompatible",
        "远程命令服务返回了不兼容或无法关联的命令结果"
      );
    }
    return body;
  }

  private async assertCompatible(): Promise<void> {
    const response = await this.request(new URL("v1/meta", this.baseUrl), {
      method: "GET",
      headers: this.headers(false)
    });
    if (!response.ok) {
      throw new DomainError(
        "service_unavailable",
        `远程命令服务元数据不可用（HTTP ${response.status}）`,
        { retryable: response.status >= 500 }
      );
    }
    const body = await this.jsonBody(response);
    if (!isCommandServiceMeta(body)) {
      throw new DomainError(
        "protocol_incompatible",
        `远程命令协议不兼容，客户端需要 ${COMMAND_PROTOCOL_VERSION}/${COMMAND_SCHEMA_VERSION}`
      );
    }
  }

  private headers(withContentType: boolean): Record<string, string> {
    return {
      ...(withContentType ? { "content-type": "application/json" } : {}),
      ...(this.token === undefined || this.token.trim() === ""
        ? {}
        : { authorization: `Bearer ${this.token}` })
    };
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new DomainError(
        "service_unavailable",
        "无法连接远程命令服务",
        { retryable: true, cause: error }
      );
    }
  }

  private async jsonBody(response: Response): Promise<unknown> {
    try {
      return await response.json() as unknown;
    } catch (error) {
      throw new DomainError(
        "protocol_incompatible",
        "远程命令服务返回了非 JSON 响应",
        { cause: error }
      );
    }
  }
}

export function remoteTimeout(environment: NodeJS.ProcessEnv): number | undefined {
  const value = environment.KANGMIN_API_TIMEOUT_MS;
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return Number(value);
}
