import { createHash, randomBytes } from "node:crypto";

/**
 * 会话令牌哈希：sha256 hex。
 * 存储侧只保留不可逆哈希（会话表/撤销查询均以哈希为键），不落明文。
 * 患者端（account/session-service）与管理端（admin/admin-session-service）共用。
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 会话令牌生成：32 字节加密随机数，base64url（与既有令牌格式一致）。 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}
