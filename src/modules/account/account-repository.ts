/** 本地患者账号仓储端口（数据库设计 §4.1 本地账号最小集）。 */

export type AccountStatus = "active" | "deactivated" | "deletion_pending";

export interface AccountSnapshot {
  patientId: string;
  usernameHash: string;
  /** 脱敏展示用用户名（注册时派生，不存储明文用户名）。 */
  usernameMasked: string;
  passwordHash: string;
  status: AccountStatus;
  nickname: string | null;
  revision: number;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccountInput {
  patientId: string;
  usernameHash: string;
  usernameMasked: string;
  passwordHash: string;
  nickname: string | null;
  createdAt: string;
}

export type ConsentType = "privacy" | "medical_boundary";
export type ConsentDecision = "granted" | "withdrawn";

export interface ConsentRecord {
  patientId: string;
  consentType: ConsentType;
  /** 按患者+类型递增的追加序号（sequence 语义，只追加不覆写）。 */
  sequence: number;
  decision: ConsentDecision;
  policyVersion: string;
  requestId: string;
  createdAt: string;
}

export interface AccountRepository {
  findByUsernameHash(usernameHash: string): Promise<AccountSnapshot | null>;
  findByPatientId(patientId: string): Promise<AccountSnapshot | null>;
  /**
   * 在同一事务内创建患者行与本地账号行。
   * 用户名已存在（含并发唯一约束命中）抛 version_conflict。
   */
  createAccount(input: CreateAccountInput): Promise<AccountSnapshot>;
  /**
   * 更新昵称并递增 revision（事务与卫生残留批 P2-9）：
   * expectedRevision 作 CAS 谓词（WHERE patient_id = ? AND revision = ?），
   * 并发修改 → version_conflict；账号不存在 → resource_not_found。
   */
  updateNickname(
    patientId: string,
    nickname: string | null,
    expectedRevision: number
  ): Promise<AccountSnapshot>;
  touchLastActive(patientId: string, at: string): Promise<void>;
  /** 追加同意决策：sequence 自动取该患者该类型最大值 + 1（无记录时从 1 起）。 */
  appendConsent(
    input: Omit<ConsentRecord, "sequence">
  ): Promise<ConsentRecord>;
  /** 按患者返回完整同意追加日志（consent_type, sequence 升序）。 */
  listConsents(patientId: string): Promise<ConsentRecord[]>;
}
