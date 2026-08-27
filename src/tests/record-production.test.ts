import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createApplication } from "@kangmin/runtime/composition-root";
import { writeConsentForTest } from "./consent-fixture.js";
import {
  AesGcmEncryption,
  parseEncryptionKeys,
  PlaintextEncryption
} from "@kangmin/integrations/security/aes-gcm-encryption";
import { DomainError } from "@kangmin/core/kernel/errors";
import type { EncryptionPort } from "@kangmin/core/kernel/encryption";
import type { CommandResult } from "@kangmin/core/kernel/result";
import type {
  CalendarProjection,
  ExposureRecord,
  HealthProfile,
  MedicationRecord,
  OverviewData,
  SymptomRecord,
  TrendProjection
} from "@kangmin/core/patient/record/contracts";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../../apps/kangmin-cli/dist/kangmin.js");

/** 固定的 32 字节测试密钥（base64），只用于测试，不进入任何生产数据。 */
const KEY_V1 = Buffer.alloc(32, 1).toString("base64");
const KEY_V2 = Buffer.alloc(32, 2).toString("base64");

function aes(): AesGcmEncryption {
  return new AesGcmEncryption(parseEncryptionKeys(`v1:${KEY_V1}`));
}

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

function errorOf(result: CommandResult): { code: string; retryable: boolean } {
  assert.equal(result.ok, false);
  if (result.ok) {
    return { code: "unreachable", retryable: false };
  }
  return { code: result.error.code, retryable: result.error.retryable };
}

async function fixture(encryption: EncryptionPort = aes()): Promise<{
  directory: string;
  databasePath: string;
  application: ReturnType<typeof createApplication>;
  patientId: string;
  token: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-record-prod-"));
  const databasePath = join(directory, "records.sqlite");
  const application = createApplication(databasePath, { encryption });
  const session = await application.sessions.createDevelopmentSession(
    "patient-enc"
  );
  // record 写入需 health_data 授权（issue-155 fail-closed）：dev 会话患者
  // 无本地账号，授权经仓储层补记（见 consent-fixture）。
  await writeConsentForTest(databasePath, session.patientId, "health_data");
  return {
    directory,
    databasePath,
    application,
    patientId: session.patientId,
    token: session.token
  };
}

interface VersionRow {
  record_type: string;
  record_id: string;
  revision: number;
  operation: string;
  encrypted_snapshot: string;
  encryption_key_version: string;
  actor_kind: string;
  actor_id: string;
  request_id: string;
}

const symptomInput = {
  localDate: "2026-07-01",
  nasalCongestion: 1,
  nasalItching: 1,
  sneezing: 1,
  runnyNose: 1,
  notes: "夜间鼻塞明显",
  idempotencyKey: "prod-symptom"
};

