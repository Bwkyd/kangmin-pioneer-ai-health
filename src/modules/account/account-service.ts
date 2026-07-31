import { createHash, randomUUID } from "node:crypto";

import { DomainError } from "../../kernel/errors.js";
import {
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
  verifyPasswordWithDummy
} from "../../kernel/credentials.js";
import type {
  AccountSnapshot,
  AccountStatus,
  ConsentDecision,
  ConsentRecord,
  ConsentType
} from "./account-repository.js";
import type { AccountRepository } from "./account-repository.js";
import type { SessionService } from "./session-service.js";

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{2,32}$/u;
const NICKNAME_MAX_LENGTH = 32;
const POLICY_VERSION_MAX_LENGTH = 32;
const REQUEST_ID_MAX_LENGTH = 120;

/** 防枚举：用户不存在与密码错误返回完全相同的错误。 */
const LOGIN_FAILURE_MESSAGE = "用户名或密码错误";

const CONSENT_TYPES: readonly ConsentType[] = [
  "privacy",
  "medical_boundary"
];
const CONSENT_DECISIONS: readonly ConsentDecision[] = [
  "granted",
  "withdrawn"
];

/** 隐私说明（患者 CLI 设计 §9.5）：静态文本，不读库、不需要登录。 */
const PRIVACY_POLICY = {
  policyVersion: "2026-08-01.1",
  statement: `抗敏先锋隐私与医疗边界说明

一、数据用途
本工具记录的症状、暴露、用药和健康档案仅用于向你本人提供记录管理、
趋势回顾与未来的问诊辅助；数据不会出售给第三方，也不用于广告定向。

二、医疗边界
本工具提供记录、回顾与自我管理辅助，不替代医生的诊断与治疗决策；
任何用药调整或治疗方案请咨询执业医师。

三、同意与撤回
同意记录只追加、不覆盖；撤回某项授权后，本工具停止新增对应处理，
已存数据按法规保留，删除请提交 data deletion-request（本版本尚未开放）。
`
} as const;

function now(): string {
  return new Date().toISOString();
}

function hashUsername(username: string): string {
  return createHash("sha256").update(username, "utf8").digest("hex");
}

/** 脱敏用户名：只保留首尾，中间打码；短用户名整体打码。 */
function maskUsername(username: string): string {
  if (username.length <= 2) {
    return "*".repeat(username.length);
  }
  if (username.length <= 4) {
    return `${username[0]}***`;
  }
  return `${username.slice(0, 2)}***${username.slice(-2)}`;
}

function validateUsername(username: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new DomainError(
      "validation_failed",
      "用户名必须是 2 到 32 位字母、数字、下划线或连字符",
      { details: { field: "username" } }
    );
  }
}

function validateNickname(nickname: string | null | undefined): void {
  if (nickname === null || nickname === undefined) {
    return;
  }
  if (nickname === "" || nickname.length > NICKNAME_MAX_LENGTH) {
    throw new DomainError(
      "validation_failed",
      `昵称长度必须在 1 到 ${NICKNAME_MAX_LENGTH} 个字符之间`,
      { details: { field: "nickname" } }
    );
  }
}

/**
 * 密码检查（校验归属单一层：业务校验统一在 service 层、查找之前）：
 * - 未提供密码（非交互 stdin 无内容）→ 不阻塞等待：注册返回
 *   confirmation_required，登录返回 authentication_required；
 * - 提供了但格式非法（非字符串、长度越界）→ validation_failed。
 */
function requirePassword(pass: unknown, forLogin: boolean): string {
  if (pass === undefined) {
    throw new DomainError(
      forLogin ? "authentication_required" : "confirmation_required",
      forLogin
        ? "非交互环境未提供密码，无法完成登录"
        : "非交互环境未提供密码，无法完成注册（请通过 stdin 提供密码）"
    );
  }
  if (typeof pass !== "string") {
    throw new DomainError(
      "validation_failed",
      "密码必须是字符串",
      { details: { field: "password" } }
    );
  }
  if (
    pass.length < PASSWORD_MIN_LENGTH ||
    pass.length > PASSWORD_MAX_LENGTH
  ) {
    throw new DomainError(
      "validation_failed",
      `密码长度必须在 ${PASSWORD_MIN_LENGTH} 到 ${PASSWORD_MAX_LENGTH} 个字符之间`,
      { details: { field: "password" } }
    );
  }
  return pass;
}

