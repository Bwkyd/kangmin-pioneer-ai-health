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
  /**
   * 首个 owner 引导（事务与卫生残留批 P1-2）：countAll()===0 检查与
   * insert 合并进同一 BEGIN IMMEDIATE 事务，跨进程并发引导时只有一个
   * 请求看到 count=0，另一个拿到 owner_exists——消除"先查后建"竞态。
   * owner_exists：已存在任何管理员（引导已完成）；username_taken：
   * 同事务内唯一约束命中（极端并发下用户名冲突）。
   */
  createFirstOwner(input: {
    id: string;
    username: string;
    passwordHash: string;
    createdAt: string;
    updatedAt: string;
  }): Promise<"created" | "owner_exists" | "username_taken">;
}
