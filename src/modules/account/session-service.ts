import { randomUUID } from "node:crypto";

import { DomainError } from "../../kernel/errors.js";
import { generateToken, hashToken } from "../../kernel/session-tokens.js";
import type {
  PatientIdentity,
  PatientIdentityPort
} from "./identity-ports.js";
import type {
  SessionRepository,
  SessionSnapshot
} from "./session-repository.js";

/** 账号会话默认 7 天；合法范围 60 秒到 30 天。 */
const ACCOUNT_SESSION_TTL_SECONDS = 7 * 24 * 3600;
const ACCOUNT_SESSION_MIN_SECONDS = 60;
const ACCOUNT_SESSION_MAX_SECONDS = 30 * 24 * 3600;

export class SessionService implements PatientIdentityPort {
  constructor(private readonly repository: SessionRepository) {}

  async resolvePatient(token: string | undefined): Promise<PatientIdentity> {
    return this.resolveIdentity(token);
  }

  async resolveIdentity(token: string | undefined): Promise<PatientIdentity> {
    if (token === undefined || token.trim() === "") {
      throw new DomainError(
        "authentication_required",
        "需要患者登录会话"
      );
    }
    const session = await this.findValidSession(token);
    if (session === null) {
      throw new DomainError(
        "authentication_required",
        "患者登录会话无效或已过期"
      );
    }
    return {
      patientId: session.patientId,
      assurance:
        session.clientKind === "development" ? "development" : "local_account"
    };
  }

  /** 会话有效期；无效/过期/已撤销返回 undefined（不抛错，供 status 使用）。 */
  async sessionExpiry(
    token: string | undefined
  ): Promise<string | undefined> {
    const session = await this.findValidSession(token);
    return session === null ? undefined : session.expiresAt;
  }

  /** 未撤销且未过期的会话；其余情况返回 null。 */
  private async findValidSession(
    token: string | undefined
  ): Promise<SessionSnapshot | null> {
    if (token === undefined || token.trim() === "") {
      return null;
    }
    const session = await this.repository.findSession(hashToken(token));
    const expiresAt =
      session === null ? Number.NaN : Date.parse(session.expiresAt);
    if (
      session === null ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    ) {
      return null;
    }
    return session;
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
    const token = options.token ?? generateToken();
    const patientId = await this.repository.saveDevelopmentSession({
      developmentSubject,
      newPatientId: randomUUID(),
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: now.toISOString()
    });

    return { patientId, token, expiresAt };
  }

  /** 本地账号登录成功后创建 CLI 会话（患者 CLI 设计 §9.3）。 */
  async createAccountSession(
    patientId: string,
    options: { ttlSeconds?: number } = {}
  ): Promise<{ token: string; expiresAt: string }> {
    const ttlSeconds = options.ttlSeconds ?? ACCOUNT_SESSION_TTL_SECONDS;
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < ACCOUNT_SESSION_MIN_SECONDS ||
      ttlSeconds > ACCOUNT_SESSION_MAX_SECONDS
    ) {
      throw new DomainError(
        "validation_failed",
        "账号会话有效期必须在 60 秒到 30 天之间"
      );
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + ttlSeconds * 1000
    ).toISOString();
    const token = generateToken();
    await this.repository.saveAccountSession({
      patientId,
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: now.toISOString(),
      clientKind: "cli"
    });
    return { token, expiresAt };
  }

  /** 撤销当前会话（标记 revoked，不删除会话行以保留审计线索）。 */
  async revokeSession(token: string): Promise<boolean> {
    return this.repository.revokeSession(hashToken(token));
  }
}
