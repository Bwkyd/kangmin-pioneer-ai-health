import type {
  SaveAccountSessionInput,
  SaveDevelopmentSessionInput,
  SaveMiniProgramSessionInput,
  SessionClientKind,
  SessionRepository,
  SessionSnapshot
} from "@kangmin/core/patient/account/session-repository";
import { KangminPgDatabase } from "./pg-database.js";

interface PatientRow {
  id: string;
}

interface SessionRow {
  patient_id: string;
  expires_at: string;
  client_kind: SessionClientKind;
  revoked_at: string | null;
}

function toSnapshot(row: SessionRow): SessionSnapshot {
  return {
    patientId: row.patient_id,
    expiresAt: row.expires_at,
    clientKind: row.client_kind,
    revokedAt: row.revoked_at
  };
}

export class PgSessionRepository implements SessionRepository {
  constructor(private readonly database: KangminPgDatabase) {}

  async findSession(tokenHash: string): Promise<SessionSnapshot | null> {
    const { rows } = await this.database.query<SessionRow>(
      `SELECT patient_id, expires_at, client_kind, revoked_at
       FROM patient_sessions
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash]
    );
    const row = rows[0];
    return row === undefined ? null : toSnapshot(row);
  }

  async saveDevelopmentSession(
    input: SaveDevelopmentSessionInput
  ): Promise<string> {
    return this.database.transaction(async (client) => {
      const existing = await this.database.queryIn<PatientRow>(
        client,
        "SELECT id FROM patients WHERE development_subject = $1",
        [input.developmentSubject]
      );
      let patientId = existing.rows[0]?.id;
      if (patientId === undefined) {
        patientId = input.newPatientId;
        await this.database.queryIn(
          client,
          `INSERT INTO patients(id, development_subject, created_at)
           VALUES ($1, $2, $3)`,
          [patientId, input.developmentSubject, input.createdAt]
        );
      }

      // 与 SQLite 实现一致：ON CONFLICT DO NOTHING——已存在的 token
      // （含已撤销）原样保留，不用 REPLACE 避免复活已撤销会话。
      await this.database.queryIn(
        client,
        `INSERT INTO patient_sessions(
          token_hash, patient_id, expires_at, created_at
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT(token_hash) DO NOTHING`,
        [input.tokenHash, patientId, input.expiresAt, input.createdAt]
      );

      return patientId;
    });
  }

  async saveAccountSession(input: SaveAccountSessionInput): Promise<void> {
    await this.database.query(
      `INSERT INTO patient_sessions(
        token_hash, patient_id, expires_at, created_at, client_kind
      ) VALUES ($1, $2, $3, $4, $5)`,
      [
        input.tokenHash,
        input.patientId,
        input.expiresAt,
        input.createdAt,
        input.clientKind
      ]
    );
  }

  async saveMiniProgramSession(input: SaveMiniProgramSessionInput): Promise<string> {
    return this.database.transaction(async (client) => {
      const existing = await this.database.queryIn<{ patient_id: string }>(client, `
        SELECT patient_id FROM patient_external_identities
        WHERE provider = 'wechat_mini_program' AND subject_hash = $1
        FOR UPDATE
      `, [input.subjectHash]);
      let patientId = existing.rows[0]?.patient_id;
      if (patientId === undefined) {
        await this.database.queryIn(client, `
          INSERT INTO patients(id, development_subject, created_at) VALUES ($1, NULL, $2)
        `, [input.newPatientId, input.createdAt]);
        await this.database.queryIn(client, `
          INSERT INTO patient_external_identities(provider, subject_hash, patient_id, created_at)
          VALUES ('wechat_mini_program', $1, $2, $3)
          ON CONFLICT(provider, subject_hash) DO NOTHING
        `, [input.subjectHash, input.newPatientId, input.createdAt]);
        const authoritative = await this.database.queryIn<{ patient_id: string }>(client, `
          SELECT patient_id FROM patient_external_identities
          WHERE provider = 'wechat_mini_program' AND subject_hash = $1
        `, [input.subjectHash]);
        patientId = authoritative.rows[0]!.patient_id;
        if (patientId !== input.newPatientId) {
          await this.database.queryIn(client, "DELETE FROM patients WHERE id = $1", [input.newPatientId]);
        }
      }
      await this.database.queryIn(client, `
        INSERT INTO patient_sessions(token_hash, patient_id, expires_at, created_at, client_kind)
        VALUES ($1, $2, $3, $4, 'mini_program')
      `, [input.tokenHash, patientId, input.expiresAt, input.createdAt]);
      return patientId;
    });
  }

  async revokeSession(tokenHash: string): Promise<boolean> {
    const { rowCount } = await this.database.query(
      `UPDATE patient_sessions
       SET revoked_at = $1
       WHERE token_hash = $2 AND revoked_at IS NULL`,
      [new Date().toISOString(), tokenHash]
    );
    return rowCount > 0;
  }
}
