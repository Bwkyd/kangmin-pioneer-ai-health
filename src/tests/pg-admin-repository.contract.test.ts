import assert from "node:assert/strict";
import test, { before, beforeEach, after } from "node:test";

import { PgAdminAccountRepository } from "../infrastructure/postgres/pg-admin-account-repository.js";
import { PgAdminSessionRepository } from "../infrastructure/postgres/pg-admin-session-repository.js";
import { PgAuditRepository } from "../infrastructure/postgres/pg-audit-repository.js";
import { KangminPgDatabase } from "../infrastructure/postgres/pg-database.js";
import { PgUserAdminRepository } from "../infrastructure/postgres/pg-user-admin-repository.js";
import {
  createPgTestDatabase,
  type PgTestDatabase
} from "./pg-test-database.js";

const connectionUrl = process.env.KANGMIN_TEST_DATABASE_URL;

if (connectionUrl === undefined) {
  test("pg-admin-repository 契约测试", {
    skip: "未配置 KANGMIN_TEST_DATABASE_URL"
  }, () => {});
} else {
  let testDatabase: PgTestDatabase;
  let database: KangminPgDatabase;
  let accounts: PgAdminAccountRepository;
  let sessions: PgAdminSessionRepository;
  let users: PgUserAdminRepository;
  let audit: PgAuditRepository;

  before(async () => {
    const created = await createPgTestDatabase("pg_admin");
    assert.ok(created !== null);
    testDatabase = created;
    database = new KangminPgDatabase(testDatabase.url);
    await database.ready;
    accounts = new PgAdminAccountRepository(database);
    sessions = new PgAdminSessionRepository(database);
    users = new PgUserAdminRepository(database);
    audit = new PgAuditRepository(database);
  });

  const now = () => new Date().toISOString();

  /** 每个用例前清空相关业务表（CASCADE 处理外键依赖）。 */
  async function clean(): Promise<void> {
    await database.ready;
    await database.query(`
      TRUNCATE admin_sessions, admin_idempotency, admin_accounts,
               audit_events, patient_sessions, patient_accounts,
               symptom_records, exposure_records, medication_records,
               content_items, patients CASCADE
    `);
  }

  beforeEach(clean);
  after(async () => {
    await database.close();
    await testDatabase.close();
  });

  async function insertPatient(id: string, createdAt: string): Promise<void> {
    await database.query(
      "INSERT INTO patients(id, development_subject, created_at) VALUES ($1, $2, $3)",
      [id, `${id}@dev.local`, createdAt]
    );
  }

  async function insertPatientSession(
    tokenHash: string,
    patientId: string,
    createdAt: string,
    revokedAt: string | null = null
  ): Promise<void> {
    await database.query(
      `INSERT INTO patient_sessions(
        token_hash, patient_id, expires_at, created_at, revoked_at
      ) VALUES ($1, $2, $3, $4, $5)`,
      [tokenHash, patientId, "2999-01-01T00:00:00.000Z", createdAt, revokedAt]
    );
  }

  async function insertSymptom(
    id: string,
    patientId: string,
    localDate: string
  ): Promise<void> {
    const at = now();
    await database.query(
      `INSERT INTO symptom_records(
        id, patient_id, local_date, nasal_congestion, nasal_itching,
        sneezing, runny_nose, tnss_total, revision, created_at, updated_at
      ) VALUES ($1, $2, $3, 1, 2, 3, 0, 6, 1, $4, $4)`,
      [id, patientId, localDate, at]
    );
  }

  async function insertExposure(
    id: string,
    patientId: string,
    localDate: string
  ): Promise<void> {
    const at = now();
    await database.query(
      `INSERT INTO exposure_records(
        id, patient_id, local_date, factors_json, revision, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 1, $5, $5)`,
      [id, patientId, localDate, '["pollen"]', at]
    );
  }

  async function insertMedication(
    id: string,
    patientId: string,
    localDate: string
  ): Promise<void> {
    const at = now();
    await database.query(
      `INSERT INTO medication_records(
        id, patient_id, local_date, medication_name_encrypted,
        revision, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 1, $5, $5)`,
      [id, patientId, localDate, "cipher:text", at]
    );
  }

  // ---------- AdminAccountRepository ----------

  test("create/find/list/count 主路径与 username 唯一约束", async () => {
    const at = now();
    const first = await accounts.create({
      id: "a-1",
      username: "owner1",
      passwordHash: "hash-1",
      role: "owner",
      createdAt: at,
      updatedAt: at
    });
    assert.deepEqual(first, { kind: "created" });
    await accounts.create({
      id: "a-2",
      username: "admin1",
      passwordHash: "hash-2",
      role: "admin",
      createdAt: at,
      updatedAt: at
    });

    assert.equal(await accounts.countAll(), 2);
    assert.equal(await accounts.countActiveOwners(), 1);

    const byId = await accounts.findById("a-1");
    assert.equal(byId?.username, "owner1");
    assert.equal(byId?.revision, 1);
    assert.equal(byId?.status, "active");
    assert.equal(typeof byId?.revision, "number");

    const byName = await accounts.findByUsername("admin1");
    assert.equal(byName?.id, "a-2");
    assert.equal(await accounts.findByUsername("nobody"), null);
    assert.equal(await accounts.findById("nobody"), null);

    const listed = await accounts.list();
    assert.deepEqual(listed.map((row) => row.id), ["a-1", "a-2"]);

    // 唯一约束冲突映射为 username_taken，与 SQLite 的 UNIQUE 分支等价
    const dup = await accounts.create({
      id: "a-3",
      username: "owner1",
      passwordHash: "hash-3",
      role: "admin",
      createdAt: at,
      updatedAt: at
    });
    assert.deepEqual(dup, { kind: "username_taken" });
    assert.equal(await accounts.countAll(), 2);
  });

  test("createFirstOwner：空表引导成功，非空表返回 owner_exists", async () => {
    const at = now();
    const first = await accounts.createFirstOwner({
      id: "boot-1",
      username: "boot",
      passwordHash: "hash",
      createdAt: at,
      updatedAt: at
    });
    assert.equal(first, "created");
    assert.equal(await accounts.countAll(), 1);
    const owner = await accounts.findById("boot-1");
    assert.equal(owner?.role, "owner");

    const second = await accounts.createFirstOwner({
      id: "boot-2",
      username: "boot2",
      passwordHash: "hash",
      createdAt: at,
      updatedAt: at
    });
    assert.equal(second, "owner_exists");
    assert.equal(await accounts.countAll(), 1);
  });

  test("createFirstOwner 并发引导只有一个成功（写序列化关闭竞态窗口）", async () => {
    const at = now();
    const make = (suffix: string) => ({
      id: `race-${suffix}`,
      username: `race-${suffix}`,
      passwordHash: "hash",
      createdAt: at,
      updatedAt: at
    });
    const results = await Promise.all([
      accounts.createFirstOwner(make("a")),
      accounts.createFirstOwner(make("b")),
      accounts.createFirstOwner(make("c"))
    ]);
    assert.deepEqual(
      [...results].sort(),
      ["created", "owner_exists", "owner_exists"]
    );
    assert.equal(await accounts.countAll(), 1);
  });

  test("updateStatus：存在则 revision+1，不存在返回 not_found", async () => {
    const at = now();
    await accounts.create({
      id: "a-1",
      username: "owner1",
      passwordHash: "hash",
      role: "owner",
      createdAt: at,
      updatedAt: at
    });
    assert.equal(await accounts.updateStatus("missing", "disabled", now()), "not_found");
    assert.equal(await accounts.updateStatus("a-1", "disabled", now()), "updated");
    const row = await accounts.findById("a-1");
    assert.equal(row?.status, "disabled");
    assert.equal(row?.revision, 2);
  });

  test("disableAndRevokeSessions：同事务停用并只撤销未撤销会话", async () => {
    const at = now();
    await accounts.create({
      id: "a-1",
      username: "admin1",
      passwordHash: "hash",
      role: "admin",
      createdAt: at,
      updatedAt: at
    });
    await sessions.createSession({
      adminId: "a-1", tokenHash: "t-1", expiresAt: "2999-01-01T00:00:00.000Z", createdAt: at
    });
    await sessions.createSession({
      adminId: "a-1", tokenHash: "t-2", expiresAt: "2999-01-01T00:00:00.000Z", createdAt: at
    });
    // t-2 已带撤销标记与原因，停用不应覆盖原有原因
    await sessions.revoke("t-2", at, "logout");

    assert.equal(await accounts.disableAndRevokeSessions("missing", now(), "r"), "not_found");
    assert.equal(await accounts.disableAndRevokeSessions("a-1", now(), "disabled-by-owner"), "updated");

    assert.equal(await sessions.find("t-1"), null);
    const stored = await database.query<{
      token_hash: string;
      revoked_reason: string | null;
    }>("SELECT token_hash, revoked_reason FROM admin_sessions ORDER BY token_hash");
    assert.deepEqual(stored.rows, [
      { token_hash: "t-1", revoked_reason: "disabled-by-owner" },
      { token_hash: "t-2", revoked_reason: "logout" }
    ]);
    // 已停用账号再走 active 谓词的 UPDATE → not_found
    assert.equal(await accounts.disableAndRevokeSessions("a-1", now(), "again"), "not_found");
  });

  test("disableAdminIfNotLastOwner：最后一个 owner 拒绝、双 owner 可停用", async () => {
    const at = now();
    await accounts.create({
      id: "o-1", username: "owner1", passwordHash: "h", role: "owner",
      createdAt: at, updatedAt: at
    });
    // 唯一活跃 owner → last_owner
    assert.equal(
      await accounts.disableAdminIfNotLastOwner("o-1", now(), "r"),
      "last_owner"
    );
    assert.equal((await accounts.findById("o-1"))?.status, "active");

    await accounts.create({
      id: "o-2", username: "owner2", passwordHash: "h", role: "owner",
      createdAt: at, updatedAt: at
    });
    assert.equal(
      await accounts.disableAdminIfNotLastOwner("o-1", now(), "r"),
      "updated"
    );
    // 已停用 → not_found
    assert.equal(
      await accounts.disableAdminIfNotLastOwner("o-1", now(), "r"),
      "not_found"
    );
    assert.equal(
      await accounts.disableAdminIfNotLastOwner("missing", now(), "r"),
      "not_found"
    );
    // 普通 admin 不受 last-owner 守卫限制
    await accounts.create({
      id: "a-1", username: "admin1", passwordHash: "h", role: "admin",
      createdAt: at, updatedAt: at
    });
    assert.equal(
      await accounts.disableAdminIfNotLastOwner("a-1", now(), "r"),
      "updated"
    );
  });

  test("disableAdminIfNotLastOwner 并发双停最后两个 owner 只有一个成功", async () => {
    const at = now();
    await accounts.create({
      id: "o-1", username: "owner1", passwordHash: "h", role: "owner",
      createdAt: at, updatedAt: at
    });
    await accounts.create({
      id: "o-2", username: "owner2", passwordHash: "h", role: "owner",
      createdAt: at, updatedAt: at
    });
    const results = await Promise.all([
      accounts.disableAdminIfNotLastOwner("o-1", now(), "r"),
      accounts.disableAdminIfNotLastOwner("o-2", now(), "r")
    ]);
    assert.deepEqual([...results].sort(), ["last_owner", "updated"]);
    assert.equal(await accounts.countActiveOwners(), 1);
  });

  // ---------- AdminSessionRepository ----------

  test("save：dev 会话写 admin_accounts 占位行，重复 subject 复用账号", async () => {
    const at = now();
    const first = await sessions.save({
      subject: "dev@local", newAdminId: "dev-1", tokenHash: "tok-1",
      expiresAt: "2999-01-01T00:00:00.000Z", createdAt: at
    });
    assert.equal(first, "dev-1");
    const placeholder = await accounts.findByUsername("dev@local");
    assert.equal(placeholder?.passwordHash, "!dev-session-only");
    assert.equal(placeholder?.role, "owner");

    // 同 subject 再存：复用既有账号 id，不新建占位行
    const second = await sessions.save({
      subject: "dev@local", newAdminId: "dev-2", tokenHash: "tok-2",
      expiresAt: "2999-01-01T00:00:00.000Z", createdAt: at
    });
    assert.equal(second, "dev-1");
    assert.equal(await accounts.countAll(), 1);
  });

  test("save：同 token 再存不复活已撤销会话（ON CONFLICT DO NOTHING）", async () => {
    const at = now();
    await sessions.save({
      subject: "dev@local", newAdminId: "dev-1", tokenHash: "tok-1",
      expiresAt: "2999-01-01T00:00:00.000Z", createdAt: at
    });
    await sessions.revoke("tok-1", now(), "logout");
    assert.equal(await sessions.find("tok-1"), null);

    // 撤销后同 token 再 save：保留原 revoked 行，不复活
    await sessions.save({
      subject: "dev@local", newAdminId: "dev-1", tokenHash: "tok-1",
      expiresAt: "2999-01-01T00:00:00.000Z", createdAt: at
    });
    assert.equal(await sessions.find("tok-1"), null);
    const stored = await database.query<{ revoked_reason: string | null }>(
      "SELECT revoked_reason FROM admin_sessions WHERE token_hash = $1",
      ["tok-1"]
    );
    assert.equal(stored.rows[0]?.revoked_reason, "logout");
  });

  test("find / findWithAccount：活跃过滤与账号状态投影", async () => {
    const at = now();
    await accounts.create({
      id: "a-1", username: "admin1", passwordHash: "h", role: "admin",
      createdAt: at, updatedAt: at
    });
    await sessions.createSession({
      adminId: "a-1", tokenHash: "tok-1",
      expiresAt: "2999-01-01T00:00:00.000Z", createdAt: at
    });

    const found = await sessions.find("tok-1");
    assert.deepEqual(found, { adminId: "a-1", expiresAt: "2999-01-01T00:00:00.000Z" });
    assert.equal(await sessions.find("missing"), null);

    // 停用账号后：find() 过滤活跃账号返回 null；findWithAccount 仍返回
    // status 供服务端二次校验（SQLite 版同样只在一个方法里过滤）
    await accounts.updateStatus("a-1", "disabled", now());
    assert.equal(await sessions.find("tok-1"), null);
    const withAccount = await sessions.findWithAccount("tok-1");
    assert.equal(withAccount?.status, "disabled");
    assert.equal(withAccount?.role, "admin");
    assert.equal(withAccount?.username, "admin1");

    // 已撤销会话两个方法都不可见
    await sessions.revoke("tok-1", now(), "logout");
    assert.equal(await sessions.findWithAccount("tok-1"), null);
  });

  test("revokeAllForAdmin：只撤销未撤销会话并返回数量", async () => {
    const at = now();
    await accounts.create({
      id: "a-1", username: "admin1", passwordHash: "h", role: "admin",
      createdAt: at, updatedAt: at
    });
    for (const token of ["t-1", "t-2", "t-3"]) {
      await sessions.createSession({
        adminId: "a-1", tokenHash: token,
        expiresAt: "2999-01-01T00:00:00.000Z", createdAt: at
      });
    }
    await sessions.revoke("t-3", at, "logout");

    const revoked = await sessions.revokeAllForAdmin("a-1", now(), "bulk");
    assert.equal(revoked, 2);
    assert.equal(typeof revoked, "number");
    // 再次调用：没有可撤销行 → 0
    assert.equal(await sessions.revokeAllForAdmin("a-1", now(), "bulk"), 0);
  });

  // ---------- UserReadRepository（只读投影 + 患者隔离） ----------

  test("listUsers：投影字段、无账号默认值、计数与排序", async () => {
    await insertPatient("p-1", "2026-01-01T00:00:00.000Z");
    await insertPatient("p-2", "2026-01-02T00:00:00.000Z");
    const at = now();
    await database.query(
      `INSERT INTO patient_accounts(
        patient_id, username_hash, password_hash, nickname, revision,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 1, $5, $5)`,
      ["p-1", "uh-1", "ph-1", "阿明", at]
    );
    await insertPatientSession("ps-1", "p-1", at);
    await insertPatientSession("ps-2", "p-1", at);
    await insertSymptom("sr-1", "p-1", "2026-01-03");
    await insertExposure("er-1", "p-1", "2026-01-03");
    await insertMedication("mr-1", "p-1", "2026-01-03");

    const rows = await users.listUsers(10);
    assert.equal(rows.length, 2);
    // created_at DESC：p-2 在前
    assert.deepEqual(rows.map((row) => row.id), ["p-2", "p-1"]);

    const p1 = rows[1];
    assert.equal(p1?.nickname, "阿明");
    assert.equal(p1?.accountStatus, "active");
    assert.equal(p1?.sessionCount, 2);
    assert.equal(p1?.recordCount, 3);
    assert.equal(typeof p1?.sessionCount, "number");
    assert.equal(typeof p1?.recordCount, "number");

    const p2 = rows[0];
    // 无本地账号 → no_local_account，计数为 0
    assert.equal(p2?.accountStatus, "no_local_account");
    assert.equal(p2?.nickname, null);
    assert.equal(p2?.sessionCount, 0);
    assert.equal(p2?.recordCount, 0);

    const limited = await users.listUsers(1);
    assert.equal(limited.length, 1);
    assert.equal(limited[0]?.id, "p-2");
  });

  test("listUsers：query 模糊匹配（大小写不敏感，对齐 SQLite LIKE）", async () => {
    await insertPatient("Patient-ABC", "2026-01-01T00:00:00.000Z");
    await insertPatient("p-2", "2026-01-02T00:00:00.000Z");

    const byId = await users.listUsers(10, undefined, "patient-abc");
    assert.deepEqual(byId.map((row) => row.id), ["Patient-ABC"]);

    const bySubject = await users.listUsers(10, undefined, "P-2@DEV");
    assert.deepEqual(bySubject.map((row) => row.id), ["p-2"]);

    assert.equal((await users.listUsers(10, undefined, "nothing")).length, 0);
  });

  test("listUsers：activeWithinDays 过滤（last_active_at 或近期会话）", async () => {
    const recent = now();
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await insertPatient("p-old", old);
    await insertPatient("p-active-account", old);
    await insertPatient("p-active-session", old);
    await database.query(
      `INSERT INTO patient_accounts(
        patient_id, username_hash, password_hash, last_active_at, revision,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 1, $5, $5)`,
      ["p-active-account", "uh-a", "ph-a", recent, old]
    );
    await insertPatientSession("ps-new", "p-active-session", recent);

    const rows = await users.listUsers(10, 7);
    assert.deepEqual(
      rows.map((row) => row.id).sort(),
      ["p-active-account", "p-active-session"]
    );
  });

  test("findUser：命中与未命中", async () => {
    await insertPatient("p-1", "2026-01-01T00:00:00.000Z");
    const found = await users.findUser("p-1");
    assert.equal(found?.id, "p-1");
    assert.equal(found?.registeredAt, "2026-01-01T00:00:00.000Z");
    assert.equal(await users.findUser("missing"), null);
  });

  test("listSessions：排除已撤销、患者隔离、倒序", async () => {
    await insertPatient("p-1", "2026-01-01T00:00:00.000Z");
    await insertPatient("p-2", "2026-01-01T00:00:00.000Z");
    const at = now();
    await insertPatientSession("ps-old", "p-1", "2026-01-01T00:00:00.000Z");
    await insertPatientSession("ps-new", "p-1", at);
    await insertPatientSession("ps-revoked", "p-1", at, at);
    await insertPatientSession("ps-other", "p-2", at);

    const rows = await users.listSessions("p-1", 10);
    assert.deepEqual(rows.map((row) => row.tokenHash), ["ps-new", "ps-old"]);
    // 患者隔离：p-2 的会话不漏进 p-1 的列表，反之亦然
    assert.deepEqual(
      (await users.listSessions("p-2", 10)).map((row) => row.tokenHash),
      ["ps-other"]
    );
  });

  test("记录投影：症状/暴露/用药字段、排序与患者隔离", async () => {
    await insertPatient("p-1", "2026-01-01T00:00:00.000Z");
    await insertPatient("p-2", "2026-01-01T00:00:00.000Z");
    await insertSymptom("sr-1", "p-1", "2026-01-02");
    await insertSymptom("sr-2", "p-1", "2026-01-03");
    await insertSymptom("sr-x", "p-2", "2026-01-04");
    await insertExposure("er-1", "p-1", "2026-01-02");
    await insertMedication("mr-1", "p-1", "2026-01-02");

    const symptoms = await users.listSymptomRecords("p-1", 10);
    // local_date DESC
    assert.deepEqual(symptoms.map((row) => row.id), ["sr-2", "sr-1"]);
    assert.deepEqual(symptoms[0], {
      id: "sr-2",
      localDate: "2026-01-03",
      nasalCongestion: 1,
      nasalItching: 2,
      sneezing: 3,
      runnyNose: 0,
      tnssTotal: 6
    });
    // 患者隔离
    assert.deepEqual(
      (await users.listSymptomRecords("p-2", 10)).map((row) => row.id),
      ["sr-x"]
    );

    const exposures = await users.listExposureRecords("p-1", 10);
    assert.deepEqual(exposures, [
      { id: "er-1", localDate: "2026-01-02", factorsJson: '["pollen"]' }
    ]);

    // 用药正文已加密且管理端不注入加密端口：恒为 null
    const medications = await users.listMedicationRecords("p-1", 10);
    assert.deepEqual(medications, [
      { id: "mr-1", localDate: "2026-01-02", medicationName: null, dosage: null }
    ]);
  });

  test("activity：七项聚合计数（COUNT int8 强转 number）", async () => {
    const recent = now();
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await insertPatient("p-1", recent);
    await insertPatient("p-2", old);
    await insertPatientSession("ps-1", "p-1", recent);
    await insertPatientSession("ps-2", "p-1", old);
    await insertSymptom("sr-1", "p-1", "2026-01-02");
    await insertExposure("er-1", "p-1", "2026-01-02");
    await insertMedication("mr-1", "p-1", "2026-01-02");
    await database.query(
      `INSERT INTO content_items(
        id, kind, title, category, summary, source, status,
        patient_visible, version_valid, media_available, updated_at
      ) VALUES
        ('c-1', 'article', 't', 'cat', 's', 'src', 'published', 1, 1, 1, $1),
        ('c-2', 'article', 't', 'cat', 's', 'src', 'draft', 1, 1, 1, $1),
        ('c-3', 'article', 't', 'cat', 's', 'src', 'published', 0, 1, 1, $1)`,
      [recent]
    );

    const activity = await users.activity();
    assert.deepEqual(activity, {
      totalUsers: 2,
      newUsers7d: 1,
      activeUsers7d: 1,
      sessionCount: 2,
      recordCount: 3,
      contentPublishedCount: 1
    });
    for (const value of Object.values(activity)) {
      assert.equal(typeof value, "number");
    }
  });

  // ---------- AuditPort（强制审计） ----------

  test("audit.record：完整字段落库，可选字段缺省写 NULL", async () => {
    await audit.record({
      actorKind: "admin",
      actorId: "a-1",
      action: "content.publish",
      entityType: "content_item",
      entityId: "c-1",
      entityRevision: 3,
      requestId: "req-1",
      details: { from: "review", to: "published" }
    });
    await audit.record({
      actorKind: "system",
      actorId: "system",
      action: "consent.withdraw",
      entityType: "patient",
      entityId: "p-1",
      details: {}
    });

    const { rows } = await database.query<{
      actor_kind: string;
      actor_id: string;
      action: string;
      entity_revision: number | null;
      request_id: string | null;
      details_json: string;
    }>(
      `SELECT actor_kind, actor_id, action, entity_revision, request_id, details_json
      FROM audit_events ORDER BY created_at ASC, id ASC`
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.entity_revision, 3);
    assert.equal(typeof rows[0]?.entity_revision, "number");
    assert.equal(rows[0]?.request_id, "req-1");
    assert.deepEqual(JSON.parse(rows[0]?.details_json ?? ""), {
      from: "review", to: "published"
    });
    // entityRevision/requestId 缺省 → NULL（pg 参数不得传 undefined）
    assert.equal(rows[1]?.entity_revision, null);
    assert.equal(rows[1]?.request_id, null);
  });

  test("audit.record：写入失败直接抛错，绝不静默（P1-3 强制审计）", async () => {
    // actor_kind 越出 CHECK 约束 → record 必须 reject，不吞错
    await assert.rejects(
      audit.record({
        actorKind: "ghost" as "admin",
        actorId: "a-1",
        action: "x",
        entityType: "y",
        entityId: "z",
        details: {}
      })
    );
    const { rows } = await database.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM audit_events"
    );
    assert.equal(rows[0]?.count, 0);
  });
}
