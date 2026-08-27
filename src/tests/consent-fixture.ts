import { randomUUID } from "node:crypto";

import { KangminDatabase } from "@kangmin/database/sqlite/database";
import { SqliteAccountRepository } from "@kangmin/database/sqlite/account-repository";
import type {
  ConsentDecision,
  ConsentType
} from "@kangmin/core/patient/account/account-repository";

/**
 * 测试辅助（issue-155 consent 前置）：直接经 SQLite 仓储追加 consent 决策。
 * 低层记录/代理测试可在同一 SQLite 直接补记授权，以便聚焦
 * 被测服务；HTTP/Web 端到端测试必须通过 account consent update。
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
