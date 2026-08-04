import type { AgentSession } from "./contracts.js";

export type UpdateAgentSessionOutcome =
  | { kind: "updated"; session: AgentSession }
  | { kind: "not_found" }
  | { kind: "version_conflict"; currentRevision: number };

export interface AgentRepository {
  create(patientId: string, session: AgentSession): Promise<void>;
  find(patientId: string, id: string): Promise<AgentSession | null>;
  list(patientId: string): Promise<AgentSession[]>;
  /** 裸 agent continue（设计 §6.5）：该患者最近更新的待答会话；无待答返回 null。 */
  findLatestAwaiting(patientId: string): Promise<AgentSession | null>;
  update(
    patientId: string,
    expectedRevision: number,
    session: AgentSession
  ): Promise<UpdateAgentSessionOutcome>;
}
