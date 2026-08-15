/**
 * 患者命令客户端：薄壳唯一的数据通道。
 * POST /v1/patient/commands（CommandResult 信封），身份走 HttpOnly 会话
 * Cookie；本地/集成环境在 authentication_required 时自动引导一次
 * /dev/session 开发会话（生产环境该路由不存在，错误原样抛给界面）。
 */

const COMMAND_ENDPOINT = "/v1/patient/commands";
const AGENT_STREAM_ENDPOINT = "/v1/patient/agent/stream";
const SCHEMA_VERSION = "1";

export class CommandError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, status: number, retryable = false) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandError(payload: unknown, status: number): CommandError {
  if (isRecord(payload) && payload.ok === false) {
    const error = isRecord(payload.error) ? payload.error : {};
    return new CommandError(
      typeof error.code === "string" ? error.code : "unknown",
      typeof error.message === "string" ? error.message : "请求失败",
      status,
      error.retryable === true
    );
  }
  return new CommandError("bad_response", "服务返回格式不正确", status);
}

async function postCommand<T>(
  command: string,
  input: Record<string, unknown>
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(COMMAND_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        command,
        input,
        requestId: crypto.randomUUID()
      })
    });
  } catch {
    throw new CommandError(
      "network_error",
      "服务暂时无法连接，当前输入没有保存",
      0,
      true
    );
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!isRecord(payload) || typeof payload.ok !== "boolean") {
    throw new CommandError("bad_response", "服务返回格式不正确", response.status);
  }
  if (payload.ok === false) {
    throw commandError(payload, response.status);
  }
  return payload.data as T;
}

export interface StreamCommandHandlers {
  onStart(): void;
  onDelta(content: string): void;
}

async function postStreamCommand<T>(
  input: Record<string, unknown>,
  handlers: StreamCommandHandlers
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(AGENT_STREAM_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson"
      },
      body: JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        input,
        requestId: crypto.randomUUID()
      })
    });
  } catch {
    throw new CommandError(
      "network_error",
      "服务暂时无法连接，当前输入可能已保存，请刷新后确认",
      0
    );
  }

  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    throw commandError(payload, response.status);
  }
  if (response.body === null) {
    throw new CommandError("bad_response", "服务未返回流式正文", response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: T | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (line.trim() === "") continue;
        const event = JSON.parse(line) as unknown;
        if (!isRecord(event) || typeof event.type !== "string") {
          throw new CommandError("bad_response", "流式事件格式不正确", response.status);
        }
        if (event.type === "start") {
          handlers.onStart();
        } else if (event.type === "delta" && typeof event.content === "string") {
          handlers.onDelta(event.content);
        } else if (event.type === "done") {
          completed = event.data as T;
        } else {
          throw new CommandError("bad_response", "流式事件类型不正确", response.status);
        }
      }
      if (done) break;
    }
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(
      "stream_interrupted",
      "回答传输中断，结果可能已保存，请刷新后恢复",
      response.status
    );
  }
  if (completed === null) {
    throw new CommandError(
      "stream_interrupted",
      "回答传输未完成，结果可能已保存，请刷新后恢复",
      response.status
    );
  }
  return completed;
}

async function createDevelopmentSession(): Promise<boolean> {
  try {
    const response = await fetch("/dev/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      // 预览身份由服务端生成并写入 HttpOnly Cookie，前端不再提交固定
      // subject，避免不同浏览器共享同一患者记录。
      body: JSON.stringify({})
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 同一时刻只引导一次开发会话，会话过期后可再次恢复。 */
let sessionBootstrap: Promise<boolean> | null = null;

async function ensureDevelopmentSession(): Promise<boolean> {
  sessionBootstrap ??= createDevelopmentSession();
  try {
    return await sessionBootstrap;
  } finally {
    sessionBootstrap = null;
  }
}

export async function command<T>(
  name: string,
  input: Record<string, unknown> = {}
): Promise<T> {
  try {
    return await postCommand<T>(name, input);
  } catch (error) {
    if (error instanceof CommandError && error.code === "authentication_required") {
      if (await ensureDevelopmentSession()) {
        return postCommand<T>(name, input);
      }
    }
    throw error;
  }
}

/** agent exec 专用流式通道；认证恢复与普通命令保持一致。 */
export async function streamAgentCommand<T>(
  input: Record<string, unknown>,
  handlers: StreamCommandHandlers
): Promise<T> {
  try {
    return await postStreamCommand<T>(input, handlers);
  } catch (error) {
    if (error instanceof CommandError && error.code === "authentication_required") {
      if (await ensureDevelopmentSession()) {
        return postStreamCommand<T>(input, handlers);
      }
    }
    throw error;
  }
}
