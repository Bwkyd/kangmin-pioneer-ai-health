import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DomainError } from "../../kernel/errors.js";
import type { AdminSessionRepository } from "./admin-session-repository.js";

const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export class AdminSessionService {
  constructor(private readonly repository: AdminSessionRepository) {}

  async resolve(token: string | undefined): Promise<string> {
    if (token === undefined || token.trim() === "") {
      throw new DomainError("authentication_required", "需要管理员登录会话");
    }
    const session = await this.repository.find(hash(token));
    if (session === null || Date.parse(session.expiresAt) <= Date.now()) {
      throw new DomainError("authentication_required", "管理员会话无效或已过期");
    }
    return session.adminId;
  }

  async createDevelopmentSession(subject: string) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(subject)) {
      throw new DomainError("validation_failed", "开发管理员标识格式无效");
    }
    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const adminId = await this.repository.save({
      subject,
      newAdminId: randomUUID(),
      tokenHash: hash(token),
      expiresAt,
      createdAt
    });
    return { adminId, token, expiresAt };
  }
}
