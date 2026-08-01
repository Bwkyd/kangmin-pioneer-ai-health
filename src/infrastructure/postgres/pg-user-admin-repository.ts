import type {
  ActivitySource,
  ExposureProjectionRow,
  MedicationProjectionRow,
  PatientSessionRow,
  SymptomProjectionRow,
  UserListRow,
  UserReadRepository
} from "../../modules/user-admin/user-admin-ports.js";
import { KangminPgDatabase } from "./pg-database.js";

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

// 三张子查询各自 COUNT 均为 int8，整体求和后 ::int 强转回 number。
const RECORD_COUNT_SQL = `
  ((SELECT COUNT(*) FROM symptom_records s WHERE s.patient_id = p.id) +
  (SELECT COUNT(*) FROM exposure_records e WHERE e.patient_id = p.id) +
  (SELECT COUNT(*) FROM medication_records m WHERE m.patient_id = p.id))::int
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

export class PgUserAdminRepository implements UserReadRepository {
  constructor(private readonly database: KangminPgDatabase) {}

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
      const cutoffParam = parameters.length + 1;
      const sessionCutoffParam = parameters.length + 2;
      conditions.push(
        `(pa.last_active_at >= $${cutoffParam} OR EXISTS (
          SELECT 1 FROM patient_sessions s2 WHERE s2.patient_id = p.id AND s2.created_at >= $${sessionCutoffParam}
        ))`
      );
      parameters.push(cutoff, cutoff);
    }
    if (query !== undefined && query !== "") {
      const idPatternParam = parameters.length + 1;
      const subjectPatternParam = parameters.length + 2;
      // SQLite 的 LIKE 对 ASCII 大小写不敏感；PG LIKE 大小写敏感，
      // 用 ILIKE 保持与 SQLite 版一致的匹配语义。
      conditions.push(
        `(p.id ILIKE $${idPatternParam} OR p.development_subject ILIKE $${subjectPatternParam})`
      );
      const pattern = `%${query}%`;
      parameters.push(pattern, pattern);
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const limitParam = parameters.length + 1;
    const { rows } = await this.database.query<UserListShape>(
      `SELECT p.id, p.development_subject, p.created_at AS registered_at,
             pa.nickname, pa.status AS account_status, pa.last_active_at,
             (SELECT COUNT(*) FROM patient_sessions ps WHERE ps.patient_id = p.id)::int AS session_count,
             ${RECORD_COUNT_SQL} AS record_count
      FROM patients p
      LEFT JOIN patient_accounts pa ON pa.patient_id = p.id
      ${where}
      ORDER BY p.created_at DESC, p.id ASC
      LIMIT $${limitParam}`,
      [...parameters, limit]
    );
    return rows.map(toUserRow);
  }

  async findUser(id: string): Promise<UserListRow | null> {
    const { rows } = await this.database.query<UserListShape>(
      `SELECT p.id, p.development_subject, p.created_at AS registered_at,
             pa.nickname, pa.status AS account_status, pa.last_active_at,
             (SELECT COUNT(*) FROM patient_sessions ps WHERE ps.patient_id = p.id)::int AS session_count,
             ${RECORD_COUNT_SQL} AS record_count
      FROM patients p
      LEFT JOIN patient_accounts pa ON pa.patient_id = p.id
      WHERE p.id = $1`,
      [id]
    );
    const row = rows[0];
    return row === undefined ? null : toUserRow(row);
  }

  async listSessions(userId: string, limit: number): Promise<PatientSessionRow[]> {
    // 事务与卫生残留批 P2-5：已撤销会话（logout）不进入管理端会话列表，
    // 避免把已失效令牌误报为活跃会话。
    const { rows } = await this.database.query<SessionShape>(
      `SELECT token_hash, created_at, expires_at
      FROM patient_sessions
      WHERE patient_id = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC, token_hash ASC
      LIMIT $2`,
      [userId, limit]
    );
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
    const { rows } = await this.database.query<SymptomShape>(
      `SELECT id, local_date, nasal_congestion, nasal_itching, sneezing,
             runny_nose, tnss_total
      FROM symptom_records WHERE patient_id = $1
      ORDER BY local_date DESC, id ASC
      LIMIT $2`,
      [userId, limit]
    );
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
    const { rows } = await this.database.query<ExposureShape>(
      `SELECT id, local_date, factors_json
      FROM exposure_records WHERE patient_id = $1
      ORDER BY local_date DESC, id ASC
      LIMIT $2`,
      [userId, limit]
    );
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
    const { rows } = await this.database.query<{
      id: string;
      local_date: string;
    }>(
      `SELECT id, local_date
      FROM medication_records WHERE patient_id = $1
      ORDER BY local_date DESC, id ASC
      LIMIT $2`,
      [userId, limit]
    );
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
    // COUNT 在 PG 返回 int8（string），全部 ::int 强转回 number。
    const count = async (
      sql: string,
      params: readonly unknown[] = []
    ): Promise<number> => {
      const { rows } = await this.database.query<{ count: number }>(
        sql,
        params
      );
      return rows[0]?.count ?? 0;
    };
    const total = await count(
      "SELECT COUNT(*)::int AS count FROM patients"
    );
    const newUsers = await count(
      "SELECT COUNT(*)::int AS count FROM patients WHERE created_at >= $1",
      [sevenDaysAgo]
    );
    const activeUsers = await count(
      `SELECT COUNT(DISTINCT patient_id)::int AS count
      FROM patient_sessions WHERE created_at >= $1`,
      [sevenDaysAgo]
    );
    const sessions = await count(
      "SELECT COUNT(*)::int AS count FROM patient_sessions"
    );
    const symptoms = await count(
      "SELECT COUNT(*)::int AS count FROM symptom_records"
    );
    const exposures = await count(
      "SELECT COUNT(*)::int AS count FROM exposure_records"
    );
    const medications = await count(
      "SELECT COUNT(*)::int AS count FROM medication_records"
    );
    const published = await count(
      `SELECT COUNT(*)::int AS count FROM content_items
      WHERE status = 'published' AND patient_visible = 1`
    );
    return {
      totalUsers: total,
      newUsers7d: newUsers,
      activeUsers7d: activeUsers,
      sessionCount: sessions,
      recordCount: symptoms + exposures + medications,
      contentPublishedCount: published
    };
  }
}
