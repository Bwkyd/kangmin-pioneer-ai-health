import { createHash, randomBytes, randomUUID } from "node:crypto";

import { KangminDatabase } from "../../infrastructure/database.js";
import { DomainError } from "../../kernel/errors.js";

interface PatientRow {
  id: string;
}

interface SessionRow {
  patient_id: string;
  expires_at: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class SessionService {
  constructor(private readonly database: KangminDatabase) {}

  resolvePatient(token: string | undefined): string {
    if (token === undefined || token.trim() === "") {
      throw new DomainError(
        "authentication_required",
        "需要患者登录会话"
      );
    }

    const row = this.database.connection
      .prepare(`
        SELECT patient_id, expires_at
        FROM patient_sessions
        WHERE token_hash = ?
      `)
      .get(hashToken(token)) as unknown as SessionRow | undefined;

    if (row === undefined || Date.parse(row.expires_at) <= Date.now()) {
      throw new DomainError(
        "authentication_required",
        "患者登录会话无效或已过期"
      );
    }
    return row.patient_id;
  }

  createDevelopmentSession(
    developmentSubject: string,
    options: { token?: string; ttlSeconds?: number } = {}
  ): { patientId: string; token: string; expiresAt: string } {
    if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(developmentSubject)) {
      throw new DomainError(
        "validation_failed",
        "开发测试患者标识格式无效"
      );
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + (options.ttlSeconds ?? 3600) * 1000
    ).toISOString();
    const token = options.token ?? randomBytes(32).toString("base64url");

    const patientId = this.database.transaction(() => {
      let patient = this.database.connection
        .prepare("SELECT id FROM patients WHERE development_subject = ?")
        .get(developmentSubject) as unknown as PatientRow | undefined;

      if (patient === undefined) {
        patient = { id: randomUUID() };
        this.database.connection
          .prepare(`
            INSERT INTO patients(id, development_subject, created_at)
            VALUES (?, ?, ?)
          `)
          .run(patient.id, developmentSubject, now.toISOString());
      }

      this.database.connection
        .prepare(`
          INSERT OR REPLACE INTO patient_sessions(
            token_hash, patient_id, expires_at, created_at
          ) VALUES (?, ?, ?, ?)
        `)
        .run(hashToken(token), patient.id, expiresAt, now.toISOString());

      return patient.id;
    });

    return { patientId, token, expiresAt };
  }
}