test("加密字段往返：症状、档案、暴露、用药正文经 AES 存储并可读回，库内不存明文", async () => {
  const { databasePath, application, token } = await fixture();
  try {
    const created = dataOf<SymptomRecord>(
      await application.execute({
        command: "record symptom add",
        input: symptomInput,
        sessionToken: token
      })
    );
    assert.equal(created.notes, "夜间鼻塞明显");

    const profile = dataOf<HealthProfile>(
      await application.execute({
        command: "record profile update",
        input: {
          expectedRevision: 0,
          displayName: "加密小王",
          birthDate: "1990-01-01",
          sex: "female",
          allergyHistory: "尘螨过敏",
          knownAllergies: "尘螨",
          commonTriggers: "花粉",
          notes: "档案备注"
        },
        sessionToken: token
      })
    );
    assert.equal(profile.displayName, "加密小王");
    assert.equal(profile.allergyHistory, "尘螨过敏");
    assert.equal(profile.birthDate, "1990-01-01"); // birth_date 明文

    const exposure = dataOf<ExposureRecord>(
      await application.execute({
        command: "record exposure add",
        input: {
          localDate: "2026-07-02",
          factors: ["other"],
          otherDescription: "装修气味",
          notes: "暴露备注",
          idempotencyKey: "prod-exposure"
        },
        sessionToken: token
      })
    );
    assert.equal(exposure.otherDescription, "装修气味");

    const medication = dataOf<MedicationRecord>(
      await application.execute({
        command: "record medication add",
        input: {
          localDate: "2026-07-03",
          medicationName: "氯雷他定",
          dosage: "10mg",
          actualUse: "每晚一次",
          notes: "用药备注",
          idempotencyKey: "prod-medication"
        },
        sessionToken: token
      })
    );
    assert.equal(medication.medicationName, "氯雷他定");

    const updated = dataOf<SymptomRecord>(
      await application.execute({
        command: "record symptom update",
        input: { id: created.id, expectedRevision: 1, notes: "更新后的备注" },
        sessionToken: token
      })
    );
    assert.equal(updated.notes, "更新后的备注");

    const cleared = dataOf<SymptomRecord>(
      await application.execute({
        command: "record symptom update",
        input: { id: created.id, expectedRevision: 2, notes: null },
        sessionToken: token
      })
    );
    assert.equal(cleared.notes, null);

    const raw = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const symptomRow = raw
        .prepare(
          `SELECT notes_encrypted, encryption_key_version
           FROM symptom_records WHERE id = ?`
        )
        .get(created.id) as {
        notes_encrypted: string | null;
        encryption_key_version: string | null;
      };
      assert.equal(symptomRow.notes_encrypted, null); // 已显式清空
      assert.equal(symptomRow.encryption_key_version, null);

      const profileRow = raw
        .prepare(
          `SELECT display_name_encrypted, allergy_history_encrypted,
                  known_allergies_encrypted, common_triggers_encrypted,
                  notes_encrypted, encryption_key_version, birth_date
           FROM profiles`
        )
        .get() as {
        display_name_encrypted: string;
        allergy_history_encrypted: string;
        known_allergies_encrypted: string;
        common_triggers_encrypted: string;
        notes_encrypted: string;
        encryption_key_version: string;
        birth_date: string;
      };
      assert.equal(profileRow.encryption_key_version, "v1");
      assert.equal(profileRow.birth_date, "1990-01-01");
      for (const stored of [
        profileRow.display_name_encrypted,
        profileRow.allergy_history_encrypted,
        profileRow.known_allergies_encrypted,
        profileRow.common_triggers_encrypted,
        profileRow.notes_encrypted
      ]) {
        assert.ok(!stored.includes("小王"));
        assert.ok(!stored.includes("尘螨"));
        assert.ok(!stored.includes("花粉"));
      }

      const medicationRow = raw
        .prepare(
          `SELECT medication_name_encrypted FROM medication_records`
        )
        .get() as { medication_name_encrypted: string };
      assert.ok(!medicationRow.medication_name_encrypted.includes("氯雷他定"));
    } finally {
      raw.close();
    }
  } finally {
    application.close();
  }
});

test("解密失败映射为 storage_unavailable（retryable: false），不伪装为空数据", async () => {
  const { databasePath, application, token } = await fixture(
    new PlaintextEncryption()
  );
  let plainSymptomId = "";
  try {
    const plainSymptom = dataOf<SymptomRecord>(
      await application.execute({
        command: "record symptom add",
        input: {
          ...symptomInput,
          idempotencyKey: "plain-symptom"
        },
        sessionToken: token
      })
    );
    plainSymptomId = plainSymptom.id;
    await application.execute({
      command: "record medication add",
      input: {
        localDate: "2026-07-03",
        medicationName: "氯雷他定",
        idempotencyKey: "plain-medication"
      },
      sessionToken: token
    });
    await application.execute({
      command: "record profile update",
      input: {
        expectedRevision: 0,
        displayName: "明文档案"
      },
      sessionToken: token
    });
  } finally {
    application.close();
  }

  // 生产语义（AES 密钥）打开同一数据库：plaintext-dev 版本数据必须被拒绝，
  // 抛 storage_unavailable 而不是返回空列表或 null 字段。
  const production = createApplication(databasePath, { encryption: aes() });
  try {
    const listed = await production.execute({
      command: "record symptom list",
      sessionToken: token
    });
    assert.deepEqual(errorOf(listed), {
      code: "storage_unavailable",
      retryable: false
    });

    const medications = await production.execute({
      command: "record medication list",
      sessionToken: token
    });
    assert.deepEqual(errorOf(medications), {
      code: "storage_unavailable",
      retryable: false
    });

    const profile = await production.execute({
      command: "record profile show",
      sessionToken: token
    });
    assert.deepEqual(errorOf(profile), {
      code: "storage_unavailable",
      retryable: false
    });

    // 单条读取：真实存在的记录解密失败同样抛 storage_unavailable
    const single = await production.execute({
      command: "record symptom show",
      input: { id: plainSymptomId },
      sessionToken: token
    });
    assert.deepEqual(errorOf(single), {
      code: "storage_unavailable",
      retryable: false
    });

    // 不存在的记录在解密前就返回 resource_not_found（不触碰密文）
    const missing = await production.execute({
      command: "record symptom show",
      input: { id: "no-such-id" },
      sessionToken: token
    });
    assert.deepEqual(errorOf(missing), {
      code: "resource_not_found",
      retryable: false
    });
  } finally {
    production.close();
  }
});

