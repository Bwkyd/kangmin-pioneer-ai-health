import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual
} from "node:crypto";

import { DomainError } from "../../kernel/errors.js";
import type { AdminAccountRepository } from "./admin-account-repository.js";
import type { AdminIdentity } from "./admin-session-service.js";
import type {
  AdminRole,
  AdminSessionRepository
} from "./admin-session-repository.js";

const SCRYPT_KEY_LENGTH = 64;
/** 管理会话默认有效期 12 小时。 */
const SESSION_TTL_MS = 12 * 3600_000;
/** 开发会话占位密码前缀：dev-admin 同步写入的占位行不可登录。 */
const DEV_PLACEHOLDER_PREFIX = "!";

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/u;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * 校验密码。stored 格式为 scrypt$<salt-b64>$<hash-b64>；
 * 开发会话占位密码（!dev-session-only）或任何非本格式的存储值一律不通过。
 */
function verifyPassword(password: string, stored: string): boolean {
  if (!stored.startsWith("scrypt$")) {
    return false;
  }
  const parts = stored.split("$");
  if (parts.length !== 3) {
    return false;
  }
  const salt = Buffer.from(parts[1] ?? "", "base64");
  const expected = Buffer.from(parts[2] ?? "", "base64");
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }
  const derived = scryptSync(password, salt, expected.length);
  return (
    derived.length === expected.length &&
    timingSafeEqual(derived, expected)
  );
}

