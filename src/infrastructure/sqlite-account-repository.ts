import { DomainError } from "../kernel/errors.js";
import { KangminDatabase } from "./database.js";
import type {
  AccountRepository,
  AccountSnapshot,
  AccountStatus,
  ConsentDecision,
  ConsentRecord,
  ConsentType,
  CreateAccountInput
} from "../modules/account/account-repository.js";

interface AccountRow {
  patient_id: string;
  username_hash: string;
  username_masked: string;
  password_hash: string;
  status: AccountStatus;
  nickname: string | null;
  revision: number;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ConsentRow {
  patient_id: string;
  consent_type: ConsentType;
  sequence: number;
  decision: ConsentDecision;
  policy_version: string;
  request_id: string;
  created_at: string;
}

const ACCOUNT_COLUMNS = `
  patient_id, username_hash, username_masked, password_hash,
  status, nickname, revision, last_active_at, created_at, updated_at
`;

function toAccount(row: AccountRow): AccountSnapshot {
  return {
    patientId: row.patient_id,
    usernameHash: row.username_hash,
    usernameMasked: row.username_masked,
    passwordHash: row.password_hash,
    status: row.status,
    nickname: row.nickname,
    revision: row.revision,
    lastActiveAt: row.last_active_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toConsent(row: ConsentRow): ConsentRecord {
  return {
    patientId: row.patient_id,
    consentType: row.consent_type,
    sequence: row.sequence,
    decision: row.decision,
    policyVersion: row.policy_version,
    requestId: row.request_id,
    createdAt: row.created_at
  };
}

/** 唯一约束冲突（含并发注册竞态）统一映射为重复注册错误。 */
function isUniqueViolation(error: unknown): boolean {
  return String(error).includes("UNIQUE constraint failed");
}

export class SqliteAccountRepository implements AccountRepository {
  constructor(private readonly database: KangminDatabase) {}

  async findByUsernameHash(
    usernameHash: string
  ): Promise<AccountSnapshot | null> {
    const row = this.database.connection
      .prepare(`
        SELECT ${ACCOUNT_COLUMNS}
        FROM patient_accounts
        WHERE username_hash = ?
      `)
      .get(usernameHash) as unknown as AccountRow | undefined;
    return row === undefined ? null : toAccount(row);
  }

  async findByPatientId(patientId: string): Promise<AccountSnapshot | null> {
    const row = this.database.connection
      .prepare(`
        SELECT ${ACCOUNT_COLUMNS}
        FROM patient_accounts
        WHERE patient_id = ?
      `)
      .get(patientId) as unknown as AccountRow | undefined;
    return row === undefined ? null : toAccount(row);
  }

  async createAccount(input: CreateAccountInput): Promise<AccountSnapshot> {
    try {
      return this.database.transaction(() => {
        this.database.connection
          .prepare(`
            INSERT INTO patients(id, created_at)
            VALUES (?, ?)
          `)
          .run(input.patientId, input.createdAt);
        this.database.connection
          .prepare(`
            INSERT INTO patient_accounts(
              patient_id, username_hash, username_masked, password_hash,
              status, nickname, revision, last_active_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'active', ?, 1, NULL, ?, ?)
          `)
          .run(
            input.patientId,
            input.usernameHash,
            input.usernameMasked,
            input.passwordHash,
            input.nickname,
            input.createdAt,
            input.createdAt
          );
        return this.snapshotAfterInsert(input);
      });
    } catch (error) {
      // 并发注册同一用户名时唯一约束在事务内直接命中，需在抛出点映射。
      if (isUniqueViolation(error)) {
        throw new DomainError(
          "version_conflict",
          "该用户名已被注册，请直接登录"
        );
      }
      throw error;
    }
  }

  async updateNickname(
    patientId: string,
    nickname: string | null,
    expectedRevision: number
  ): Promise<AccountSnapshot> {
    return this.database.transaction(() => {
      const updatedAt = new Date().toISOString();
      // CAS 谓词（事务与卫生残留批 P2-9）：revision 不匹配即并发修改，
      // 0 行更新映射为 version_conflict（与 health profile 语义一致）。
      const result = this.database.connection
        .prepare(`
          UPDATE patient_accounts
          SET nickname = ?, revision = revision + 1, updated_at = ?
          WHERE patient_id = ? AND revision = ?
        `)
        .run(nickname, updatedAt, patientId, expectedRevision);
      if (result.changes !== 1) {
        const exists = this.database.connection
          .prepare("SELECT patient_id FROM patient_accounts WHERE patient_id = ?")
          .get(patientId);
        if (exists === undefined) {
          throw new DomainError(
            "resource_not_found",
            "当前会话没有本地账号，请先注册"
          );
        }
        throw new DomainError(
          "version_conflict",
          "资料已更新，请重新读取",
          {
            details: { expectedRevision }
          }
        );
      }
      const row = this.database.connection
        .prepare(`
          SELECT ${ACCOUNT_COLUMNS}
          FROM patient_accounts
          WHERE patient_id = ?
        `)
        .get(patientId) as unknown as AccountRow | undefined;
      if (row === undefined) {
        throw new DomainError(
          "resource_not_found",
          "当前会话没有本地账号，请先注册"
        );
      }
      return toAccount(row);
    });
  }

  async touchLastActive(patientId: string, at: string): Promise<void> {
    this.database.connection
      .prepare(`
        UPDATE patient_accounts
        SET last_active_at = ?
        WHERE patient_id = ?
      `)
      .run(at, patientId);
  }

  async appendConsent(
    input: Omit<ConsentRecord, "sequence">
  ): Promise<ConsentRecord> {
    return this.database.transaction(() => {
      const nextRow = this.database.connection
        .prepare(`
          SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
          FROM patient_consents
          WHERE patient_id = ? AND consent_type = ?
        `)
        .get(input.patientId, input.consentType) as unknown as {
        next_sequence: number;
      };
      const sequence = nextRow.next_sequence;
      this.database.connection
        .prepare(`
          INSERT INTO patient_consents(
            patient_id, consent_type, sequence, decision,
            policy_version, request_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.patientId,
          input.consentType,
          sequence,
          input.decision,
          input.policyVersion,
          input.requestId,
          input.createdAt
        );
      return {
        patientId: input.patientId,
        consentType: input.consentType,
        sequence,
        decision: input.decision,
        policyVersion: input.policyVersion,
        requestId: input.requestId,
        createdAt: input.createdAt
      };
    });
  }

  async listConsents(patientId: string): Promise<ConsentRecord[]> {
    const rows = this.database.connection
      .prepare(`
        SELECT patient_id, consent_type, sequence, decision,
               policy_version, request_id, created_at
        FROM patient_consents
        WHERE patient_id = ?
        ORDER BY consent_type ASC, sequence ASC
      `)
      .all(patientId) as unknown as ConsentRow[];
    return rows.map(toConsent);
  }

  private snapshotAfterInsert(input: CreateAccountInput): AccountSnapshot {
    return {
      patientId: input.patientId,
      usernameHash: input.usernameHash,
      usernameMasked: input.usernameMasked,
      passwordHash: input.passwordHash,
      status: "active",
      nickname: input.nickname,
      revision: 1,
      lastActiveAt: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    };
  }
}
