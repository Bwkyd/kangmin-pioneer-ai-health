import { KangminAdminApplication } from "./admin-application.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { SqliteAdminSessionRepository } from "../infrastructure/sqlite-admin-session-repository.js";
import { SqliteContentAdminRepository } from "../infrastructure/sqlite-content-admin-repository.js";
export function createAdminApplication(path: string) { const database = new KangminDatabase(path); return new KangminAdminApplication(new SqliteAdminSessionRepository(database), new SqliteContentAdminRepository(database), () => database.close()); }
