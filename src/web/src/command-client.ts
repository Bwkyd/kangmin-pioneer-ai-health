/**
 * 患者命令客户端：薄壳唯一的数据通道。
 * POST /v1/patient/commands（CommandResult 信封），身份走 HttpOnly 会话
 * Cookie；本地/集成环境在 authentication_required 时自动引导一次
 * /dev/session 开发会话（生产环境该路由不存在，错误原样抛给界面）。
 */

const COMMAND_ENDPOINT = "/v1/patient/commands";
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
    const error = isRecord(payload.error) ? payload.error : {};
    throw new CommandError(
      typeof error.code === "string" ? error.code : "unknown",
      typeof error.message === "string" ? error.message : "请求失败",
      response.status,
      error.retryable === true
    );
  }
  return payload.data as T;
}

async function createDevelopmentSession(): Promise<boolean> {
  try {
    const response = await fetch("/dev/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "patient-web" })
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 每次页面生命周期只引导一次开发会话，避免并发请求重复创建。 */
let sessionBootstrap: Promise<boolean> | null = null;

export async function command<T>(
  name: string,
  input: Record<string, unknown> = {}
): Promise<T> {
  try {
    return await postCommand<T>(name, input);
  } catch (error) {
    if (error instanceof CommandError && error.code === "authentication_required") {
      sessionBootstrap ??= createDevelopmentSession();
      if (await sessionBootstrap) {
        return postCommand<T>(name, input);
      }
    }
    throw error;
  }
}