export interface AdminAccountView {
  id: string;
  username: string;
  role: AdminRole;
  status: "active" | "disabled";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface LoginResult {
  adminId: string;
  username: string;
  role: AdminRole;
  expiresAt: string;
  /** 仅返回给调用方用于本地凭据存储，绝不进入任何命令输出。 */
  token: string;
}

export interface AuthStatusResult {
  loggedIn: boolean;
  adminId: string | null;
  role: AdminRole | null;
  username: string | null;
  expiresAt: string | null;
}

interface AccountLike {
  id: string;
  username: string;
  role: AdminRole;
  status: "active" | "disabled";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

function viewOf(account: AccountLike): AdminAccountView {
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    status: account.status,
    revision: account.revision,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

export class AdminAuthService {
  constructor(
    private readonly accounts: AdminAccountRepository,
    private readonly sessions: AdminSessionRepository
  ) {}

  /**
   * 创建管理员账号。
   * - 首个 owner 引导：无任何管理员时允许以 --role owner 创建（无需登录）；
   * - 引导完成后只允许 owner 创建普通 admin，且不能再创建 owner。
   */
  async addAdmin(
    identity: AdminIdentity | null,
    input: { username: string; password: string; role: string }
  ): Promise<AdminAccountView> {
    const username = input.username.trim();
    if (!USERNAME_PATTERN.test(username)) {
      throw new DomainError(
        "validation_failed",
        "用户名必须是 3-32 位字母、数字、_、- 或 ."
      );
    }
    const password = input.password;
    if (password.length < 8 || password.length > 128) {
      throw new DomainError(
        "validation_failed",
        "密码长度必须在 8 到 128 个字符之间"
      );
    }
    if (input.role !== "owner" && input.role !== "admin") {
      throw new DomainError(
        "validation_failed",
        "role 必须是 owner 或 admin"
      );
    }

    if (input.role === "owner") {
      const existing = await this.accounts.countAll();
      if (existing > 0) {
        throw new DomainError(
          "permission_denied",
          "已有管理员存在，引导完成后不能再次创建主管理员"
        );
      }
    } else if (identity === null || identity.role !== "owner") {
      throw new DomainError(
        "permission_denied",
        "仅主管理员可以创建普通管理员"
      );
    }

    const timestamp = new Date().toISOString();
    const outcome = await this.accounts.create({
      id: randomUUID(),
      username,
      passwordHash: hashPassword(password),
      role: input.role,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    if (outcome.kind === "username_taken") {
      throw new DomainError("validation_failed", "用户名已存在");
    }
    const created = await this.accounts.findByUsername(username);
    if (created === null) {
      throw new DomainError("internal_error", "管理员创建后读取失败");
    }
    return viewOf(created);
  }

  /** 登录失败统一 authentication_required，不泄露账号是否存在。 */
  async login(username: string, password: string): Promise<LoginResult> {
    const account = await this.accounts.findByUsername(username.trim());
    const valid =
      account !== null &&
      !account.passwordHash.startsWith(DEV_PLACEHOLDER_PREFIX) &&
      verifyPassword(password, account.passwordHash);
    if (account === null || !valid) {
      throw new DomainError("authentication_required", "账号或密码错误");
    }
    if (account.status !== "active") {
      throw new DomainError("authentication_required", "管理员账号已停用");
    }

    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await this.sessions.createSession({
      adminId: account.id,
      tokenHash: hashToken(token),
      expiresAt,
      createdAt
    });
    return {
      adminId: account.id,
      username: account.username,
      role: account.role,
      expiresAt,
      token
    };
  }

  /** 状态命令：未登录返回 loggedIn:false 而非报错。 */
  async status(token: string | undefined): Promise<AuthStatusResult> {
    try {
      const identity = await this.resolveIdentity(token);
      const session = await this.sessions.findWithAccount(
        hashToken(token ?? "")
      );
      return {
        loggedIn: true,
        adminId: identity.adminId,
        role: identity.role,
        username: identity.username,
        expiresAt: session?.expiresAt ?? null
      };
    } catch {
      return {
        loggedIn: false,
        adminId: null,
        role: null,
        username: null,
        expiresAt: null
      };
    }
  }

  async logout(
    token: string | undefined
  ): Promise<{ adminId: string; loggedOut: true }> {
    const identity = await this.resolveIdentity(token);
    await this.sessions.revoke(
      hashToken(token ?? ""),
      new Date().toISOString(),
      "logout"
    );
    return { adminId: identity.adminId, loggedOut: true };
  }

  async listAdmins(): Promise<AdminAccountView[]> {
    return (await this.accounts.list()).map(viewOf);
  }

  async enableAdmin(id: string): Promise<AdminAccountView> {
    const account = await this.accounts.findById(id);
    if (account === null) {
      throw new DomainError("resource_not_found", "管理员不存在");
    }
    if (account.status === "active") {
      return viewOf(account);
    }
    const outcome = await this.accounts.updateStatus(
      id,
      "active",
      new Date().toISOString()
    );
    if (outcome === "not_found") {
      throw new DomainError("resource_not_found", "管理员不存在");
    }
    const updated = await this.accounts.findById(id);
    return viewOf(updated ?? account);
  }

  /** 停用管理员：同事务撤销其全部会话；最后一个活跃 owner 不可停用。 */
  async disableAdmin(id: string): Promise<AdminAccountView> {
    const account = await this.accounts.findById(id);
    if (account === null) {
      throw new DomainError("resource_not_found", "管理员不存在");
    }
    if (account.status === "disabled") {
      throw new DomainError("validation_failed", "该管理员已停用");
    }
    if (
      account.role === "owner" &&
      (await this.accounts.countActiveOwners()) <= 1
    ) {
      throw new DomainError(
        "validation_failed",
        "不能停用最后一个活跃的主管理员"
      );
    }
    const timestamp = new Date().toISOString();
    const outcome = await this.accounts.disableAndRevokeSessions(
      id,
      timestamp,
      "admin_disabled"
    );
    if (outcome === "not_found") {
      throw new DomainError("resource_not_found", "管理员不存在");
    }
    return viewOf({ ...account, status: "disabled", updatedAt: timestamp });
  }

  private async resolveIdentity(
    token: string | undefined
  ): Promise<AdminIdentity> {
    if (token === undefined || token.trim() === "") {
      throw new DomainError("authentication_required", "需要管理员登录会话");
    }
    const session = await this.sessions.findWithAccount(hashToken(token));
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
}