test("软删除：已删记录从列表与投影中消失，同日可重建，原幂等键仍为 stale_replay", async () => {
  const { application, token } = await fixture();
  try {
    const created = dataOf<SymptomRecord>(
      await application.execute({
        command: "record symptom add",
        input: { ...symptomInput, idempotencyKey: "soft-del-1" },
        sessionToken: token
      })
    );

    const overviewBefore = dataOf<OverviewData>(
      await application.execute({ command: "record overview", sessionToken: token })
    );
    assert.equal(overviewBefore.recentSymptomDate, "2026-07-01");

    const deleted = await application.execute({
      command: "record symptom delete",
      input: { id: created.id, expectedRevision: 1, yes: true },
      sessionToken: token
    });
    assert.equal(deleted.ok, true);

    const listed = dataOf<{ items: SymptomRecord[] }>(
      await application.execute({ command: "record symptom list", sessionToken: token })
    );
    assert.equal(listed.items.length, 0);

    const calendar = dataOf<CalendarProjection>(
      await application.execute({
        command: "record calendar",
        input: { month: "2026-07" },
        sessionToken: token
      })
    );
    assert.equal(calendar.days.length, 0);

    const trend = dataOf<TrendProjection>(
      await application.execute({
        command: "record trend",
        input: { from: "2026-07-01", to: "2026-07-31" },
        sessionToken: token
      })
    );
    assert.equal(trend.items.length, 0);

    const overview = dataOf<OverviewData>(
      await application.execute({ command: "record overview", sessionToken: token })
    );
    assert.equal(overview.recentSymptomDate, null);
    assert.equal(overview.monthRecordCount, 0);

    // 删除后同日可重建（部分唯一索引允许）
    const rebuilt = dataOf<SymptomRecord>(
      await application.execute({
        command: "record symptom add",
        input: { ...symptomInput, idempotencyKey: "soft-del-2" },
        sessionToken: token
      })
    );
    assert.notEqual(rebuilt.id, created.id);

    // 原幂等键重放：记录已删 → stale_replay，不返回幻影记录
    const replay = await application.execute({
      command: "record symptom add",
      input: { ...symptomInput, idempotencyKey: "soft-del-1" },
      sessionToken: token
    });
    assert.equal(errorOf(replay).code, "stale_replay");
  } finally {
    application.close();
  }
});

