import { randomUUID } from "node:crypto";

import { KangminDatabase } from "../infrastructure/database.js";
import { SqliteAccountRepository } from "../infrastructure/sqlite-account-repository.js";
import type {
  ConsentDecision,
  ConsentType
} from "../modules/account/account-repository.js";

/**
 * 测试辅助（issue-155 consent 前置）：直接经 SQLite 仓储追加 consent 决策。
 * 开发会话患者没有本地账号（account consent update 要求 patient_accounts
 * 行），测试里的授权/撤回只能走仓储层，落库记录与生产授权同构。
 */
export async function writeConsentForTest(
  databasePath: string,
  patientId: string,
  consentType: ConsentType,
  decision: ConsentDecision = "granted"
): Promise<void> {
  const database = new KangminDatabase(databasePath);
  try {
    await new SqliteAccountRepository(database).appendConsent({
      patientId,
      consentType,
      decision,
      policyVersion: "2026-08-01.1",
      requestId: `test-${randomUUID()}`,
      createdAt: new Date().toISOString()
    });
  } finally {
    database.close();
  }
}
