/**
 * PgAccountRepository 契约测试：与 SqliteAccountRepository 语义逐条对齐。
 *
 * 覆盖端口主路径与关键语义：
 * - createAccount：患者行+账号行同一事务；username_hash 唯一冲突（含并发
 *   竞态）映射 version_conflict；失败时整体回滚不残留患者行；
 * - findByUsernameHash / findByPatientId：登录快照字段完整回读；
 * - updateNickname：CAS revision（P2-9），过期修订号 → version_conflict
 *   （details.expectedRevision），账号不存在 → resource_not_found；
 * - touchLastActive：只更新 last_active_at，不动 revision；
 * - appendConsent / listConsents：按患者+类型只追加序列，撤回=追加
 *   withdrawn 记录；排序 consent_type ASC, sequence ASC；患者间隔离。
 *
 * 运行前需设置 KANGMIN_TEST_DATABASE_URL 指向 PostgreSQL 服务器（如维护库
 * postgres）；每个文件据此创建一次性隔离库，迁移自动执行，结束后删除。
 */
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { DomainError } from "@kangmin/core/kernel/errors";
import { KangminPgDatabase } from "../infrastructure/postgres/pg-database.js";
import { PgAccountRepository } from "../infrastructure/postgres/pg-account-repository.js";
import type { CreateAccountInput } from "@kangmin/core/patient/account/account-repository";
import {
  createPgTestDatabase,
  type PgTestDatabase
} from "./pg-test-database.js";

const DATABASE_URL = process.env.KANGMIN_TEST_DATABASE_URL;
const SKIP_REASON = "未配置 KANGMIN_TEST_DATABASE_URL";

let testDatabase: PgTestDatabase | null = null;
let database: KangminPgDatabase | undefined;

before(async () => {
  testDatabase = await createPgTestDatabase("pg_account");
  if (testDatabase !== null) {
    database = new KangminPgDatabase(testDatabase.url);
    await database.ready;
  }
});

after(async () => {
  if (database !== undefined) {
    await database.close();
  }
  if (testDatabase !== null) {
    await testDatabase.close();
  }
});

function requireDatabase(): KangminPgDatabase {
  assert.ok(database !== undefined, SKIP_REASON);
  return database;
}

function accountInput(overrides: Partial<CreateAccountInput> = {}): CreateAccountInput {
  const suffix = randomUUID();
  return {
    patientId: `pat-${suffix}`,
    usernameHash: `hash-${suffix}`,
    usernameMasked: `u***${suffix.slice(0, 4)}`,
    passwordHash: `pw-${suffix}`,
    nickname: "小抗",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

test("createAccount 创建账号并可按用户名哈希/患者 ID 回读快照", {
  skip: DATABASE_URL === undefined ? SKIP_REASON : false
}, async () => {
  const repository = new PgAccountRepository(requireDatabase());
  const input = accountInput();

  const created = await repository.createAccount(input);
  assert.deepEqual(created, {
    patientId: input.patientId,
    usernameHash: input.usernameHash,
    usernameMasked: input.usernameMasked,
    passwordHash: input.passwordHash,
    status: "active",
    nickname: input.nickname,
    revision: 1,
    lastActiveAt: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });

  const byHash = await repository.findByUsernameHash(input.usernameHash);
  assert.deepEqual(byHash, created);
  const byPatient = await repository.findByPatientId(input.patientId);
  assert.deepEqual(byPatient, created);
});

test("findByUsernameHash / findByPatientId 未命中返回 null", {
  skip: DATABASE_URL === undefined ? SKIP_REASON : false
}, async () => {
  const repository = new PgAccountRepository(requireDatabase());
  assert.equal(await repository.findByUsernameHash(`none-${randomUUID()}`), null);
  assert.equal(await repository.findByPatientId(`none-${randomUUID()}`), null);
});

test("createAccount 用户名哈希重复映射 version_conflict，且原账号不受影响", {
  skip: DATABASE_URL === undefined ? SKIP_REASON : false
}, async () => {
  const repository = new PgAccountRepository(requireDatabase());
  const first = accountInput();
  await repository.createAccount(first);

  const duplicate = accountInput({ usernameHash: first.usernameHash });
  await assert.rejects(
    repository.createAccount(duplicate),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "version_conflict");
      assert.equal(error.message, "该用户名已被注册，请直接登录");
      return true;
    }
  );

  // 冲突事务整体回滚：不残留第二个患者行，原账号快照不变。
  assert.equal(await repository.findByPatientId(duplicate.patientId), null);
  const original = await repository.findByPatientId(first.patientId);
  assert.equal(original?.revision, 1);
  assert.equal(original?.status, "active");
});