test("版本历史凭证：create/update/delete 各追加一条，快照为加密的完整记录", async () => {
  const { databasePath, application, patientId, token } = await fixture();
  try {
    const created = dataOf<SymptomRecord>(
      await application.execute({
        command: "record symptom add",
        input: {
          ...symptomInput,
          localDate: "2026-05-10",
          idempotencyKey: "ledger-symptom"
        },
        sessionToken: token,
        requestId: "req-symptom-create"
      })
    );
    dataOf<SymptomRecord>(
      await application.execute({
        command: "record symptom update",
        input: {
          id: created.id,
          expectedRevision: 1,
          notes: "二版备注"
        },
        sessionToken: token,
        requestId: "req-symptom-update"
      })
    );
    await application.execute({
      command: "record symptom delete",
      input: { id: created.id, expectedRevision: 2, yes: true },
      sessionToken: token,
      requestId: "req-symptom-delete"
    });

    dataOf<HealthProfile>(
      await application.execute({
        command: "record profile update",
        input: { expectedRevision: 0, displayName: "凭证档案" },
        sessionToken: token,
        requestId: "req-profile-create"
      })
    );
    dataOf<HealthProfile>(
      await application.execute({
        command: "record profile update",
        input: { expectedRevision: 1, notes: "凭证档案更新" },
        sessionToken: token,
        requestId: "req-profile-update"
      })
    );

    const raw = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const symptomRows = raw
        .prepare(
          `SELECT record_type, record_id, revision, operation,
                  encrypted_snapshot, encryption_key_version,
                  actor_kind, actor_id, request_id
           FROM patient_record_versions
           WHERE record_type = 'symptom'
           ORDER BY revision ASC`
        )
        .all() as unknown as VersionRow[];
      const profileRows = raw
        .prepare(
          `SELECT record_type, record_id, revision, operation,
                  encrypted_snapshot, encryption_key_version,
                  actor_kind, actor_id, request_id
           FROM patient_record_versions
           WHERE record_type = 'profile'
           ORDER BY revision ASC`
        )
        .all() as unknown as VersionRow[];
      assert.equal(symptomRows.length, 3);
      assert.equal(profileRows.length, 2);

      const sCreate = symptomRows[0]!;
      const sUpdate = symptomRows[1]!;
      const sDelete = symptomRows[2]!;
      const pCreate = profileRows[0]!;
      const pUpdate = profileRows[1]!;
      assert.equal(sCreate.record_type, "symptom");
      assert.equal(sCreate.record_id, created.id);
      assert.equal(sCreate.revision, 1);
      assert.equal(sCreate.operation, "create");
      assert.equal(sCreate.actor_kind, "patient");
      assert.equal(sCreate.actor_id, patientId);
      assert.equal(sCreate.request_id, "req-symptom-create");

      const snapshot = (row: VersionRow): SymptomRecord => {
        const payload = JSON.parse(row.encrypted_snapshot) as {
          ciphertext: string;
          iv: string;
          authTag: string;
        };
        const plaintext = aes().decrypt({
          ...payload,
          keyVersion: row.encryption_key_version
        });
        return JSON.parse(plaintext) as SymptomRecord;
      };
      assert.equal(snapshot(sCreate).notes, "夜间鼻塞明显");
      assert.equal(snapshot(sCreate).revision, 1);

      assert.equal(sUpdate.operation, "update");
      assert.equal(sUpdate.revision, 2);
      assert.equal(sUpdate.request_id, "req-symptom-update");
      assert.equal(snapshot(sUpdate).notes, "二版备注");
      assert.equal(snapshot(sUpdate).revision, 2);

      // 删除凭证 revision 取被删 revision + 1，快照为删除时的记录内容
      assert.equal(sDelete.operation, "delete");
      assert.equal(sDelete.revision, 3);
      assert.equal(sDelete.request_id, "req-symptom-delete");
      assert.equal(snapshot(sDelete).notes, "二版备注");

      assert.equal(pCreate.record_type, "profile");
      assert.equal(pCreate.record_id, patientId);
      assert.equal(pCreate.revision, 1);
      assert.equal(pCreate.operation, "create");
      assert.equal(pCreate.request_id, "req-profile-create");
      assert.equal(pUpdate.operation, "update");
      assert.equal(pUpdate.revision, 2);
      assert.equal(pUpdate.request_id, "req-profile-update");
      assert.equal(snapshot(pUpdate).notes, "凭证档案更新");
    } finally {
      raw.close();
    }
  } finally {
    application.close();
  }
});

test("幂等重放不追加版本凭证，重放返回原结果", async () => {
  const { databasePath, application, token } = await fixture();
  try {
    await application.execute({
      command: "record medication add",
      input: {
        localDate: "2026-04-01",
        medicationName: "鼻喷剂",
        idempotencyKey: "ledger-replay"
      },
      sessionToken: token
    });
    const replay = await application.execute({
      command: "record medication add",
      input: {
        localDate: "2026-04-01",
        medicationName: "鼻喷剂",
        idempotencyKey: "ledger-replay"
      },
      sessionToken: token
    });
    assert.equal(replay.ok, true);

    const raw = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const count = raw
        .prepare(
          `SELECT COUNT(*) AS count FROM patient_record_versions`
        )
        .get() as { count: number };
      assert.equal(count.count, 1);
    } finally {
      raw.close();
    }
  } finally {
    application.close();
  }
});

