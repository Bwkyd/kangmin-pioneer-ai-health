import { createHash, randomBytes, randomUUID } from "node:crypto";

import { DomainError } from "../../kernel/errors.js";
import type { SessionRepository } from "./session-repository.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class SessionService {
  constructor(private readonly repository: SessionRepository) {}

  async resolvePatient(token: string | undefined): Promise<string> {
    if (token === undefined || token.trim() === "") {
      throw new DomainError(
        "authentication_required",
        "需要患者登录会话"
      );
    }

    const session = await this.repository.findSession(hashToken(token));
    const expiresAt =
      session === null ? Number.NaN : Date.parse(session.expiresAt);
    if (
      session === null ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    ) {
      throw new DomainError(
        "authentication_required",
        "患者登录会话无效或已过期"
      );
    }
    return session.patientId;
  }

  async createDevelopmentSession(
    developmentSubject: string,
    options: { token?: string; ttlSeconds?: number } = {}
  ): Promise<{ patientId: string; token: string; expiresAt: string }> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(developmentSubject)) {
      throw new DomainError(
        "validation_failed",
        "开发测试患者标识格式无效"
      );
    }

    const ttlSeconds = options.ttlSeconds ?? 3600;
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 60 ||
      ttlSeconds > 24 * 60 * 60
    ) {
      throw new DomainError(
        "validation_failed",
        "开发测试会话有效期必须在 60 秒到 24 小时之间"
      );
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + ttlSeconds * 1000
    ).toISOString();
    const token = options.token ?? randomBytes(32).toString("base64url");
    const patientId = await this.repository.saveDevelopmentSession({
      developmentSubject,
      newPatientId: randomUUID(),
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: now.toISOString()
    });

    return { patientId, token, expiresAt };
  }
}
