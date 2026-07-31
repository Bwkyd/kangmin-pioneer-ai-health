import { KangminDatabase } from "./database.js";
import type {
  ActivitySource,
  ExposureProjectionRow,
  MedicationProjectionRow,
  PatientSessionRow,
  SymptomProjectionRow,
  UserListRow,
  UserReadRepository
} from "../modules/user-admin/user-admin-ports.js";

interface UserListShape {
  id: string;
  development_subject: string | null;
  nickname: string | null;
  account_status: string | null;
  registered_at: string;
  last_active_at: string | null;
  session_count: number;
  record_count: number;
}

interface SessionShape {
  token_hash: string;
  created_at: string;
  expires_at: string;
}

interface SymptomShape {
  id: string;
  local_date: string;
  nasal_congestion: number;
  nasal_itching: number;
  sneezing: number;
  runny_nose: number;
  tnss_total: number;
}

interface ExposureShape {
  id: string;
  local_date: string;
  factors_json: string;
}

interface MedicationShape {
  id: string;
  local_date: string;
  medication_name: string;
  dosage: string | null;
}

const RECORD_COUNT_SQL = `
  (SELECT COUNT(*) FROM symptom_records s WHERE s.patient_id = p.id) +
  (SELECT COUNT(*) FROM exposure_records e WHERE e.patient_id = p.id) +
  (SELECT COUNT(*) FROM medication_records m WHERE m.patient_id = p.id)
`;

function toUserRow(row: UserListShape): UserListRow {
  return {
    id: row.id,
    developmentSubject: row.development_subject,
    nickname: row.nickname,
    accountStatus: row.account_status ?? "no_local_account",
    registeredAt: row.registered_at,
    lastActiveAt: row.last_active_at,
    sessionCount: row.session_count,
    recordCount: row.record_count
  };
}

export class SqliteUserAdminRepository implements UserReadRepository {
  constructor(private readonly database: KangminDatabase) {}