test("密钥来源：生产缺密钥启动失败 config_missing，本地/开发会话明文降级", () => {
  const savedKeys = process.env.KANGMIN_ENCRYPTION_KEYS;
  const savedAppEnv = process.env.KANGMIN_APP_ENV;
  const savedDevSession = process.env.KANGMIN_ALLOW_DEV_SESSION;
  const directory = mkdtempSync(join(tmpdir(), "kangmin-env-"));
  try {
    delete process.env.KANGMIN_ENCRYPTION_KEYS;
    delete process.env.KANGMIN_APP_ENV;
    delete process.env.KANGMIN_ALLOW_DEV_SESSION;

    // 生产（含未声明环境）缺密钥 → config_missing
    assert.throws(
      () => createApplication(join(directory, "records.sqlite")),
      (error: unknown) =>
        error instanceof DomainError && error.code === "config_missing"
    );

    // KANGMIN_APP_ENV=local → PlaintextEncryption 明文降级
    process.env.KANGMIN_APP_ENV = "local";
    const localApp = createApplication(join(directory, "records.sqlite"));
    localApp.close();

    // KANGMIN_ALLOW_DEV_SESSION=1 → 明文降级
    delete process.env.KANGMIN_APP_ENV;
    process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
    const devApp = createApplication(join(directory, "records.sqlite"));
    devApp.close();

    // 显式配置密钥优先于开发降级
    process.env.KANGMIN_ENCRYPTION_KEYS = `v1:${KEY_V1}`;
    const keyed = createApplication(join(directory, "records.sqlite"));
    keyed.close();
  } finally {
    if (savedKeys === undefined) {
      delete process.env.KANGMIN_ENCRYPTION_KEYS;
    } else {
      process.env.KANGMIN_ENCRYPTION_KEYS = savedKeys;
    }
    if (savedAppEnv === undefined) {
      delete process.env.KANGMIN_APP_ENV;
    } else {
      process.env.KANGMIN_APP_ENV = savedAppEnv;
    }
    if (savedDevSession === undefined) {
      delete process.env.KANGMIN_ALLOW_DEV_SESSION;
    } else {
      process.env.KANGMIN_ALLOW_DEV_SESSION = savedDevSession;
    }
  }
});

test("本地明文降级写入 plaintext-dev 版本，库内可核对", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-plaintext-"));
  const databasePath = join(directory, "records.sqlite");
  const application = createApplication(databasePath, {
    encryption: new PlaintextEncryption()
  });
  try {
    const session =
      await application.sessions.createDevelopmentSession("patient-plain");
    // record 写入需 health_data 授权（issue-155 fail-closed）。
    await writeConsentForTest(databasePath, session.patientId, "health_data");
    await application.execute({
      command: "record symptom add",
      input: {
        ...symptomInput,
        idempotencyKey: "plaintext-dev-row"
      },
      sessionToken: session.token
    });
    const raw = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = raw
        .prepare(
          `SELECT notes_encrypted, encryption_key_version
           FROM symptom_records`
        )
        .get() as { notes_encrypted: string; encryption_key_version: string };
      assert.equal(row.encryption_key_version, "plaintext-dev");
      // 明文降级也是 base64 存储，正文不直接落盘
      assert.ok(!row.notes_encrypted.includes("夜间鼻塞明显"));
    } finally {
      raw.close();
    }
  } finally {
    application.close();
  }
});

test("生产模式 CLI 启动缺密钥退出码 5（config_missing）", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-cli-prod-"));
  const cleanEnvironment: Record<string, string | undefined> = {
    ...process.env,
    KANGMIN_DB_PATH: join(directory, "records.sqlite"),
    KANGMIN_SESSION_TOKEN: "not-used"
  };
  delete cleanEnvironment.KANGMIN_ENCRYPTION_KEYS;
  delete cleanEnvironment.KANGMIN_APP_ENV;
  delete cleanEnvironment.KANGMIN_ALLOW_DEV_SESSION;

  const run = spawnSync(
    process.execPath,
    [cli, "record", "symptom", "list", "--json"],
    { encoding: "utf8", env: cleanEnvironment }
  );
  assert.equal(run.status, 5, run.stderr);
  const body = JSON.parse(run.stdout) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "config_missing");
});

