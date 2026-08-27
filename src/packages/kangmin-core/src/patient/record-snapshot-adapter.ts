import type { AgentRecordSnapshotReader } from "../intelligence/agent/record-snapshot-reader.js";
import type { AgentRecordSnapshot } from "../intelligence/agent/contracts.js";
import { RecordService } from "./record/record-service.js";

function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class RecordSnapshotAdapter implements AgentRecordSnapshotReader {
  constructor(private readonly records: RecordService) {}

  async read(patientId: string): Promise<AgentRecordSnapshot> {
    const overview = await this.records.getOverview(patientId, localToday());
    return {
      capturedAt: new Date().toISOString(),
      recentSymptomDate: overview.recentSymptomDate,
      lastTnss: overview.lastTnss,
      recentExposureDate: overview.recentExposureDate,
      recentMedicationDate: overview.recentMedicationDate
    };
  }
}
