import type { AgentSession } from "./contracts.js";

export type UpdateAgentSessionOutcome =
  | { kind: "updated"; session: AgentSession }
  | { kind: "not_found" }
  | { kind: "version_conflict"; currentRevision: number };

export interface AgentRepository {
  create(patientId: string, session: AgentSession): Promise<void>;
  find(patientId: string, id: string): Promise<AgentSession | null>;
  list(patientId: string): Promise<AgentSession[]>;
  update(
    patientId: string,
    expectedRevision: number,
    session: AgentSession
  ): Promise<UpdateAgentSessionOutcome>;
}