test("createAccount 同一患者 ID 重复创建同样命中唯一约束 → version_conflict", {
  skip: DATABASE_URL === undefined ? SKIP_REASON : false
}, async () => {
  const repository = new PgAccountRepository(requireDatabase());
  const input = accountInput();
  await repository.createAccount(input);

  const replay = accountInput({
    patientId: input.patientId,
    usernameHash: `other-${randomUUID()}`
  });
  await assert.rejects(repository.createAccount(replay), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "version_conflict");
    return true;
  });
});

test("updateNickname 主路径：昵称更新、revision 递增、updated_at 刷新", {
  skip: DATABASE_URL === undefined ? SKIP_REASON : false
}, async () => {
  const repository = new PgAccountRepository(requireDatabase());
  const input = accountInput();
  await repository.createAccount(input);

  const updated = await repository.updateNickname(input.patientId, "新昵称", 1);
  assert.equal(updated.nickname, "新昵称");
  assert.equal(updated.revision, 2);
  assert.equal(updated.createdAt, input.createdAt);
  assert.ok(updated.updatedAt >= input.createdAt);

  // 支持清空昵称（null）。
  const cleared = await repository.updateNickname(input.patientId, null, 2);
  assert.equal(cleared.nickname, null);
  assert.equal(cleared.revision, 3);

  const reread = await repository.findByPatientId(input.patientId);
  assert.deepEqual(reread, cleared);
});

test("updateNickname 过期修订号 → version_conflict 且原值不变（CAS 语义）", {
  skip: DATABASE_URL === undefined ? SKIP_REASON : false
}, async () => {
  const repository = new PgAccountRepository(requireDatabase());
  const input = accountInput();
  await repository.createAccount(input);
  await repository.updateNickname(input.patientId, "第二次", 1);

  await assert.rejects(
    repository.updateNickname(input.patientId, "过期写入", 1),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "version_conflict");
      assert.deepEqual(error.details, { expectedRevision: 1 });
      return true;
    }
  );

  const current = await repository.findByPatientId(input.patientId);
  assert.equal(current?.nickname, "第二次");
  assert.equal(current?.revision, 2);
});

test("updateNickname 账号不存在 → resource_not_found", {
  skip: DATABASE_URL === undefined ? SKIP_REASON : false
}, async () => {
  const repository = new PgAccountRepository(requireDatabase());
  await assert.rejects(
    repository.updateNickname(`none-${randomUUID()}`, "昵称", 1),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "resource_not_found");
      assert.equal(error.message, "当前会话没有本地账号，请先注册");
      return true;
    }
  );
});

test("touchLastActive 只更新 last_active_at，不影响 revision", {
  skip: DATABASE_URL === undefined ? SKIP_REASON : false
}, async () => {
  const repository = new PgAccountRepository(requireDatabase());
  const input = accountInput();
  await repository.createAccount(input);

  const at = new Date().toISOString();
  await repository.touchLastActive(input.patientId, at);

  const snapshot = await repository.findByPatientId(input.patientId);
  assert.equal(snapshot?.lastActiveAt, at);
  assert.equal(snapshot?.revision, 1);
});

