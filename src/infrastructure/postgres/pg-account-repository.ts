import { randomUUID } from "node:crypto";

import { DomainError } from "../../kernel/errors.js";
import type {
  AccountRepository,
  AccountSnapshot,
  AccountStatus,
  ConsentDecision,
  ConsentRecord,
  ConsentType,
  CreateAccountInput
} from "../../modules/account/account-repository.js";
import { KangminPgDatabase, isUniqueViolation } from "./pg-database.js";

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
  id: string;
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
    id: row.id,
    patientId: row.patient_id,
    consentType: row.consent_type,
    sequence: row.sequence,
    decision: row.decision,
    policyVersion: row.policy_version,
    requestId: row.request_id,
    createdAt: row.created_at
  };
}

export class PgAccountRepository implements AccountRepository {
  constructor(private readonly database: KangminPgDatabase) {}

  async findByUsernameHash(
    usernameHash: string
  ): Promise<AccountSnapshot | null> {
    const { rows } = await this.database.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS}
       FROM patient_accounts
       WHERE username_hash = $1`,
      [usernameHash]
    );
    const row = rows[0];
    return row === undefined ? null : toAccount(row);
  }

  async findByPatientId(patientId: string): Promise<AccountSnapshot | null> {
    const { rows } = await this.database.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS}
       FROM patient_accounts
       WHERE patient_id = $1`,
      [patientId]
    );
    const row = rows[0];
    return row === undefined ? null : toAccount(row);
  }

  async createAccount(input: CreateAccountInput): Promise<AccountSnapshot> {
    try {
      return await this.database.transaction(async (client) => {
        await this.database.queryIn(
          client,
          `INSERT INTO patients(id, created_at)
           VALUES ($1, $2)`,
          [input.patientId, input.createdAt]
        );
        await this.database.queryIn(
          client,
          `INSERT INTO patient_accounts(
            patient_id, username_hash, username_masked, password_hash,
            status, nickname, revision, last_active_at, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, 'active', $5, 1, NULL, $6, $7)`,
          [
            input.patientId,
            input.usernameHash,
            input.usernameMasked,
            input.passwordHash,
            input.nickname,
            input.createdAt,
            input.createdAt
          ]
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
    return this.database.transaction(async (client) => {
      const updatedAt = new Date().toISOString();
      // CAS 谓词（事务与卫生残留批 P2-9）：revision 不匹配即并发修改，
      // 0 行更新映射为 version_conflict（与 health profile 语义一致）。
      const result = await this.database.queryIn(
        client,
        `UPDATE patient_accounts
         SET nickname = $1, revision = revision + 1, updated_at = $2
         WHERE patient_id = $3 AND revision = $4`,
        [nickname, updatedAt, patientId, expectedRevision]
      );
      if (result.rowCount !== 1) {
        const exists = await this.database.queryIn(
          client,
          "SELECT patient_id FROM patient_accounts WHERE patient_id = $1",
          [patientId]
        );
        if (exists.rows[0] === undefined) {
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
      const { rows } = await this.database.queryIn<AccountRow>(
        client,
        `SELECT ${ACCOUNT_COLUMNS}
         FROM patient_accounts
         WHERE patient_id = $1`,
        [patientId]
      );
      const row = rows[0];
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
    await this.database.query(
      `UPDATE patient_accounts
       SET last_active_at = $1
       WHERE patient_id = $2`,
      [at, patientId]
    );
  }

  async appendConsent(
    input: Omit<ConsentRecord, "id" | "sequence">
  ): Promise<ConsentRecord> {
    return this.database.transaction(async (client) => {
      // MAX(int4) 在 pg 驱动下返回 number，无需强转。
      const nextRow = await this.database.queryIn<{
        next_sequence: number;
      }>(
        client,
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM patient_consents
         WHERE patient_id = $1 AND consent_type = $2`,
        [input.patientId, input.consentType]
      );
      // COALESCE 保证聚合恒有一行；noUncheckedIndexedAccess 下用 ?? 1 兜底。
      const sequence = nextRow.rows[0]?.next_sequence ?? 1;
      const id = randomUUID();
      await this.database.queryIn(
        client,
        `INSERT INTO patient_consents(
          id, patient_id, consent_type, sequence, decision,
          policy_version, request_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          input.patientId,
          input.consentType,
          sequence,
          input.decision,
          input.policyVersion,
          input.requestId,
          input.createdAt
        ]
      );
      return {
        id,
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
    const { rows } = await this.database.query<ConsentRow>(
      `SELECT id, patient_id, consent_type, sequence, decision,
             policy_version, request_id, created_at
       FROM patient_consents
       WHERE patient_id = $1
       ORDER BY consent_type ASC, sequence ASC`,
      [patientId]
    );
    return rows.map(toConsent);
  }

  async findLatestConsent(
    patientId: string,
    consentType: ConsentType
  ): Promise<ConsentRecord | null> {
    const { rows } = await this.database.query<ConsentRow>(
      `SELECT id, patient_id, consent_type, sequence, decision,
             policy_version, request_id, created_at
       FROM patient_consents
       WHERE patient_id = $1 AND consent_type = $2
       ORDER BY sequence DESC
       LIMIT 1`,
      [patientId, consentType]
    );
    const row = rows[0];
    return row === undefined ? null : toConsent(row);
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