  async listUsers(
    limit: number,
    activeWithinDays?: number,
    query?: string
  ): Promise<UserListRow[]> {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (activeWithinDays !== undefined) {
      const cutoff = new Date(
        Date.now() - activeWithinDays * 86_400_000
      ).toISOString();
      conditions.push(
        `(pa.last_active_at >= ? OR EXISTS (
          SELECT 1 FROM patient_sessions s2 WHERE s2.patient_id = p.id AND s2.created_at >= ?
        ))`
      );
      parameters.push(cutoff, cutoff);
    }
    if (query !== undefined && query !== "") {
      conditions.push("(p.id LIKE ? OR p.development_subject LIKE ?)");
      const pattern = `%${query}%`;
      parameters.push(pattern, pattern);
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.database.connection.prepare(`
      SELECT p.id, p.development_subject, p.created_at AS registered_at,
             pa.nickname, pa.status AS account_status, pa.last_active_at,
             (SELECT COUNT(*) FROM patient_sessions ps WHERE ps.patient_id = p.id) AS session_count,
             ${RECORD_COUNT_SQL} AS record_count
      FROM patients p
      LEFT JOIN patient_accounts pa ON pa.patient_id = p.id
      ${where}
      ORDER BY p.created_at DESC, p.id ASC
      LIMIT ?
    `).all(...parameters, limit) as unknown as UserListShape[];
    return rows.map(toUserRow);
  }

  async findUser(id: string): Promise<UserListRow | null> {
    const row = this.database.connection.prepare(`
      SELECT p.id, p.development_subject, p.created_at AS registered_at,
             pa.nickname, pa.status AS account_status, pa.last_active_at,
             (SELECT COUNT(*) FROM patient_sessions ps WHERE ps.patient_id = p.id) AS session_count,
             ${RECORD_COUNT_SQL} AS record_count
      FROM patients p
      LEFT JOIN patient_accounts pa ON pa.patient_id = p.id
      WHERE p.id = ?
    `).get(id) as unknown as UserListShape | undefined;
    return row === undefined ? null : toUserRow(row);
  }

  async listSessions(userId: string, limit: number): Promise<PatientSessionRow[]> {
    const rows = this.database.connection.prepare(`
      SELECT token_hash, created_at, expires_at
      FROM patient_sessions WHERE patient_id = ?
      ORDER BY created_at DESC, token_hash ASC
      LIMIT ?
    `).all(userId, limit) as unknown as SessionShape[];
    return rows.map((row) => ({
      tokenHash: row.token_hash,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    }));
  }

  async listSymptomRecords(
    userId: string,
    limit: number
  ): Promise<SymptomProjectionRow[]> {
    const rows = this.database.connection.prepare(`
      SELECT id, local_date, nasal_congestion, nasal_itching, sneezing,
             runny_nose, tnss_total
      FROM symptom_records WHERE patient_id = ?
      ORDER BY local_date DESC, id ASC
      LIMIT ?
    `).all(userId, limit) as unknown as SymptomShape[];
    return rows.map((row) => ({
      id: row.id,
      localDate: row.local_date,
      nasalCongestion: row.nasal_congestion,
      nasalItching: row.nasal_itching,
      sneezing: row.sneezing,
      runnyNose: row.runny_nose,
      tnssTotal: row.tnss_total
    }));
  }

  async listExposureRecords(
    userId: string,
    limit: number
  ): Promise<ExposureProjectionRow[]> {
    const rows = this.database.connection.prepare(`
      SELECT id, local_date, factors_json
      FROM exposure_records WHERE patient_id = ?
      ORDER BY local_date DESC, id ASC
      LIMIT ?
    `).all(userId, limit) as unknown as ExposureShape[];
    return rows.map((row) => ({
      id: row.id,
      localDate: row.local_date,
      factorsJson: row.factors_json
    }));
  }

  async listMedicationRecords(
    userId: string,
    limit: number
  ): Promise<MedicationProjectionRow[]> {
    // 0005 迁移把用药正文列重建为 *_encrypted；管理端组合根不注入
    // 加密端口，只投影非加密列（id/local_date），正文不落入管理输出。
    const rows = this.database.connection.prepare(`
      SELECT id, local_date
      FROM medication_records WHERE patient_id = ?
      ORDER BY local_date DESC, id ASC
      LIMIT ?
    `).all(userId, limit) as unknown as Array<{
      id: string;
      local_date: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      localDate: row.local_date,
      medicationName: null,
      dosage: null
    }));
  }

  async activity(): Promise<ActivitySource> {
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 86_400_000
    ).toISOString();
    const total = this.database.connection.prepare(
      "SELECT COUNT(*) AS count FROM patients"
    ).get() as unknown as { count: number };
    const newUsers = this.database.connection.prepare(
      "SELECT COUNT(*) AS count FROM patients WHERE created_at >= ?"
    ).get(sevenDaysAgo) as unknown as { count: number };
    const activeUsers = this.database.connection.prepare(`
      SELECT COUNT(DISTINCT patient_id) AS count
      FROM patient_sessions WHERE created_at >= ?
    `).get(sevenDaysAgo) as unknown as { count: number };
    const sessions = this.database.connection.prepare(
      "SELECT COUNT(*) AS count FROM patient_sessions"
    ).get() as unknown as { count: number };
    const symptoms = this.database.connection.prepare(
      "SELECT COUNT(*) AS count FROM symptom_records"
    ).get() as unknown as { count: number };
    const exposures = this.database.connection.prepare(
      "SELECT COUNT(*) AS count FROM exposure_records"
    ).get() as unknown as { count: number };
    const medications = this.database.connection.prepare(
      "SELECT COUNT(*) AS count FROM medication_records"
    ).get() as unknown as { count: number };
    const published = this.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM content_items
      WHERE status = 'published' AND patient_visible = 1
    `).get() as unknown as { count: number };
    return {
      totalUsers: total.count,
      newUsers7d: newUsers.count,
      activeUsers7d: activeUsers.count,
      sessionCount: sessions.count,
      recordCount: symptoms.count + exposures.count + medications.count,
      contentPublishedCount: published.count
    };
  }
}
