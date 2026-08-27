import { KangminDatabase } from "./database.js";
import type {
  AgentRepository,
  UpdateAgentSessionOutcome
} from "@kangmin/core/intelligence/agent/agent-repository";
import type { AgentSession } from "@kangmin/core/intelligence/agent/contracts";

interface AgentSessionRow {
  revision: number;
  session_json: string;
}

function parse(row: AgentSessionRow): AgentSession {
  return JSON.parse(row.session_json) as AgentSession;
}

export class SqliteAgentRepository implements AgentRepository {
  constructor(private readonly database: KangminDatabase) {}

  async create(patientId: string, session: AgentSession): Promise<void> {
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO agent_sessions(
            id, patient_id, status, revision, session_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          session.id,
          patientId,
          session.status,
          session.revision,
          JSON.stringify(session),
          session.createdAt,
          session.updatedAt
        );
    });
  }

  async find(patientId: string, id: string): Promise<AgentSession | null> {
    const row = this.database.connection
      .prepare(`
        SELECT revision, session_json
        FROM agent_sessions
        WHERE id = ? AND patient_id = ?
      `)
      .get(id, patientId) as unknown as AgentSessionRow | undefined;
    return row === undefined ? null : parse(row);
  }

  async list(patientId: string): Promise<AgentSession[]> {
    const rows = this.database.connection
      .prepare(`
        SELECT revision, session_json
        FROM agent_sessions
        WHERE patient_id = ?
        ORDER BY updated_at DESC
      `)
      .all(patientId) as unknown as AgentSessionRow[];
    return rows.map(parse);
  }

  async findLatestAwaiting(patientId: string): Promise<AgentSession | null> {
    const row = this.database.connection
      .prepare(`
        SELECT revision, session_json
        FROM agent_sessions
        WHERE patient_id = ? AND status = 'awaiting_answer'
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(patientId) as unknown as AgentSessionRow | undefined;
    return row === undefined ? null : parse(row);
  }

  async update(
    patientId: string,
    expectedRevision: number,
    session: AgentSession
  ): Promise<UpdateAgentSessionOutcome> {
    return this.database.transaction(() => {
      const current = this.database.connection
        .prepare(`
          SELECT revision, session_json
          FROM agent_sessions
          WHERE id = ? AND patient_id = ?
        `)
        .get(session.id, patientId) as unknown as AgentSessionRow | undefined;
      if (current === undefined) {
        return { kind: "not_found" };
      }
      if (current.revision !== expectedRevision) {
        return {
          kind: "version_conflict",
          currentRevision: current.revision
        };
      }
      const result = this.database.connection
        .prepare(`
          UPDATE agent_sessions
          SET status = ?, revision = ?, session_json = ?, updated_at = ?
          WHERE id = ? AND patient_id = ? AND revision = ?
        `)
        .run(
          session.status,
          session.revision,
          JSON.stringify(session),
          session.updatedAt,
          session.id,
          patientId,
          expectedRevision
        );
      if (result.changes !== 1) {
        const latest = this.database.connection
          .prepare("SELECT revision FROM agent_sessions WHERE id = ? AND patient_id = ?")
          .get(session.id, patientId) as unknown as
          | { revision: number }
          | undefined;
        return latest === undefined
          ? { kind: "not_found" }
          : { kind: "version_conflict", currentRevision: latest.revision };
      }
      return { kind: "updated", session };
    });
  }
}
