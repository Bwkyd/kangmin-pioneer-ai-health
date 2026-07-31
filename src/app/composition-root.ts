import { KangminApplication } from "./application.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { SqliteRecordRepository } from "../infrastructure/sqlite-record-repository.js";
import { SqliteSessionRepository } from "../infrastructure/sqlite-session-repository.js";

export function createApplication(databasePath: string): KangminApplication {
  const database = new KangminDatabase(databasePath);
  return new KangminApplication(
    new SqliteSessionRepository(database),
    new SqliteRecordRepository(database),
    () => {
      database.close();
    }
  );
}
