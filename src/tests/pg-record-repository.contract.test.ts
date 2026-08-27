import assert from "node:assert/strict";
import test from "node:test";

import { PlaintextEncryption } from "../infrastructure/aes-gcm-encryption.js";
import { decryptStoredField } from "@kangmin/database/shared/encrypted-fields";
import { KangminPgDatabase } from "@kangmin/database/postgres/database";
import { PgRecordRepository } from "@kangmin/database/postgres/record-repository";
import { DomainError } from "@kangmin/core/kernel/errors";
import {
  createPgTestDatabase,
  type PgTestDatabase
} from "./pg-test-database.js";
import type {
  ExposureRecord,
  MedicationRecord,
  SymptomRecord
} from "@kangmin/core/patient/record/contracts";

const databaseUrl = process.env.KANGMIN_TEST_DATABASE_URL;

if (databaseUrl === undefined) {
  test("PgRecordRepository 契约", { skip: "未配置 KANGMIN_TEST_DATABASE_URL" }, () => {});
} else {
  let testDatabase: PgTestDatabase;
  let database: KangminPgDatabase;
  let repository: PgRecordRepository;
  const encryption = new PlaintextEncryption();

  test.before(async () => {
    const created = await createPgTestDatabase("pg_record");
    assert.ok(created !== null);
    testDatabase = created;
    database = new KangminPgDatabase(testDatabase.url);
    await database.ready;
    repository = new PgRecordRepository(database, encryption);
  });

  test.after(async () => {
    await database.close();
    await testDatabase.close();
  });

  const NOW = "2026-07-01T08:00:00.000Z";

  /** 症状/暴露/用药外键依赖 patients 行，按患者逐个插入。 */
  async function insertPatient(patientId: string): Promise<void> {
    await database.query(
      `INSERT INTO patients(id, development_subject, created_at)
       VALUES ($1, $2, $3)`,
      [patientId, `subject-${patientId}`, NOW]
    );
  }

  function symptomRecord(
    id: string,
    localDate: string,
    overrides: Partial<SymptomRecord> = {}
  ): SymptomRecord {
    return {
      id,
      localDate,
      nasalCongestion: 1,
      nasalItching: 1,
      sneezing: 1,
      runnyNose: 1,
      tnssTotal: 4,
      notes: "夜间鼻塞明显",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides
    };
  }

  function exposureRecord(
    id: string,
    localDate: string,
    overrides: Partial<ExposureRecord> = {}
  ): ExposureRecord {
    return {
      id,
      localDate,
      factors: ["dust_mite", "pollen"],
      otherDescription: "装修气味",
      notes: "暴露备注",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides
    };
  }

  function medicationRecord(
    id: string,
    localDate: string,
    overrides: Partial<MedicationRecord> = {}
  ): MedicationRecord {
    return {
      id,
      localDate,
      medicationName: "氯雷他定",
      dosage: "10mg",
      actualUse: "每晚一次",
      notes: "用药备注",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides
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

  async function versionsOf(
    recordType: string,
    recordId: string
  ): Promise<VersionRow[]> {
    const { rows } = await database.query<VersionRow>(
      `SELECT record_type, record_id, revision, operation,
              encrypted_snapshot, encryption_key_version,
              actor_kind, actor_id, request_id
       FROM patient_record_versions
       WHERE record_type = $1 AND record_id = $2
       ORDER BY revision ASC`,
      [recordType, recordId]
    );
    return rows;
  }

  function snapshotOf<T>(row: VersionRow): T {
    const plaintext = decryptStoredField(
      encryption,
      row.encrypted_snapshot,
      row.encryption_key_version,
      "版本快照"
    );
    assert.notEqual(plaintext, null);
    return JSON.parse(plaintext as string) as T;
  }

  test("症状记录：创建/读取/列表往返，患者隔离", async () => {
    const patientA = "c-iso-a";
    const patientB = "c-iso-b";
    await insertPatient(patientA);
    await insertPatient(patientB);

    const record = symptomRecord("c-iso-s2", "2026-07-02");
    const created = await repository.createSymptom({
      patientId: patientA,
      idempotencyKey: "c-iso-s2",
      requestHash: "hash-iso-s2",
      record,
      requestId: "req-c-iso-s2"
    });
    assert.equal(created.kind, "created");
    if (created.kind === "created") {
      assert.equal(created.record.id, record.id);
      assert.equal(created.record.notes, "夜间鼻塞明显");
      assert.equal(created.record.revision, 1);
    }
    const earlier = symptomRecord("c-iso-s1", "2026-07-01");
    await repository.createSymptom({
      patientId: patientA,
      idempotencyKey: "c-iso-s1",
      requestHash: "hash-iso-s1",
      record: earlier,
      requestId: "req-c-iso-s1"
    });

    const found = await repository.findSymptom(patientA, record.id);
    assert.notEqual(found, null);
    assert.equal(found?.tnssTotal, 4);
    assert.equal(found?.notes, "夜间鼻塞明显");
    assert.equal(typeof found?.revision, "number");

    // 列表按 local_date DESC, created_at DESC
    const listed = await repository.listSymptoms(patientA);
    assert.deepEqual(
      listed.map((item) => item.id),
      ["c-iso-s2", "c-iso-s1"]
    );

    // 患者隔离：其他患者读不到、列表为空
    assert.equal(await repository.findSymptom(patientB, record.id), null);
    assert.deepEqual(await repository.listSymptoms(patientB), []);

    // 密文落库：库内不出现明文备注
    const { rows } = await database.query<{
      notes_encrypted: string;
      encryption_key_version: string;
    }>(
      `SELECT notes_encrypted, encryption_key_version
       FROM symptom_records WHERE id = $1`,
      [record.id]
    );
    assert.ok(!rows[0]!.notes_encrypted.includes("夜间鼻塞明显"));
    assert.equal(rows[0]!.encryption_key_version, "plaintext-dev");
  });

  test("症状幂等：同键同 hash 重放返回原记录且不追加版本；异 hash 冲突", async () => {
    const patientId = "c-idem";
    await insertPatient(patientId);

    const original = symptomRecord("c-idem-s1", "2026-07-01");
    const created = await repository.createSymptom({
      patientId,
      idempotencyKey: "c-idem-key",
      requestHash: "hash-a",
      record: original,
      requestId: "req-c-idem-1"
    });
    assert.equal(created.kind, "created");

    // 重放：请求携带新生成的记录（新 id），同键同 hash → 返回存储的原结果
    const replayed = await repository.createSymptom({
      patientId,
      idempotencyKey: "c-idem-key",
      requestHash: "hash-a",
      record: symptomRecord("c-idem-s2", "2026-07-02"),
      requestId: "req-c-idem-2"
    });
    assert.equal(replayed.kind, "replayed");
    if (replayed.kind === "replayed") {
      assert.equal(replayed.record.id, original.id);
    }

    // 重放不追加版本凭证
    assert.equal((await versionsOf("symptom", original.id)).length, 1);
    // 重放请求携带的新记录不得落库
    assert.equal(await repository.findSymptom(patientId, "c-idem-s2"), null);

    // 同键异 hash → idempotency_conflict
    const conflict = await repository.createSymptom({
      patientId,
      idempotencyKey: "c-idem-key",
      requestHash: "hash-b",
      record: symptomRecord("c-idem-s3", "2026-07-03"),
      requestId: "req-c-idem-3"
    });
    assert.equal(conflict.kind, "idempotency_conflict");
  });

  test("症状同日唯一：date_conflict；软删除后同日可重建，原键 stale_replay", async () => {
    const patientId = "c-soft";
    await insertPatient(patientId);

    const first = symptomRecord("c-soft-s1", "2026-07-10");
    await repository.createSymptom({
      patientId,
      idempotencyKey: "c-soft-k1",
      requestHash: "hash-soft-1",
      record: first,
      requestId: "req-c-soft-1"
    });

    // 同日第二条（不同幂等键）→ 部分唯一索引触发 date_conflict
    const dateConflict = await repository.createSymptom({
      patientId,
      idempotencyKey: "c-soft-k2",
      requestHash: "hash-soft-2",
      record: symptomRecord("c-soft-s2", "2026-07-10"),
      requestId: "req-c-soft-2"
    });
    assert.equal(dateConflict.kind, "date_conflict");

    // 软删除后同日可重建（部分唯一索引 WHERE deleted_at IS NULL）
    const deleted = await repository.deleteSymptom(
      patientId,
      first.id,
      1,
      "req-c-soft-del"
    );
    assert.equal(deleted.kind, "deleted");
    assert.deepEqual(await repository.listSymptoms(patientId), []);

    const rebuilt = await repository.createSymptom({
      patientId,
      idempotencyKey: "c-soft-k3",
      requestHash: "hash-soft-3",
      record: symptomRecord("c-soft-s3", "2026-07-10"),
      requestId: "req-c-soft-3"
    });
    assert.equal(rebuilt.kind, "created");

    // 原幂等键重放：记录已删 → stale_replay，不返回幻影记录
    const stale = await repository.createSymptom({
      patientId,
      idempotencyKey: "c-soft-k1",
      requestHash: "hash-soft-1",
      record: symptomRecord("c-soft-s4", "2026-07-11"),
      requestId: "req-c-soft-4"
    });
    assert.equal(stale.kind, "stale_replay");
  });

  test("症状 CAS：expectedRevision 不匹配返回 version_conflict 与当前 revision", async () => {
    const patientId = "c-cas";
    await insertPatient(patientId);

    const record = symptomRecord("c-cas-s1", "2026-07-01");
    await repository.createSymptom({
      patientId,
      idempotencyKey: "c-cas-k1",
      requestHash: "hash-cas-1",
      record,
      requestId: "req-c-cas-1"
    });

    // 过期 revision → version_conflict，回传当前 revision
    const conflict = await repository.updateSymptom({
      patientId,
      id: record.id,
      expectedRevision: 9,
      nasalCongestion: 2,
      nasalItching: 2,
      sneezing: 2,
      runnyNose: 2,
      tnssTotal: 8,
      notes: "更新备注",
      updatedAt: "2026-07-02T08:00:00.000Z",
      requestId: "req-c-cas-2"
    });
    assert.deepEqual(conflict, { kind: "version_conflict", currentRevision: 1 });

    // 正确 revision → updated，revision 递增
    const updated = await repository.updateSymptom({
      patientId,
      id: record.id,
      expectedRevision: 1,
      nasalCongestion: 2,
      nasalItching: 2,
      sneezing: 2,
      runnyNose: 2,
      tnssTotal: 8,
      notes: "更新备注",
      updatedAt: "2026-07-02T08:00:00.000Z",
      requestId: "req-c-cas-3"
    });
    assert.equal(updated.kind, "updated");
    if (updated.kind === "updated") {
      assert.equal(updated.record.revision, 2);
      assert.equal(updated.record.tnssTotal, 8);
      assert.equal(updated.record.notes, "更新备注");
    }

    // 不存在 id 与其他患者 → not_found
    const missing = await repository.updateSymptom({
      patientId,
      id: "c-cas-missing",
      expectedRevision: 1,
      nasalCongestion: 1,
      nasalItching: 1,
      sneezing: 1,
      runnyNose: 1,
      tnssTotal: 4,
      notes: null,
      updatedAt: NOW,
      requestId: "req-c-cas-4"
    });
    assert.equal(missing.kind, "not_found");
    const missingDelete = await repository.deleteSymptom(
      patientId,
      "c-cas-missing",
      1,
      "req-c-cas-5"
    );
    assert.equal(missingDelete.kind, "not_found");

    // 删除 CAS：错误 revision → version_conflict；正确 → deleted；再删 → not_found
    const deleteConflict = await repository.deleteSymptom(
      patientId,
      record.id,
      1,
      "req-c-cas-6"
    );
    assert.deepEqual(deleteConflict, {
      kind: "version_conflict",
      currentRevision: 2
    });
    const deleted = await repository.deleteSymptom(
      patientId,
      record.id,
      2,
      "req-c-cas-7"
    );
    assert.equal(deleted.kind, "deleted");
    const deletedAgain = await repository.deleteSymptom(
      patientId,
      record.id,
      3,
      "req-c-cas-8"
    );
    assert.equal(deletedAgain.kind, "not_found");
  });

  test("版本凭证：create/update/delete 各追加一条，快照为加密的完整记录", async () => {
    const patientId = "c-ledger";
    await insertPatient(patientId);

    const record = symptomRecord("c-ledger-s1", "2026-05-10");
    await repository.createSymptom({
      patientId,
      idempotencyKey: "c-ledger-k1",
      requestHash: "hash-ledger-1",
      record,
      requestId: "req-c-ledger-create"
    });
    await repository.updateSymptom({
      patientId,
      id: record.id,
      expectedRevision: 1,
      nasalCongestion: 1,
      nasalItching: 1,
      sneezing: 1,
      runnyNose: 1,
      tnssTotal: 4,
      notes: "二版备注",
      updatedAt: "2026-05-11T08:00:00.000Z",
      requestId: "req-c-ledger-update"
    });
    await repository.deleteSymptom(
      patientId,
      record.id,
      2,
      "req-c-ledger-delete"
    );

    const rows = await versionsOf("symptom", record.id);
    assert.equal(rows.length, 3);
    const [createRow, updateRow, deleteRow] = rows as [
      VersionRow,
      VersionRow,
      VersionRow
    ];

    assert.equal(createRow.revision, 1);
    assert.equal(typeof createRow.revision, "number"); // int4 → number
    assert.equal(createRow.operation, "create");
    assert.equal(createRow.actor_kind, "patient");
    assert.equal(createRow.actor_id, patientId);
    assert.equal(createRow.request_id, "req-c-ledger-create");
    assert.equal(snapshotOf<SymptomRecord>(createRow).notes, "夜间鼻塞明显");

    assert.equal(updateRow.revision, 2);
    assert.equal(updateRow.operation, "update");
    assert.equal(updateRow.request_id, "req-c-ledger-update");
    assert.equal(snapshotOf<SymptomRecord>(updateRow).notes, "二版备注");

    // 删除凭证 revision 取被删 revision + 1，快照为删除时的记录内容
    assert.equal(deleteRow.revision, 3);
    assert.equal(deleteRow.operation, "delete");
    assert.equal(deleteRow.request_id, "req-c-ledger-delete");
    assert.equal(snapshotOf<SymptomRecord>(deleteRow).notes, "二版备注");

    // 库内快照为密文，不出现明文
    assert.ok(!createRow.encrypted_snapshot.includes("夜间鼻塞明显"));
  });

  test("档案：未建档语义、创建/更新 CAS 与版本凭证", async () => {
    const patientId = "c-profile";
    await insertPatient(patientId);

    assert.equal(await repository.getProfile(patientId), null);

    // 未建档但 expectedRevision 非 0 → version_conflict(0)
    const premature = await repository.updateProfile({
      patientId,
      expectedRevision: 3,
      displayName: "小王",
      birthDate: "1990-01-01",
      sex: "female",
      allergyHistory: "尘螨过敏",
      knownAllergies: "尘螨",
      commonTriggers: "花粉",
      notes: "档案备注",
      updatedAt: NOW,
      requestId: "req-c-profile-0"
    });
    assert.deepEqual(premature, { kind: "version_conflict", currentRevision: 0 });

    // expectedRevision 0 → 建档 created，revision 1
    const created = await repository.updateProfile({
      patientId,
      expectedRevision: 0,
      displayName: "小王",
      birthDate: "1990-01-01",
      sex: "female",
      allergyHistory: "尘螨过敏",
      knownAllergies: "尘螨",
      commonTriggers: "花粉",
      notes: "档案备注",
      updatedAt: NOW,
      requestId: "req-c-profile-1"
    });
    assert.equal(created.kind, "created");
    if (created.kind === "created") {
      assert.equal(created.record.revision, 1);
      assert.equal(created.record.displayName, "小王");
      assert.equal(created.record.birthDate, "1990-01-01"); // 明文列
      assert.equal(created.record.allergyHistory, "尘螨过敏");
    }

    const shown = await repository.getProfile(patientId);
    assert.equal(shown?.displayName, "小王");

    // CAS：错误 revision → version_conflict 回传当前 revision
    const conflict = await repository.updateProfile({
      patientId,
      expectedRevision: 5,
      displayName: "小李",
      birthDate: null,
      sex: "unspecified",
      allergyHistory: null,
      knownAllergies: null,
      commonTriggers: null,
      notes: null,
      updatedAt: NOW,
      requestId: "req-c-profile-2"
    });
    assert.deepEqual(conflict, { kind: "version_conflict", currentRevision: 1 });

    const updated = await repository.updateProfile({
      patientId,
      expectedRevision: 1,
      displayName: "小李",
      birthDate: null,
      sex: "male",
      allergyHistory: null,
      knownAllergies: null,
      commonTriggers: null,
      notes: null,
      updatedAt: "2026-07-02T08:00:00.000Z",
      requestId: "req-c-profile-3"
    });
    assert.equal(updated.kind, "updated");
    if (updated.kind === "updated") {
      assert.equal(updated.record.revision, 2);
      assert.equal(updated.record.displayName, "小李");
      assert.equal(updated.record.allergyHistory, null); // 显式清空
    }

    const rows = await versionsOf("profile", patientId);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => [row.revision, row.operation]),
      [
        [1, "create"],
        [2, "update"]
      ]
    );
    assert.equal(rows[1]!.request_id, "req-c-profile-3");
  });

  test("暴露记录：factors 往返、同日唯一 date_conflict、更新/删除", async () => {
    const patientId = "c-exposure";
    await insertPatient(patientId);

    const record = exposureRecord("c-exp-e1", "2026-07-02");
    const created = await repository.createExposure({
      patientId,
      idempotencyKey: "c-exp-k1",
      requestHash: "hash-exp-1",
      record,
      requestId: "req-c-exp-1"
    });
    assert.equal(created.kind, "created");

    const found = await repository.findExposure(patientId, record.id);
    assert.deepEqual(found?.factors, ["dust_mite", "pollen"]);
    assert.equal(found?.otherDescription, "装修气味");
    assert.equal(found?.notes, "暴露备注");

    // 同日第二条 → date_conflict
    const dateConflict = await repository.createExposure({
      patientId,
      idempotencyKey: "c-exp-k2",
      requestHash: "hash-exp-2",
      record: exposureRecord("c-exp-e2", "2026-07-02"),
      requestId: "req-c-exp-2"
    });
    assert.equal(dateConflict.kind, "date_conflict");

    const conflict = await repository.updateExposure({
      patientId,
      id: record.id,
      expectedRevision: 3,
      factors: ["pollen"],
      otherDescription: null,
      notes: null,
      updatedAt: NOW,
      requestId: "req-c-exp-3"
    });
    assert.deepEqual(conflict, { kind: "version_conflict", currentRevision: 1 });

    const updated = await repository.updateExposure({
      patientId,
      id: record.id,
      expectedRevision: 1,
      factors: ["pollen"],
      otherDescription: null,
      notes: null,
      updatedAt: "2026-07-03T08:00:00.000Z",
      requestId: "req-c-exp-4"
    });
    assert.equal(updated.kind, "updated");
    if (updated.kind === "updated") {
      assert.equal(updated.record.revision, 2);
      assert.deepEqual(updated.record.factors, ["pollen"]);
      assert.equal(updated.record.otherDescription, null);
    }

    const deleted = await repository.deleteExposure(
      patientId,
      record.id,
      2,
      "req-c-exp-5"
    );
    assert.equal(deleted.kind, "deleted");
    assert.deepEqual(await repository.listExposures(patientId), []);
    assert.deepEqual(
      (await versionsOf("exposure", record.id)).map((row) => row.operation),
      ["create", "update", "delete"]
    );
  });

  test("用药记录：无同日唯一约束同日可多条，加密字段往返，CAS", async () => {
    const patientId = "c-medication";
    await insertPatient(patientId);

    // 用药表无日期唯一约束：同日两条（不同幂等键）均 created
    const first = medicationRecord("c-med-m1", "2026-07-03");
    const second = medicationRecord("c-med-m2", "2026-07-03", {
      medicationName: "鼻喷剂",
      dosage: null,
      actualUse: null,
      notes: null
    });
    const createdFirst = await repository.createMedication({
      patientId,
      idempotencyKey: "c-med-k1",
      requestHash: "hash-med-1",
      record: first,
      requestId: "req-c-med-1"
    });
    const createdSecond = await repository.createMedication({
      patientId,
      idempotencyKey: "c-med-k2",
      requestHash: "hash-med-2",
      record: second,
      requestId: "req-c-med-2"
    });
    assert.equal(createdFirst.kind, "created");
    assert.equal(createdSecond.kind, "created");

    const found = await repository.findMedication(patientId, first.id);
    assert.equal(found?.medicationName, "氯雷他定");
    assert.equal(found?.dosage, "10mg");
    const foundSecond = await repository.findMedication(patientId, second.id);
    assert.equal(foundSecond?.dosage, null);

    // 库内不出现明文药品名
    const { rows } = await database.query<{
      medication_name_encrypted: string;
    }>(
      `SELECT medication_name_encrypted
       FROM medication_records WHERE id = $1`,
      [first.id]
    );
    assert.ok(!rows[0]!.medication_name_encrypted.includes("氯雷他定"));

    const conflict = await repository.updateMedication({
      patientId,
      id: first.id,
      expectedRevision: 2,
      medicationName: "孟鲁司特",
      dosage: null,
      actualUse: null,
      notes: null,
      updatedAt: NOW,
      requestId: "req-c-med-3"
    });
    assert.deepEqual(conflict, { kind: "version_conflict", currentRevision: 1 });

    const updated = await repository.updateMedication({
      patientId,
      id: first.id,
      expectedRevision: 1,
      medicationName: "孟鲁司特",
      dosage: "4mg",
      actualUse: "睡前",
      notes: null,
      updatedAt: "2026-07-04T08:00:00.000Z",
      requestId: "req-c-med-4"
    });
    assert.equal(updated.kind, "updated");
    if (updated.kind === "updated") {
      assert.equal(updated.record.medicationName, "孟鲁司特");
      assert.equal(updated.record.revision, 2);
    }

    const deleted = await repository.deleteMedication(
      patientId,
      first.id,
      2,
      "req-c-med-5"
    );
    assert.equal(deleted.kind, "deleted");
    const listed = await repository.listMedications(patientId);
    assert.deepEqual(
      listed.map((item) => item.id),
      [second.id]
    );
  });

  test("并发约束：同键并发创建只有一个 created，另一路重放或可重试", async () => {
    const patientId = "c-race";
    await insertPatient(patientId);

    // 同幂等键、同 hash、不同记录（不同日期避开同日唯一约束）：
    // 先到者 created；后到者要么读到已提交的幂等行走 replayed，
    // 要么在幂等行插入处撞唯一冲突，映射为可重试 storage_unavailable。
    const outcomes = await Promise.allSettled([
      repository.createSymptom({
        patientId,
        idempotencyKey: "c-race-key",
        requestHash: "hash-race",
        record: symptomRecord("c-race-s1", "2026-07-01"),
        requestId: "req-c-race-1"
      }),
      repository.createSymptom({
        patientId,
        idempotencyKey: "c-race-key",
        requestHash: "hash-race",
        record: symptomRecord("c-race-s2", "2026-07-02"),
        requestId: "req-c-race-2"
      })
    ]);

    let createdCount = 0;
    let replayedCount = 0;
    let retryableCount = 0;
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        if (outcome.value.kind === "created") {
          createdCount += 1;
        } else if (outcome.value.kind === "replayed") {
          replayedCount += 1;
        } else {
          assert.fail(`意外结果：${outcome.value.kind}`);
        }
      } else {
        const reason = outcome.reason as unknown;
        assert.ok(reason instanceof DomainError);
        assert.equal(reason.code, "storage_unavailable");
        assert.equal(reason.retryable, true);
        retryableCount += 1;
      }
    }
    assert.equal(createdCount, 1);
    assert.equal(replayedCount + retryableCount, 1);

    // 无论竞态结果如何，最终一致：失败方事务整体回滚或走重放未落库，
    // 业务表只有先到者一条记录，幂等表只有一行。
    const { rows } = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM symptom_records
       WHERE patient_id = $1 AND deleted_at IS NULL`,
      [patientId]
    );
    assert.equal(rows[0]!.count, 1);
  });

  test("概览/月度/趋势聚合：去重、排序、软删除排除、月份前缀与区间过滤", async () => {
    const patientId = "c-agg";
    await insertPatient(patientId);

    const addSymptom = async (
      id: string,
      localDate: string,
      tnssTotal: number
    ): Promise<void> => {
      await repository.createSymptom({
        patientId,
        idempotencyKey: `key-${id}`,
        requestHash: `hash-${id}`,
        record: symptomRecord(id, localDate, { tnssTotal }),
        requestId: `req-${id}`
      });
    };
    await addSymptom("c-agg-s1", "2026-07-01", 4);
    await addSymptom("c-agg-s2", "2026-07-03", 6);
    await addSymptom("c-agg-s3", "2026-06-15", 2);
    await addSymptom("c-agg-s4", "2026-07-05", 8);
    // 软删除的记录必须从所有聚合中消失
    await repository.deleteSymptom(patientId, "c-agg-s4", 1, "req-c-agg-del");

    await repository.createExposure({
      patientId,
      idempotencyKey: "c-agg-e1",
      requestHash: "hash-c-agg-e1",
      record: exposureRecord("c-agg-e1", "2026-07-02"),
      requestId: "req-c-agg-e1"
    });
    await repository.createExposure({
      patientId,
      idempotencyKey: "c-agg-e2",
      requestHash: "hash-c-agg-e2",
      record: exposureRecord("c-agg-e2", "2026-08-01"),
      requestId: "req-c-agg-e2"
    });
    // 用药无同日唯一约束：同日两条验证 DISTINCT 去重
    await repository.createMedication({
      patientId,
      idempotencyKey: "c-agg-m1",
      requestHash: "hash-c-agg-m1",
      record: medicationRecord("c-agg-m1", "2026-07-03"),
      requestId: "req-c-agg-m1"
    });
    await repository.createMedication({
      patientId,
      idempotencyKey: "c-agg-m2",
      requestHash: "hash-c-agg-m2",
      record: medicationRecord("c-agg-m2", "2026-07-03"),
      requestId: "req-c-agg-m2"
    });

    const overview = await repository.readOverview(patientId, "2026-07");
    // 去重后按日期倒序，排除已删 07-05
    assert.deepEqual(overview.symptomDates, [
      "2026-07-03",
      "2026-07-01",
      "2026-06-15"
    ]);
    assert.equal(overview.monthRecordCount, 2);
    assert.equal(typeof overview.monthRecordCount, "number"); // COUNT 强转 int
    assert.equal(overview.lastTnss, 6); // 最新未删症状 07-03
    assert.equal(overview.latestExposureDate, "2026-08-01");
    assert.equal(overview.latestMedicationDate, "2026-07-03");

    const month = await repository.readMonth(patientId, "2026-07");
    assert.deepEqual(
      month.symptoms.map((item) => [item.localDate, item.tnssTotal]),
      [
        ["2026-07-01", 4],
        ["2026-07-03", 6]
      ]
    );
    assert.deepEqual(month.exposureDates, ["2026-07-02"]);
    assert.deepEqual(month.medicationDates, ["2026-07-03"]); // DISTINCT

    const trend = await repository.readTrend(
      patientId,
      "2026-06-01",
      "2026-07-31"
    );
    assert.deepEqual(
      trend.items.map((item) => [item.localDate, item.tnssTotal]),
      [
        ["2026-06-15", 2],
        ["2026-07-01", 4],
        ["2026-07-03", 6]
      ]
    );
    // 区间端点闭包含
    const singleDay = await repository.readTrend(
      patientId,
      "2026-07-01",
      "2026-07-01"
    );
    assert.equal(singleDay.items.length, 1);
  });

  test("空数据概览：计数为 number 0，投影字段为 null", async () => {
    const patientId = "c-empty";
    await insertPatient(patientId);

    const overview = await repository.readOverview(patientId, "2026-07");
    assert.deepEqual(overview.symptomDates, []);
    assert.equal(overview.monthRecordCount, 0);
    assert.equal(typeof overview.monthRecordCount, "number");
    assert.equal(overview.lastTnss, null);
    assert.equal(overview.latestExposureDate, null);
    assert.equal(overview.latestMedicationDate, null);

    const month = await repository.readMonth(patientId, "2026-07");
    assert.deepEqual(month.symptoms, []);
    assert.deepEqual(month.exposureDates, []);
    assert.deepEqual(month.medicationDates, []);

    const trend = await repository.readTrend(
      patientId,
      "2026-07-01",
      "2026-07-31"
    );
    assert.deepEqual(trend.items, []);
  });
}
