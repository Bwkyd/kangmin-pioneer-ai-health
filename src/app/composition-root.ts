import { KangminApplication } from "./application.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { SqliteAccountRepository } from "../infrastructure/sqlite-account-repository.js";
import { SqliteAgentRepository } from "../infrastructure/sqlite-agent-repository.js";
import { SqliteContentReadRepository } from "../infrastructure/sqlite-content-read-repository.js";
import { SqliteRecordRepository } from "../infrastructure/sqlite-record-repository.js";
import { SqliteSessionRepository } from "../infrastructure/sqlite-session-repository.js";
import { AccountService } from "../modules/account/account-service.js";
import { SessionService } from "../modules/account/session-service.js";

export function createApplication(databasePath: string): KangminApplication {
  const database = new KangminDatabase(databasePath);
  const sessions = new SessionService(new SqliteSessionRepository(database));
  return new KangminApplication(
    sessions,
    new SqliteRecordRepository(database),
    new SqliteContentReadRepository(database),
    new SqliteAgentRepository(database),
    new AccountService(new SqliteAccountRepository(database), sessions),
    () => {
      database.close();
    }
  );
}