function consentTypeOf(value: unknown): ConsentType {
  if (typeof value !== "string" || !(CONSENT_TYPES as readonly string[]).includes(value)) {
    throw new DomainError(
      "validation_failed",
      `consentType 必须是 ${CONSENT_TYPES.join(" 或 ")}`,
      { details: { field: "consentType" } }
    );
  }
  return value as ConsentType;
}

function consentDecisionOf(value: unknown): ConsentDecision {
  if (
    typeof value !== "string" ||
    !(CONSENT_DECISIONS as readonly string[]).includes(value)
  ) {
    throw new DomainError(
      "validation_failed",
      `decision 必须是 ${CONSENT_DECISIONS.join(" 或 ")}`,
      { details: { field: "decision" } }
    );
  }
  return value as ConsentDecision;
}

function consentView(record: ConsentRecord): Record<string, unknown> {
  return {
    consentType: record.consentType,
    sequence: record.sequence,
    decision: record.decision,
    policyVersion: record.policyVersion,
    requestId: record.requestId,
    updatedAt: record.createdAt
  };
}

function accountView(
  account: AccountSnapshot,
  sessionExpiresAt?: string
): Record<string, unknown> {
  return {
    loggedIn: true,
    usernameMasked: account.usernameMasked,
    nickname: account.nickname,
    accountStatus: account.status,
    revision: account.revision,
    lastActiveAt: account.lastActiveAt,
    ...(sessionExpiresAt === undefined
      ? {}
      : { sessionExpiresAt })
  };
}

