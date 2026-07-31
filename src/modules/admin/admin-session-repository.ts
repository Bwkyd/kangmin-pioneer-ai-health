export type AdminRole = "owner" | "admin";
export type AdminStatus = "active" | "disabled";

export interface AdminSessionSnapshot {
  adminId: string;
  expiresAt: string;
}

export interface AdminSessionWithAccount {
  adminId: string;
  role: AdminRole;
  username: string;
  expiresAt: string;
  status: AdminStatus;
}

export interface AdminSessionRepository {
  find(tokenHash: string): Promise<AdminSessionSnapshot | null>;
  /** 会话 + 账号信息：status 用于服务端二次校验，username/role 用于权限与展示。 */
  findWithAccount(tokenHash: string): Promise<AdminSessionWithAccount | null>;
  save(input: {
    subject: string;
    newAdminId: string;
    tokenHash: string;
    expiresAt: string;
    createdAt: string;
  }): Promise<string>;
  createSession(input: {
    adminId: string;
    tokenHash: string;
    expiresAt: string;
    createdAt: string;
  }): Promise<void>;
  revoke(tokenHash: string, revokedAt: string, reason: string): Promise<void>;
  /** 停用管理员时同事务撤销其全部会话，返回被撤销的会话数。 */
  revokeAllForAdmin(
    adminId: string,
    revokedAt: string,
    reason: string
  ): Promise<number>;
}
