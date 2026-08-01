import type {
  AgentRepository,
  UpdateAgentSessionOutcome
} from "../../modules/agent/agent-repository.js";
import type { AgentSession } from "../../modules/agent/contracts.js";
import { KangminPgDatabase } from "./pg-database.js";

interface AgentSessionRow {
  revision: number;
  session_json: string;
}

function parse(row: AgentSessionRow): AgentSession {
  return JSON.parse(row.session_json) as AgentSession;
}

export class PgAgentRepository implements AgentRepository {
  constructor(private readonly database: KangminPgDatabase) {}

  async create(patientId: string, session: AgentSession): Promise<void> {
    await this.database.transaction(async (client) => {
      await this.database.queryIn(
        client,
        `INSERT INTO agent_sessions(
          id, patient_id, status, revision, session_json, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          session.id,
          patientId,
          session.status,
          session.revision,
          JSON.stringify(session),
          session.createdAt,
          session.updatedAt
        ]
      );
    });
  }

  async find(patientId: string, id: string): Promise<AgentSession | null> {
    const { rows } = await this.database.query<AgentSessionRow>(
      `SELECT revision, session_json
       FROM agent_sessions
       WHERE id = $1 AND patient_id = $2`,
      [id, patientId]
    );
    const row = rows[0];
    return row === undefined ? null : parse(row);
  }

  async list(patientId: string): Promise<AgentSession[]> {
    const { rows } = await this.database.query<AgentSessionRow>(
      `SELECT revision, session_json
       FROM agent_sessions
       WHERE patient_id = $1
       ORDER BY updated_at DESC`,
      [patientId]
    );
    return rows.map(parse);
  }

  async update(
    patientId: string,
    expectedRevision: number,
    session: AgentSession
  ): Promise<UpdateAgentSessionOutcome> {
    return this.database.transaction(async (client) => {
      const currentResult = await this.database.queryIn<AgentSessionRow>(
        client,
        `SELECT revision, session_json
         FROM agent_sessions
         WHERE id = $1 AND patient_id = $2`,
        [session.id, patientId]
      );
      const current = currentResult.rows[0];
      if (current === undefined) {
        return { kind: "not_found" };
      }
      if (current.revision !== expectedRevision) {
        return {
          kind: "version_conflict",
          currentRevision: current.revision
        };
      }
      const updateResult = await this.database.queryIn(
        client,
        `UPDATE agent_sessions
         SET status = $1, revision = $2, session_json = $3, updated_at = $4
         WHERE id = $5 AND patient_id = $6 AND revision = $7`,
        [
          session.status,
          session.revision,
          JSON.stringify(session),
          session.updatedAt,
          session.id,
          patientId,
          expectedRevision
        ]
      );
      if (updateResult.rowCount !== 1) {
        // 与 SQLite 版一致：CAS 未命中时重新读最新版本，
        // 区分“行已不存在”（not_found）与“并发推进”（version_conflict）。
        const latestResult = await this.database.queryIn<{ revision: number }>(
          client,
          "SELECT revision FROM agent_sessions WHERE id = $1 AND patient_id = $2",
          [session.id, patientId]
        );
        const latest = latestResult.rows[0];
        return latest === undefined
          ? { kind: "not_found" }
          : { kind: "version_conflict", currentRevision: latest.revision };
      }
      return { kind: "updated", session };
    });
  }
}