export class AccountService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly sessions: SessionService
  ) {}

  /** 本地账号注册：scrypt 哈希存密码，SHA-256 哈希存用户名（防明文索引）。 */
  async register(input: {
    username: string;
    nickname: string | null | undefined;
    password: unknown;
  }): Promise<{ patientId: string; usernameMasked: string }> {
    validateUsername(input.username);
    validateNickname(input.nickname);
    const password = requirePassword(input.password, false);
    const usernameHash = hashUsername(input.username);
    const usernameMasked = maskUsername(input.username);
    const passwordHash = await hashPassword(password);

    const existing = await this.accounts.findByUsernameHash(usernameHash);
    if (existing !== null) {
      throw new DomainError(
        "version_conflict",
        "该用户名已被注册，请直接登录"
      );
    }

    const account = await this.accounts.createAccount({
      patientId: randomUUID(),
      usernameHash,
      usernameMasked,
      passwordHash,
      nickname: input.nickname ?? null,
      createdAt: now()
    });
    return {
      patientId: account.patientId,
      usernameMasked: account.usernameMasked
    };
  }

  /** 登录：成功创建会话；失败统一 authentication_required（防枚举）。 */
  async login(input: {
    username: string;
    password: unknown;
  }): Promise<{ token: string; expiresAt: string; usernameMasked: string }> {
    validateUsername(input.username);
    const password = requirePassword(input.password, true);

    const account = await this.accounts.findByUsernameHash(
      hashUsername(input.username)
    );
    if (account === null) {
      // 计时侧信道（评审 P2）：账号不存在也跑一次与真实路径相同参数的
      // scrypt，使"账号不存在"与"密码错误"耗时相近、不可枚举。
      // 不测时序（不稳定），此路径通过代码审查保证仍调用 verify。
      await verifyPasswordWithDummy(password);
      throw new DomainError("authentication_required", LOGIN_FAILURE_MESSAGE);
    }
    const passwordMatches = await verifyPassword(
      password,
      account.passwordHash
    );
    if (!passwordMatches || account.status !== "active") {
      // 账号被停用同样不区分，避免暴露账号存在性与状态。
      throw new DomainError("authentication_required", LOGIN_FAILURE_MESSAGE);
    }

    const session = await this.sessions.createAccountSession(account.patientId);
    await this.accounts.touchLastActive(account.patientId, now());
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      usernameMasked: account.usernameMasked
    };
  }

  /**
   * 会话状态：未登录/会话过期/无本地账号时返回 loggedIn: false（exit 0），
   * 不伪装成资源不存在（患者 CLI 设计 §9.3）。
   */
  async status(
    sessionToken: string | undefined
  ): Promise<Record<string, unknown>> {
    let identity;
    try {
      identity = await this.sessions.resolveIdentity(sessionToken);
    } catch (error) {
      if (error instanceof DomainError && error.code === "authentication_required") {
        return { loggedIn: false };
      }
      throw error;
    }
    const account = await this.accounts.findByPatientId(identity.patientId);
    if (account === null) {
      return { loggedIn: false };
    }
    return accountView(
      account,
      await this.sessions.sessionExpiry(sessionToken)
    );
  }

  /** 退出登录：撤销当前会话（标记 revoked），不删除健康记录。 */
  async logout(sessionToken: string | undefined): Promise<Record<string, unknown>> {
    (await this.sessions.resolvePatient(sessionToken)).patientId;
    const revoked = await this.sessions.revokeSession(
      requireSessionToken(sessionToken)
    );
    return { loggedIn: false, revoked };
  }

  async profileShow(
    patientId: string
  ): Promise<Record<string, unknown>> {
    const account = await this.accountOf(patientId);
    return {
      patientId: account.patientId,
      usernameMasked: account.usernameMasked,
      nickname: account.nickname,
      accountStatus: account.status,
      revision: account.revision,
      lastActiveAt: account.lastActiveAt,
      createdAt: account.createdAt
    };
  }

  /**
   * 昵称读写：undefined=继承，null/空串=清空，字符串=设置（1-32 字符）。
   * 只含账号资料，不含健康档案（健康档案属于 record profile）。
   */
  async profileUpdate(
    patientId: string,
    nickname: string | null | undefined
  ): Promise<Record<string, unknown>> {
    if (nickname === undefined) {
      throw new DomainError(
        "validation_failed",
        "至少提供一个需要更新的字段（nickname）"
      );
    }
    validateNickname(nickname);
    await this.accountOf(patientId);
    const updated = await this.accounts.updateNickname(patientId, nickname);
    return {
      patientId: updated.patientId,
      usernameMasked: updated.usernameMasked,
      nickname: updated.nickname,
      accountStatus: updated.status,
      revision: updated.revision,
      lastActiveAt: updated.lastActiveAt,
      createdAt: updated.createdAt
    };
  }

  /** 同意当前状态：每个类型只返回最新决策（追加日志中的末条）。 */
  async consentShow(patientId: string): Promise<Record<string, unknown>> {
    await this.accountOf(patientId);
    const history = await this.accounts.listConsents(patientId);
    const latest = new Map<ConsentType, ConsentRecord>();
    for (const record of history) {
      latest.set(record.consentType, record);
    }
    return {
      items: [...latest.values()].map(consentView),
      history: history.map(consentView)
    };
  }

  /** 同意更新：按 sequence 追加新决策，绝不覆写或删除历史决策。 */
  async consentUpdate(
    patientId: string,
    input: {
      consentType: unknown;
      decision: unknown;
      policyVersion: string;
      requestId: string;
    }
  ): Promise<Record<string, unknown>> {
    const consentType = consentTypeOf(input.consentType);
    const decision = consentDecisionOf(input.decision);
    if (
      input.policyVersion.trim() === "" ||
      input.policyVersion.length > POLICY_VERSION_MAX_LENGTH
    ) {
      throw new DomainError(
        "validation_failed",
        `policyVersion 长度必须在 1 到 ${POLICY_VERSION_MAX_LENGTH} 个字符之间`,
        { details: { field: "policyVersion" } }
      );
    }
    if (
      input.requestId.trim() === "" ||
      input.requestId.length > REQUEST_ID_MAX_LENGTH
    ) {
      throw new DomainError(
        "validation_failed",
        `requestId 长度必须在 1 到 ${REQUEST_ID_MAX_LENGTH} 个字符之间`,
        { details: { field: "requestId" } }
      );
    }
    await this.accountOf(patientId);
    const appended = await this.accounts.appendConsent({
      patientId,
      consentType,
      decision,
      policyVersion: input.policyVersion,
      requestId: input.requestId,
      createdAt: now()
    });
    const history = await this.accounts.listConsents(patientId);
    const latest = new Map<ConsentType, ConsentRecord>();
    for (const record of history) {
      latest.set(record.consentType, record);
    }
    return {
      item: consentView(appended),
      items: [...latest.values()].map(consentView)
    };
  }

  /** 隐私说明：静态文本，不需要登录。 */
  privacy(): { policyVersion: string; statement: string } {
    return { ...PRIVACY_POLICY };
  }

  private async accountOf(patientId: string): Promise<AccountSnapshot> {
    const account = await this.accounts.findByPatientId(patientId);
    if (account === null) {
      throw new DomainError(
        "resource_not_found",
        "当前会话没有本地账号，请先注册"
      );
    }
    return account;
  }
}

function requireSessionToken(token: string | undefined): string {
  if (token === undefined || token.trim() === "") {
    throw new DomainError("authentication_required", "需要患者登录会话");
  }
  return token;
}
