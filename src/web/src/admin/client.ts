const ENDPOINT = "/v1/admin/commands";
const SESSION_ENDPOINT = "/v1/admin/session";

export class AdminRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "AdminRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function dataOf<T>(response: Response): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AdminRequestError("bad_response", "服务返回格式不正确", response.status);
  }
  if (!isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
    throw new AdminRequestError(
      typeof error.code === "string" ? error.code : "unknown",
      typeof error.message === "string" ? error.message : "请求失败",
      response.status
    );
  }
  return payload.data as T;
}

export interface AdminSession {
  loggedIn: boolean;
  adminId: string | null;
  username: string | null;
  role: "owner" | "admin" | null;
  expiresAt: string | null;
}

export async function sessionStatus(): Promise<AdminSession> {
  return dataOf(await fetch(SESSION_ENDPOINT, { credentials: "same-origin" }));
}

export async function login(username: string, password: string): Promise<AdminSession> {
  await dataOf(await fetch(SESSION_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ username, password })
  }));
  return sessionStatus();
}

export async function logout(): Promise<void> {
  await dataOf(await fetch(SESSION_ENDPOINT, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { accept: "application/json" }
  }));
}

export async function adminCommand<T>(
  command: string,
  input: Record<string, unknown> = {}
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        schemaVersion: "1",
        command,
        input,
        requestId: crypto.randomUUID()
      })
    });
  } catch {
    throw new AdminRequestError("network_error", "服务暂时无法连接", 0);
  }
  return dataOf<T>(response);
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface MediaItem {
  id: string;
  filename: string;
  kind: string;
  sizeBytes: number;
  status: string;
  mimeType?: string | null;
  failureReason?: string | null;
}

interface UploadInit {
  status: "completed" | "uploading";
  media?: MediaItem;
  mediaId?: string;
  ticket?: { url: string; method: "PUT"; headers: Record<string, string> };
}

export async function uploadFile(file: File, kind?: "image" | "video"): Promise<MediaItem> {
  const sha256 = hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  const init = await adminCommand<UploadInit>("content media upload-init", {
    filename: file.name,
    sizeBytes: file.size,
    sha256,
    ...(kind === undefined ? {} : { kind })
  });
  if (init.status === "completed" && init.media !== undefined) return init.media;
  if (init.mediaId === undefined || init.ticket === undefined) {
    throw new AdminRequestError("bad_response", "上传票据信息不完整", 500);
  }
  const ticketUrl = new URL(init.ticket.url, window.location.href);
  const sameOrigin = ticketUrl.origin === window.location.origin;
  const uploaded = await fetch(ticketUrl, {
    method: init.ticket.method,
    headers: init.ticket.headers,
    body: file,
    credentials: sameOrigin ? "same-origin" : "omit"
  });
  if (!uploaded.ok) {
    let message = `素材上传失败（${uploaded.status}）`;
    try {
      const payload = await uploaded.json() as { error?: { message?: string } };
      message = payload.error?.message ?? message;
    } catch { /* 非 JSON 的对象存储错误 */ }
    throw new AdminRequestError("upload_failed", message, uploaded.status);
  }
  const confirmed = await adminCommand<{ media: MediaItem }>("content media upload-confirm", {
    mediaId: init.mediaId,
    sha256
  });
  return confirmed.media;
}