test("appendConsent 序列按患者+类型从 1 递增，撤回为追加 withdrawn 记录", {
  skip: DATABASE_URL === undefined ? SKIP_REASON : false
}, async () => {
  const repository = new PgAccountRepository(requireDatabase());
  const input = accountInput();
  await repository.createAccount(input);

  const granted = await repository.appendConsent({
    patientId: input.patientId,
    consentType: "privacy",
    decision: "granted",
    policyVersion: "v1",
    requestId: `req-${randomUUID()}`,
    createdAt: new Date().toISOString()
  });
  assert.equal(granted.sequence, 1);

  const withdrawn = await repository.appendConsent({
    patientId: input.patientId,
    consentType: "privacy",
    decision: "withdrawn",
    policyVersion: "v1",
    requestId: `req-${randomUUID()}`,
    createdAt: new Date().toISOString()
  });
  assert.equal(withdrawn.sequence, 2);
  assert.equal(withdrawn.decision, "withdrawn");

  // 另一同意类型的序列独立从 1 开始。
  const medical = await repository.appendConsent({
    patientId: input.patientId,
    consentType: "medical_boundary",
    decision: "granted",
    policyVersion: "v2",
    requestId: `req-${randomUUID()}`,
    createdAt: new Date().toISOString()
  });
  assert.equal(medical.sequence, 1);

  // 排序：consent_type ASC（medical_boundary 先于 privacy），再按 sequence。
  const consents = await repository.listConsents(input.patientId);
  assert.deepEqual(
    consents.map((record) => [record.consentType, record.sequence, record.decision]),
    [
      ["medical_boundary", 1, "granted"],
      ["privacy", 1, "granted"],
      ["privacy", 2, "withdrawn"]
    ]
  );
  // 追加日志完整保留：granted 记录在 withdrawn 之后仍可读到。
  assert.equal(consents[1]?.requestId, granted.requestId);
});

test("listConsents 患者隔离：只返回本人记录，序列互不影响", {
  skip: DATABASE_URL === undefined ? SKIP_REASON : false
}, async () => {
  const repository = new PgAccountRepository(requireDatabase());
  const first = accountInput();
  const second = accountInput();
  await repository.createAccount(first);
  await repository.createAccount(second);

  await repository.appendConsent({
    patientId: first.patientId,
    consentType: "privacy",
    decision: "granted",
    policyVersion: "v1",
    requestId: `req-${randomUUID()}`,
    createdAt: new Date().toISOString()
  });

  // 第二名患者无任何记录；其首个序列不受第一名患者影响。
  assert.deepEqual(await repository.listConsents(second.patientId), []);
  const own = await repository.appendConsent({
    patientId: second.patientId,
    consentType: "privacy",
    decision: "granted",
    policyVersion: "v1",
    requestId: `req-${randomUUID()}`,
    createdAt: new Date().toISOString()
  });
  assert.equal(own.sequence, 1);

  const firstOnly = await repository.listConsents(first.patientId);
  assert.equal(firstOnly.length, 1);
  assert.equal(firstOnly[0]?.patientId, first.patientId);
});

test("appendConsent 患者不存在时外键约束生效（拒绝孤儿同意记录）", {
  skip: DATABASE_URL === undefined ? SKIP_REASON : false
}, async () => {
  const repository = new PgAccountRepository(requireDatabase());
  await assert.rejects(
    repository.appendConsent({
      patientId: `none-${randomUUID()}`,
      consentType: "privacy",
      decision: "granted",
      policyVersion: "v1",
      requestId: `req-${randomUUID()}`,
      createdAt: new Date().toISOString()
    })
  );
});

test("appendConsent 生成单列 id；findLatestConsent 取最新决策（issue-155）", {
  skip: DATABASE_URL === undefined ? SKIP_REASON : false
}, async () => {
  const repository = new PgAccountRepository(requireDatabase());
  const input = accountInput();
  await repository.createAccount(input);

  // 无任何记录 → null（fail-closed 语义由调用方决定）。
  assert.equal(
    await repository.findLatestConsent(input.patientId, "health_data"),
    null
  );

  const granted = await repository.appendConsent({
    patientId: input.patientId,
    consentType: "health_data",
    decision: "granted",
    policyVersion: "v1",
    requestId: `req-${randomUUID()}`,
    createdAt: new Date().toISOString()
  });
  // 单列 id 由仓储生成（供 agent_conversations.save_consent_id 引用）。
  assert.ok(granted.id.length > 0);

  const withdrawn = await repository.appendConsent({
    patientId: input.patientId,
    consentType: "health_data",
    decision: "withdrawn",
    policyVersion: "v1",
    requestId: `req-${randomUUID()}`,
    createdAt: new Date().toISOString()
  });
  assert.notEqual(withdrawn.id, granted.id);

  const latest = await repository.findLatestConsent(input.patientId, "health_data");
  assert.equal(latest?.id, withdrawn.id);
  assert.equal(latest?.decision, "withdrawn");
  assert.equal(latest?.sequence, 2);
});
