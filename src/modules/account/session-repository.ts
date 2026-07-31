/** 会话来源（患者 CLI 设计 §9.3）：development=开发会话，mini_program/cli=本地账号会话。 */
export type SessionClientKind = "development" | "mini_program" | "cli";

export interface SessionSnapshot {
  patientId: string;
  expiresAt: string;
  clientKind: SessionClientKind;
  /** 撤销时间；非空表示已退出登录，会话不可用。 */
  revokedAt: string | null;
}

export interface SaveDevelopmentSessionInput {
  developmentSubject: string;
  newPatientId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface SaveAccountSessionInput {
  patientId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  clientKind: "mini_program" | "cli";
}

export interface SessionRepository {
  /** 按令牌哈希查找未撤销的会话；不存在或已撤销返回 null。 */
  findSession(tokenHash: string): Promise<SessionSnapshot | null>;
  saveDevelopmentSession(
    input: SaveDevelopmentSessionInput
  ): Promise<string>;
  saveAccountSession(input: SaveAccountSessionInput): Promise<void>;
  /** 撤销会话并返回是否真的撤销了（false 表示令牌不存在或已撤销）。 */
  revokeSession(tokenHash: string): Promise<boolean>;
}
