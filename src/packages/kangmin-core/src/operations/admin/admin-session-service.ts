import { randomUUID } from "node:crypto";
import { DomainError } from "../../kernel/errors.js";
import { generateToken, hashToken } from "../../kernel/session-tokens.js";
import type {
  AdminRole,
  AdminSessionRepository
} from "./admin-session-repository.js";

export interface AdminIdentity {
  adminId: string;
  role: AdminRole;
  username: string;
}

export class AdminSessionService {
  constructor(private readonly repository: AdminSessionRepository) {}

  async resolve(token: string | undefined): Promise<string> {
    const identity = await this.resolveIdentity(token);
    return identity.adminId;
  }

  /** 解析服务端可信管理员身份（角色/用户名），供权限判断与展示。 */
  async resolveIdentity(token: string | undefined): Promise<AdminIdentity> {
    if (token === undefined || token.trim() === "") {
      throw new DomainError("authentication_required", "需要管理员登录会话");
    }
    const session = await this.repository.findWithAccount(hashToken(token));
    if (session === null || Date.parse(session.expiresAt) <= Date.now()) {
      throw new DomainError("authentication_required", "管理员会话无效或已过期");
    }
    if (session.status !== "active") {
      throw new DomainError("authentication_required", "管理员账号已停用");
    }
    return {
      adminId: session.adminId,
      role: session.role,
      username: session.username
    };
  }

  async createDevelopmentSession(subject: string) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(subject)) {
      throw new DomainError("validation_failed", "开发管理员标识格式无效");
    }
    const token = generateToken();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const adminId = await this.repository.save({
      subject,
      newAdminId: randomUUID(),
      tokenHash: hashToken(token),
      expiresAt,
      createdAt
    });
    return { adminId, token, expiresAt };
  }
}