test("旧明文开发数据库迁移升级：加密回填后仍可读取，账本推进到 0005", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-legacy-"));
  const databasePath = join(directory, "records.sqlite");
  const now = new Date().toISOString();

  // 手工构造 0001/0002 时代的旧库（明文列 + 已应用账本）
  const raw = new DatabaseSync(databasePath);
  raw.exec(`
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations(version, applied_at) VALUES
      ('0001_patient_record_baseline', '${now}'),
      ('0002_system_ledger', '${now}');

    CREATE TABLE patients (
      id TEXT PRIMARY KEY, development_subject TEXT UNIQUE,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE patient_sessions (
      token_hash TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES patients(id),
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE symptom_records (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES patients(id),
      local_date TEXT NOT NULL,
      nasal_congestion INTEGER NOT NULL CHECK(nasal_congestion BETWEEN 0 AND 3),
      nasal_itching INTEGER NOT NULL CHECK(nasal_itching BETWEEN 0 AND 3),
      sneezing INTEGER NOT NULL CHECK(sneezing BETWEEN 0 AND 3),
      runny_nose INTEGER NOT NULL CHECK(runny_nose BETWEEN 0 AND 3),
      tnss_total INTEGER NOT NULL CHECK(tnss_total BETWEEN 0 AND 12),
      notes TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(patient_id, local_date)
    ) STRICT;

    CREATE INDEX symptom_records_patient_date
    ON symptom_records(patient_id, local_date DESC);

    CREATE TABLE idempotency_records (
      patient_id TEXT NOT NULL REFERENCES patients(id),
      command_scope TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(patient_id, command_scope, idempotency_key)
    ) STRICT;

    CREATE TABLE profiles (
      patient_id TEXT PRIMARY KEY REFERENCES patients(id),
      display_name TEXT, birth_date TEXT,
      sex TEXT NOT NULL DEFAULT 'unspecified'
        CHECK(sex IN ('female', 'male', 'other', 'unspecified')),
      allergy_history TEXT, known_allergies TEXT,
      common_triggers TEXT, notes TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE exposure_records (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES patients(id),
      local_date TEXT NOT NULL,
      factors_json TEXT NOT NULL,
      other_description TEXT, notes TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(patient_id, local_date)
    ) STRICT;

    CREATE TABLE medication_records (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES patients(id),
      local_date TEXT NOT NULL,
      medication_name TEXT NOT NULL,
      dosage TEXT, actual_use TEXT, notes TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE patient_record_versions (
      record_type TEXT NOT NULL
        CHECK(record_type IN ('symptom', 'profile', 'exposure', 'medication')),
      record_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'delete')),
      encrypted_snapshot TEXT NOT NULL,
      encryption_key_version TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK(actor_kind IN ('patient', 'system')),
      actor_id TEXT,
      request_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(record_type, record_id, revision)
    ) STRICT;

    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      actor_kind TEXT NOT NULL CHECK(actor_kind IN ('patient', 'admin', 'system')),
      actor_id TEXT NOT NULL, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      entity_revision INTEGER, request_id TEXT,
      details_json TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
  `);
  raw
    .prepare(
      `INSERT INTO patients(id, development_subject, created_at)
       VALUES (?, ?, ?)`
    )
    .run("patient-legacy", "patient-legacy", now);
  raw
    .prepare(
      `INSERT INTO symptom_records(
        id, patient_id, local_date,
        nasal_congestion, nasal_itching, sneezing, runny_nose,
        tnss_total, notes, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "symptom-legacy-1", "patient-legacy", "2026-06-01",
      1, 1, 1, 1, 4, "旧库明文症状备注", 1, now, now
    );
  raw
    .prepare(
      `INSERT INTO profiles(
        patient_id, display_name, birth_date, sex,
        allergy_history, known_allergies, common_triggers, notes,
        revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      "patient-legacy", "旧库小王", "1988-03-15", "male",
      "旧过敏史", null, null, "旧档案备注", now, now
    );
  raw.close();

  // 升级：0003/0004/0005 迁移应用，旧明文加密回填
  const application = createApplication(databasePath, { encryption: aes() });
  try {
    const session = await application.sessions.createDevelopmentSession(
      "patient-legacy"
    );
    const symptom = dataOf<SymptomRecord>(
      await application.execute({
        command: "record symptom show",
        input: { id: "symptom-legacy-1" },
        sessionToken: session.token
      })
    );
    assert.equal(symptom.notes, "旧库明文症状备注");

    const profile = dataOf<HealthProfile>(
      await application.execute({
        command: "record profile show",
        sessionToken: session.token
      })
    );
    assert.equal(profile.displayName, "旧库小王");
    assert.equal(profile.allergyHistory, "旧过敏史");
    assert.equal(profile.notes, "旧档案备注");
    assert.equal(profile.birthDate, "1988-03-15");

    const migrations = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = migrations
        .prepare(
          `SELECT notes_encrypted, encryption_key_version
           FROM symptom_records WHERE id = ?`
        )
        .get("symptom-legacy-1") as {
        notes_encrypted: string | null;
        encryption_key_version: string | null;
      };
      assert.notEqual(row.notes_encrypted, null);
      assert.equal(row.encryption_key_version, "v1");
      assert.ok(!(row.notes_encrypted ?? "").includes("旧库明文症状备注"));

      const applied = (
        migrations
          .prepare(`SELECT version FROM schema_migrations ORDER BY version`)
          .all() as unknown as Array<{ version: string }>
      ).map((entry) => entry.version);
      assert.ok(applied.includes("0005_record_encryption_soft_delete"));
    } finally {
      migrations.close();
    }
  } finally {
    application.close();
  }
});
