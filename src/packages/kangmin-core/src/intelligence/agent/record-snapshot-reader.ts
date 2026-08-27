import type { AgentRecordSnapshot } from "./contracts.js";

/** Agent 只能通过该端口读取 Record 投影，不能访问 Record repository。 */
export interface AgentRecordSnapshotReader {
  read(patientId: string): Promise<AgentRecordSnapshot>;
}
