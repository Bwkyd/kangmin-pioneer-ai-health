import { KangminDatabase } from "./database.js";
import type {
  SaveAccountSessionInput,
  SaveDevelopmentSessionInput,
  SessionClientKind,
  SessionRepository,
  SessionSnapshot
} from "../modules/account/session-repository.js";

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

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly database: KangminDatabase) {}

  async findSession(tokenHash: string): Promise<SessionSnapshot | null> {
    const row = this.database.connection
      .prepare(`
        SELECT patient_id, expires_at, client_kind, revoked_at
        FROM patient_sessions
        WHERE token_hash = ? AND revoked_at IS NULL
      `)
      .get(tokenHash) as unknown as SessionRow | undefined;

    return row === undefined ? null : toSnapshot(row);
  }

  async saveDevelopmentSession(
    input: SaveDevelopmentSessionInput
  ): Promise<string> {
    return this.database.transaction(() => {
      let patient = this.database.connection
        .prepare("SELECT id FROM patients WHERE development_subject = ?")
        .get(input.developmentSubject) as unknown as PatientRow | undefined;

      if (patient === undefined) {
        patient = { id: input.newPatientId };
        this.database.connection
          .prepare(`
            INSERT INTO patients(id, development_subject, created_at)
            VALUES (?, ?, ?)
          `)
          .run(
            patient.id,
            input.developmentSubject,
            input.createdAt
          );
      }

      // 事务与卫生残留批 P2-11：不用 INSERT OR REPLACE——token 随机
      // 不冲突，但 REPLACE 会先删旧行，绕过"已撤销会话保持撤销"语义
      // （同 token 再存会把 revoked_at 行复活成全新会话）。改为
      // ON CONFLICT DO NOTHING：已存在的 token（含已撤销）原样保留。
      this.database.connection
        .prepare(`
          INSERT INTO patient_sessions(
            token_hash, patient_id, expires_at, created_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(token_hash) DO NOTHING
        `)
        .run(
          input.tokenHash,
          patient.id,
          input.expiresAt,
          input.createdAt
        );

      return patient.id;
    });
  }

  async saveAccountSession(input: SaveAccountSessionInput): Promise<void> {
    this.database.connection
      .prepare(`
        INSERT INTO patient_sessions(
          token_hash, patient_id, expires_at, created_at, client_kind
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        input.tokenHash,
        input.patientId,
        input.expiresAt,
        input.createdAt,
        input.clientKind
      );
  }

  async revokeSession(tokenHash: string): Promise<boolean> {
    const result = this.database.connection
      .prepare(`
        UPDATE patient_sessions
        SET revoked_at = ?
        WHERE token_hash = ? AND revoked_at IS NULL
      `)
      .run(new Date().toISOString(), tokenHash);
    return result.changes > 0;
  }
}
