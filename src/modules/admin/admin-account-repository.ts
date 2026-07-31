import type { AdminRole, AdminStatus } from "./admin-session-repository.js";

export interface AdminAccountRow {
  id: string;
  username: string;
  passwordHash: string;
  role: AdminRole;
  status: AdminStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type CreateAdminAccountOutcome =
  | { kind: "created" }
  | { kind: "username_taken" };

export interface AdminAccountRepository {
  countAll(): Promise<number>;
  countActiveOwners(): Promise<number>;
  findById(id: string): Promise<AdminAccountRow | null>;
  findByUsername(username: string): Promise<AdminAccountRow | null>;
  list(): Promise<AdminAccountRow[]>;
  create(input: {
    id: string;
    username: string;
    passwordHash: string;
    role: AdminRole;
    createdAt: string;
    updatedAt: string;
  }): Promise<CreateAdminAccountOutcome>;
  updateStatus(
    id: string,
    status: AdminStatus,
    updatedAt: string
  ): Promise<"updated" | "not_found">;
  /** 停用管理员并同事务撤销其全部会话（数据库设计 §4.1）。 */
  disableAndRevokeSessions(
    id: string,
    updatedAt: string,
    reason: string
  ): Promise<"updated" | "not_found">;
  /**
   * 事务内守卫停用：owner 且活跃 owner 数 <= 1 时拒绝（last_owner），
   * 避免跨进程 check-then-act 并发击穿（评审 B P2）。
   */
  disableAdminIfNotLastOwner(
    id: string,
    updatedAt: string,
    reason: string
  ): Promise<"updated" | "not_found" | "last_owner">;
}
