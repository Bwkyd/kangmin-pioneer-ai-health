import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import { PlaintextEncryption } from "../infrastructure/aes-gcm-encryption.js";
import { PgAgentAdminRepository } from "../infrastructure/postgres/pg-agent-admin-repository.js";
import { PgEnvironmentCacheRepository } from "../infrastructure/postgres/pg-environment-cache-repository.js";
import { KangminPgDatabase } from "../infrastructure/postgres/pg-database.js";
import {
  createPgTestDatabase,
  type PgTestDatabase
} from "./pg-test-database.js";
import type {
  ChunkInput,
  KnowledgeFolderRow,
  KnowledgeRow,
  ModelConfigRow,
  PlanRow
} from "../modules/agent-admin/agent-admin-ports.js";
import type { EnvironmentSnapshot } from "../modules/environment/environment-ports.js";

const DATABASE_URL = process.env.KANGMIN_TEST_DATABASE_URL;
const SKIP =
  DATABASE_URL === undefined ? "未配置 KANGMIN_TEST_DATABASE_URL" : false;

let testDatabase: PgTestDatabase | null = null;
let sharedDatabase: KangminPgDatabase | undefined;

if (DATABASE_URL !== undefined) {
  test.before(async () => {
    testDatabase = await createPgTestDatabase("pg_agent_admin");
  });
}

function database(): KangminPgDatabase {
  if (sharedDatabase === undefined) {
    const url = testDatabase?.url;
    assert.ok(url !== undefined, "隔离测试库未初始化");
    sharedDatabase = new KangminPgDatabase(url);
  }
  return sharedDatabase;
}

function agentAdmin(): PgAgentAdminRepository {
  return new PgAgentAdminRepository(database(), new PlaintextEncryption());
}

function environmentCache(): PgEnvironmentCacheRepository {
  return new PgEnvironmentCacheRepository(database());
}

test.after(async () => {
  if (sharedDatabase !== undefined) {
    await sharedDatabase.close();
  }
  const created = testDatabase;
  if (created !== null) {
    await created.close();
  }
});

function uid(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** admin_idempotency 外键依赖 admin_accounts，按需插入。 */
async function ensureAdmin(adminId: string): Promise<void> {
  await database().query(
    `INSERT INTO admin_accounts(
       id, username, password_hash, role, status, revision, created_at, updated_at
     ) VALUES ($1, $2, 'hash', 'admin', 'active', 1, $3, $3)
     ON CONFLICT(id) DO NOTHING`,
    [adminId, `user-${adminId}`, "2026-01-01T00:00:00.000Z"]
  );
}

function makeMedia(id: string): {
  id: string;
  kind: "pdf";
  filename: string;
  storedPath: string;
  sizeBytes: number;
  mimeType: string | null;
  sha256: string | null;
  status: "ready";
  failureReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id,
    kind: "pdf",
    filename: `${id}.pdf`,
    storedPath: `/media/${id}`,
    sizeBytes: 1024,
    mimeType: "application/pdf",
    sha256: `sha-${id}`,
    status: "ready",
    failureReason: null,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function makeKnowledge(
  id: string,
  overrides: Partial<KnowledgeRow> = {},
  chunks: ChunkInput[] = [
    { index: 0, text: "过敏性鼻炎 肺气虚寒 第一条分块" },
    { index: 1, text: "第二条分块：温肺散寒" }
  ]
): KnowledgeRow & { chunks: ChunkInput[] } {
  return {
    id,
    name: `知识-${id}`,
    source: "临床指南",
    description: null,
    sourceMediaId: null,
    sizeBytes: 2048,
    mimeType: "application/pdf",
    sha256: `sha-${id}`,
    status: "enabled",
    parseError: null,
    chunkCount: chunks.length,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
    folderId: overrides.folderId ?? null,
    chunks
  };
}

function makePlanRow(id: string, overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id,
    name: `方案-${id}`,
    syndrome: "FEI_QI_XU_HAN",
    phaseCode: null,
    audience: null,
    method: "温肺散寒",
    stepsJson: JSON.stringify(["第一步", "第二步"]),
    precautions: "注意保暖",
    risks: "孕妇慎用",
    contraindications: "实热证禁用",
    applicableAge: null,
    videoResourceId: null,
    displayOrder: 0,
    status: "draft",
    revision: 1,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

async function insertVideoContentItem(
  id: string,
  status: string,
  kind: "video" | "article" = "video"
): Promise<void> {
  await database().query(
    `INSERT INTO content_items(
       id, kind, title, category, summary, source, status,
       patient_visible, version_valid, media_available,
       updated_at, revision
     ) VALUES ($1, $2, '标题', '分类', '摘要', '来源', $3, 1, 1, 1, $4, 1)`,
    [id, kind, status, "2026-01-01T00:00:00.000Z"]
  );
}

// ==================== 环境快照缓存 ====================

test("环境缓存：未命中返回 null", { skip: SKIP }, async () => {
  const found = await environmentCache().find(uid("provider"), uid("key"));
  assert.equal(found, null);
});

test(
  "环境缓存：save 后 find 返回快照，expiresAt = fetchedAt + ttl",
  { skip: SKIP },
  async () => {
    const providerId = uid("provider");
    const cacheKey = uid("key");
    const snapshot: EnvironmentSnapshot = {
      city: "成都",
      weatherJson: "{\"weather\":\"rain\"}",
      airQualityJson: "{\"aqi\":80}",
      pollenRiskJson: "{\"level\":3}",
      observedAt: "2026-01-01T00:00:00.000Z",
      fetchedAt: "2026-01-01T01:00:00.000Z",
      sourceLabel: "test-double",
      stale: false
    };
    await environmentCache().save(providerId, snapshot, cacheKey, 600);
    const found = await environmentCache().find(providerId, cacheKey);
    assert.ok(found !== null);
    assert.equal(found.city, "成都");
    assert.equal(found.weatherJson, snapshot.weatherJson);
    assert.equal(found.airQualityJson, snapshot.airQualityJson);
    assert.equal(found.pollenRiskJson, snapshot.pollenRiskJson);
    assert.equal(found.observedAt, snapshot.observedAt);
    assert.equal(found.fetchedAt, snapshot.fetchedAt);
    assert.equal(found.sourceLabel, "test-double");
    // 过期判定在服务层，仓储读出恒 stale: false。
    assert.equal(found.stale, false);
    assert.equal(found.expiresAt, "2026-01-01T01:10:00.000Z");
  }
);

test(
  "环境缓存：同 (provider, cache_key) 重复 save 覆盖（UPSERT 语义）",
  { skip: SKIP },
  async () => {
    const providerId = uid("provider");
    const cacheKey = uid("key");
    const base: EnvironmentSnapshot = {
      city: "成都",
      weatherJson: "{\"weather\":\"rain\"}",
      airQualityJson: "{\"aqi\":80}",
      pollenRiskJson: "{\"level\":3}",
      observedAt: "2026-01-01T00:00:00.000Z",
      fetchedAt: "2026-01-01T01:00:00.000Z",
      sourceLabel: "test-double",
      stale: false
    };
    await environmentCache().save(providerId, base, cacheKey, 600);
    await environmentCache().save(
      providerId,
      { ...base, city: "重庆", fetchedAt: "2026-01-01T02:00:00.000Z" },
      cacheKey,
      300
    );
    const found = await environmentCache().find(providerId, cacheKey);
    assert.ok(found !== null);
    assert.equal(found.city, "重庆");
    assert.equal(found.fetchedAt, "2026-01-01T02:00:00.000Z");
    assert.equal(found.expiresAt, "2026-01-01T02:05:00.000Z");
    // 覆盖而非新增：仍只有一行。
    const { rows } = await database().query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM environment_snapshots WHERE provider = $1 AND cache_key = $2",
      [providerId, cacheKey]
    );
    assert.equal(rows[0]?.n, 1);
  }
);

test(
  "环境缓存：provider 与 cache_key 相互隔离",
  { skip: SKIP },
  async () => {
    const cacheKey = uid("key");
    const providerA = uid("providerA");
    const providerB = uid("providerB");
    const snapshot: EnvironmentSnapshot = {
      city: "成都",
      weatherJson: "{}",
      airQualityJson: "{}",
      pollenRiskJson: "{}",
      observedAt: "2026-01-01T00:00:00.000Z",
      fetchedAt: "2026-01-01T01:00:00.000Z",
      sourceLabel: "test-double",
      stale: false
    };
    await environmentCache().save(providerA, snapshot, cacheKey, 600);
    // 同 cache_key 不同 provider 是另一行；未写入的 provider 查不到。
    assert.equal(await environmentCache().find(providerB, cacheKey), null);
    await environmentCache().save(
      providerB,
      { ...snapshot, city: "北京" },
      cacheKey,
      600
    );
    const foundA = await environmentCache().find(providerA, cacheKey);
    const foundB = await environmentCache().find(providerB, cacheKey);
    assert.equal(foundA?.city, "成都");
    assert.equal(foundB?.city, "北京");
  }
);

test(
  "环境缓存：过期快照仍可读（stale=false，过期判定留给服务层）",
  { skip: SKIP },
  async () => {
    const providerId = uid("provider");
    const cacheKey = uid("key");
    const snapshot: EnvironmentSnapshot = {
      city: "成都",
      weatherJson: "{}",
      airQualityJson: "{}",
      pollenRiskJson: "{}",
      observedAt: "2020-01-01T00:00:00.000Z",
      fetchedAt: "2020-01-01T01:00:00.000Z",
      sourceLabel: "test-double",
      stale: false
    };
    await environmentCache().save(providerId, snapshot, cacheKey, 1);
    const found = await environmentCache().find(providerId, cacheKey);
    assert.ok(found !== null);
    assert.equal(found.stale, false);
    assert.equal(found.expiresAt, "2020-01-01T01:00:01.000Z");
    assert.ok(Date.parse(found.expiresAt) < Date.now());
  }
);

// ==================== 知识库 ====================

test(
  "知识：createKnowledge 写入知识行与分块，findKnowledge 读回",
  { skip: SKIP },
  async () => {
    const knowledge = makeKnowledge(uid("kn"));
    await agentAdmin().createKnowledge(knowledge);
    const found = await agentAdmin().findKnowledge(knowledge.id);
    assert.ok(found !== null);
    assert.equal(found.name, knowledge.name);
    assert.equal(found.status, "enabled");
    assert.equal(found.chunkCount, 2);
    assert.equal(found.sizeBytes, 2048);
    assert.deepEqual(await agentAdmin().listKnowledgeChunks(knowledge.id), [
      { index: 0, text: "过敏性鼻炎 肺气虚寒 第一条分块" },
      { index: 1, text: "第二条分块：温肺散寒" }
    ]);
  }
);

test(
  "知识：findKnowledge 不存在返回 null；listKnowledge 状态过滤与排序",
  { skip: SKIP },
  async () => {
    assert.equal(await agentAdmin().findKnowledge(uid("missing")), null);
    const prefix = randomUUID();
    const older = makeKnowledge(uid("kn"), {
      name: `list-${prefix}-a`,
      status: "enabled",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    const newer = makeKnowledge(uid("kn"), {
      name: `list-${prefix}-b`,
      status: "disabled",
      updatedAt: "2026-01-02T00:00:00.000Z"
    });
    await agentAdmin().createKnowledge(older);
    await agentAdmin().createKnowledge(newer);
    // 不过滤时按 updated_at DESC 排序。
    const all = (await agentAdmin().listKnowledge()).filter((row) =>
      row.name.startsWith(`list-${prefix}`)
    );
    assert.deepEqual(
      all.map((row) => row.id),
      [newer.id, older.id]
    );
    // 状态过滤只回匹配行。
    const enabledOnly = await agentAdmin().listKnowledge("enabled");
    assert.ok(enabledOnly.some((row) => row.id === older.id));
    assert.ok(!enabledOnly.some((row) => row.id === newer.id));
  }
);

test(
  "知识目录：父子目录、知识移动与非空删除保护",
  { skip: SKIP },
  async () => {
    const timestamp = "2026-08-26T00:00:00.000Z";
    const root: KnowledgeFolderRow = {
      id: uid("folder"), parentId: null, name: `根目录-${randomUUID()}`,
      sortOrder: 0, createdBy: null, createdAt: timestamp, updatedAt: timestamp
    };
    const child: KnowledgeFolderRow = {
      id: uid("folder"), parentId: root.id, name: "子目录",
      sortOrder: 0, createdBy: null, createdAt: timestamp, updatedAt: timestamp
    };
    assert.equal(await agentAdmin().createKnowledgeFolder(root), "created");
    assert.equal(await agentAdmin().createKnowledgeFolder(root), "duplicate");
    assert.equal(await agentAdmin().createKnowledgeFolder(child), "created");
    const knowledge = makeKnowledge(uid("kn"), { folderId: root.id, category: null });
    await agentAdmin().createKnowledge(knowledge);
    assert.equal((await agentAdmin().findKnowledge(knowledge.id))?.category, root.name);
    assert.equal(await agentAdmin().moveKnowledge(knowledge.id, child.id, timestamp), "updated");
    assert.equal((await agentAdmin().findKnowledge(knowledge.id))?.category, `${root.name} / ${child.name}`);
    assert.equal(await agentAdmin().deleteKnowledgeFolder(child.id), "not_empty");
    assert.equal(await agentAdmin().moveKnowledge(knowledge.id, null, timestamp), "updated");
    assert.equal(await agentAdmin().deleteKnowledgeFolder(child.id), "deleted");
    assert.equal(await agentAdmin().deleteKnowledgeFolder(root.id), "deleted");
  }
);

test(
  "知识：createKnowledgeSource 幂等——created → replayed → conflict → stale_replay",
  { skip: SKIP },
  async () => {
    const adminId = uid("admin");
    await ensureAdmin(adminId);
    const idempotencyKey = uid("key");
    const requestHash = "hash-v1";
    const media = makeMedia(uid("media"));
    const knowledge = makeKnowledge(uid("kn"), { sourceMediaId: media.id });
    const input = { adminId, media, knowledge, idempotencyKey, requestHash };

    const first = await agentAdmin().createKnowledgeSource(input);
    assert.equal(first.kind, "created");
    if (first.kind === "created") {
      assert.equal(first.item.id, knowledge.id);
    }

    // 同键同 hash 重放：返回原知识，不重复创建。
    const replay = await agentAdmin().createKnowledgeSource(input);
    assert.equal(replay.kind, "replayed");
    if (replay.kind === "replayed") {
      assert.equal(replay.item.id, knowledge.id);
    }
    const { rows: knowledgeRows } = await database().query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM agent_knowledge_items WHERE id = $1",
      [knowledge.id]
    );
    assert.equal(knowledgeRows[0]?.n, 1);

    // 同键异 hash → 幂等冲突。
    const conflict = await agentAdmin().createKnowledgeSource({
      ...input,
      requestHash: "hash-v2"
    });
    assert.equal(conflict.kind, "conflict");

    // 原知识删除后同键重放 → stale_replay，不返回幻影记录。
    await database().query("DELETE FROM agent_knowledge_items WHERE id = $1", [
      knowledge.id
    ]);
    const stale = await agentAdmin().createKnowledgeSource(input);
    assert.equal(stale.kind, "stale_replay");
  }
);

test(
  "知识：createKnowledgeSource 事务原子性——素材插入失败整体回滚，不留幂等行与孤儿知识",
  { skip: SKIP },
  async () => {
    const adminId = uid("admin");
    await ensureAdmin(adminId);
    const media = makeMedia(uid("media"));
    // 预置同 id 素材，使事务内素材插入触发唯一冲突。
    await agentAdmin().registerMedia(media);
    const idempotencyKey = uid("key");
    const knowledge = makeKnowledge(uid("kn"), { sourceMediaId: media.id });
    await assert.rejects(
      agentAdmin().createKnowledgeSource({
        adminId,
        media,
        knowledge,
        idempotencyKey,
        requestHash: "hash"
      })
    );
    const { rows: idemRows } = await database().query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM admin_idempotency WHERE admin_id = $1 AND idempotency_key = $2",
      [adminId, idempotencyKey]
    );
    assert.equal(idemRows[0]?.n, 0);
    assert.equal(await agentAdmin().findKnowledge(knowledge.id), null);
  }
);

test(
  "知识：setKnowledgeStatus 更新状态与 parse_error；不存在返回 not_found",
  { skip: SKIP },
  async () => {
    const knowledge = makeKnowledge(uid("kn"));
    await agentAdmin().createKnowledge(knowledge);
    const result = await agentAdmin().setKnowledgeStatus(
      knowledge.id,
      "index_failed",
      "2026-01-03T00:00:00.000Z",
      "解析失败：文件损坏"
    );
    assert.equal(result, "updated");
    const found = await agentAdmin().findKnowledge(knowledge.id);
    assert.equal(found?.status, "index_failed");
    assert.equal(found?.parseError, "解析失败：文件损坏");
    assert.equal(found?.updatedAt, "2026-01-03T00:00:00.000Z");
    assert.equal(
      await agentAdmin().setKnowledgeStatus(
        uid("missing"),
        "disabled",
        "2026-01-03T00:00:00.000Z"
      ),
      "not_found"
    );
  }
);

test(
  "知识：setKnowledgeStatusGuarded——not_found / validation_failed 不改状态 / updated（guard 收到事务内重读的素材状态）",
  { skip: SKIP },
  async () => {
    const repo = agentAdmin();
    const missing = await repo.setKnowledgeStatusGuarded(
      uid("missing"),
      "enabled",
      "2026-01-03T00:00:00.000Z",
      () => []
    );
    assert.equal(missing.kind, "not_found");

    const adminId = uid("admin");
    await ensureAdmin(adminId);
    const media = makeMedia(uid("media"));
    const knowledge = makeKnowledge(uid("kn"), {
      status: "disabled",
      sourceMediaId: media.id
    });
    await repo.createKnowledgeSource({
      adminId,
      media,
      knowledge,
      idempotencyKey: uid("key"),
      requestHash: "hash"
    });

    // guard 拒绝：状态保持 disabled，事务不提交状态更新。
    const rejected = await repo.setKnowledgeStatusGuarded(
      knowledge.id,
      "enabled",
      "2026-01-03T00:00:00.000Z",
      () => ["来源素材未就绪"]
    );
    assert.equal(rejected.kind, "validation_failed");
    if (rejected.kind === "validation_failed") {
      assert.deepEqual(rejected.missing, ["来源素材未就绪"]);
    }
    assert.equal((await repo.findKnowledge(knowledge.id))?.status, "disabled");

    // guard 通过：guard 收到事务内重读的知识与素材状态。
    let guardSaw: { status: string; mediaStatus: string | null } | undefined;
    const updated = await repo.setKnowledgeStatusGuarded(
      knowledge.id,
      "enabled",
      "2026-01-04T00:00:00.000Z",
      (current, currentMedia) => {
        guardSaw = {
          status: current.status,
          mediaStatus: currentMedia?.status ?? null
        };
        return [];
      }
    );
    assert.equal(updated.kind, "updated");
    if (updated.kind === "updated") {
      assert.equal(updated.knowledge.status, "enabled");
      assert.equal(updated.knowledge.updatedAt, "2026-01-04T00:00:00.000Z");
    }
    assert.deepEqual(guardSaw, { status: "disabled", mediaStatus: "ready" });
  }
);

test(
  "知识：切块顺序稳定，向量索引按知识原子替换",
  { skip: SKIP },
  async () => {
    const knowledge = makeKnowledge(uid("kn"), {}, [
      { index: 0, text: "第零块" },
      { index: 1, text: "第一块" }
    ]);
    await agentAdmin().createKnowledge(knowledge);
    assert.deepEqual(await agentAdmin().listKnowledgeChunks(knowledge.id), [
      { index: 0, text: "第零块" },
      { index: 1, text: "第一块" }
    ]);

    assert.equal(
      await agentAdmin().replaceKnowledgeEmbeddings(
        knowledge.id,
        "test-embedding-v1",
        2,
        [
          { chunkIndex: 0, embedding: new Uint8Array([0, 0, 128, 63, 0, 0, 0, 0]) },
          { chunkIndex: 1, embedding: new Uint8Array([0, 0, 0, 0, 0, 0, 128, 63]) }
        ],
        "2026-01-03T00:00:00.000Z"
      ),
      "updated"
    );
    const { rows } = await database().query<{ model_name: string; dimensions: number }>(
      `SELECT model_name, dimensions
       FROM agent_knowledge_embeddings
       WHERE knowledge_id = $1
       ORDER BY chunk_index`,
      [knowledge.id]
    );
    assert.deepEqual(rows, [
      { model_name: "test-embedding-v1", dimensions: 2 },
      { model_name: "test-embedding-v1", dimensions: 2 }
    ]);
  }
);

test(
  "知识：replaceKnowledgeFromMedia 原子替换文件、正文和索引，并拒绝过期版本",
  { skip: SKIP },
  async () => {
    const repo = agentAdmin();
    const original = makeKnowledge(uid("kn"), { status: "enabled" }, [
      { index: 0, text: "旧正文" }
    ]);
    await repo.createKnowledge(original);
    await repo.replaceKnowledgeEmbeddings(
      original.id,
      "test-embedding-v1",
      1,
      [{ chunkIndex: 0, embedding: new Uint8Array([0, 0, 128, 63]) }],
      "2026-01-02T00:00:00.000Z"
    );
    const before = await repo.findKnowledge(original.id);
    assert.ok(before !== null);
    const media = makeMedia(uid("media"));
    await repo.registerMedia(media);

    const replaced = await repo.replaceKnowledgeFromMedia(original.id, {
      mediaId: media.id,
      sizeBytes: 321,
      mimeType: "text/markdown",
      sha256: "replacement-sha",
      status: "processing",
      parseError: null,
      chunks: [{ index: 0, text: "新正文" }, { index: 1, text: "第二块" }],
      expectedUpdatedAt: before.updatedAt,
      updatedAt: "2026-01-03T00:00:00.000Z"
    });
    assert.equal(replaced.kind, "updated");
    const stored = await repo.findKnowledge(original.id);
    assert.equal(stored?.sourceMediaId, media.id);
    assert.equal(stored?.status, "processing");
    assert.equal(stored?.chunkCount, 2);
    assert.deepEqual(await repo.listKnowledgeChunks(original.id), [
      { index: 0, text: "新正文" },
      { index: 1, text: "第二块" }
    ]);
    const { rows: embeddings } = await database().query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM agent_knowledge_embeddings WHERE knowledge_id = $1",
      [original.id]
    );
    assert.equal(embeddings[0]?.n, 0);

    const stale = await repo.replaceKnowledgeFromMedia(original.id, {
      mediaId: media.id,
      sizeBytes: 1,
      mimeType: "text/plain",
      sha256: "stale-sha",
      status: "processing",
      parseError: null,
      chunks: [{ index: 0, text: "不应写入" }],
      expectedUpdatedAt: before.updatedAt,
      updatedAt: "2026-01-04T00:00:00.000Z"
    });
    assert.equal(stale.kind, "version_conflict");
    assert.deepEqual(await repo.listKnowledgeChunks(original.id), [
      { index: 0, text: "新正文" },
      { index: 1, text: "第二块" }
    ]);
  }
);

// ==================== 调理方案 ====================

test(
  "方案：createPlan / findPlan / listPlans（display_order ASC 排序与状态过滤）",
  { skip: SKIP },
  async () => {
    assert.equal(await agentAdmin().findPlan(uid("missing")), null);
    const prefix = randomUUID();
    const second = makePlanRow(uid("plan"), {
      name: `list-${prefix}-b`,
      displayOrder: 2,
      status: "draft"
    });
    const first = makePlanRow(uid("plan"), {
      name: `list-${prefix}-a`,
      displayOrder: 1,
      status: "enabled"
    });
    await agentAdmin().createPlan(second);
    await agentAdmin().createPlan(first);

    const found = await agentAdmin().findPlan(second.id);
    assert.ok(found !== null);
    assert.deepEqual(found.steps, ["第一步", "第二步"]);
    assert.equal(found.syndrome, "FEI_QI_XU_HAN");

    const all = (await agentAdmin().listPlans()).filter((plan) =>
      plan.name.startsWith(`list-${prefix}`)
    );
    assert.deepEqual(
      all.map((plan) => plan.id),
      [first.id, second.id]
    );
    const enabledOnly = await agentAdmin().listPlans("enabled");
    assert.ok(enabledOnly.some((plan) => plan.id === first.id));
    assert.ok(!enabledOnly.some((plan) => plan.id === second.id));
  }
);

test(
  "方案：createPlanIdempotent 幂等——created → replayed → conflict → stale_replay",
  { skip: SKIP },
  async () => {
    const adminId = uid("admin");
    await ensureAdmin(adminId);
    const idempotencyKey = uid("key");
    const plan = makePlanRow(uid("plan"));

    const first = await agentAdmin().createPlanIdempotent(
      adminId,
      plan,
      idempotencyKey,
      "hash-v1"
    );
    assert.equal(first.kind, "created");
    if (first.kind === "created") {
      assert.equal(first.item.id, plan.id);
      assert.deepEqual(first.item.steps, ["第一步", "第二步"]);
    }

    const replay = await agentAdmin().createPlanIdempotent(
      adminId,
      makePlanRow(uid("plan-other")),
      idempotencyKey,
      "hash-v1"
    );
    assert.equal(replay.kind, "replayed");
    if (replay.kind === "replayed") {
      // 重放返回存储的原结果（原 id），不是本次请求携带的新方案。
      assert.equal(replay.item.id, plan.id);
    }
    assert.equal(
      await agentAdmin()
        .listPlans()
        .then((plans) => plans.filter((p) => p.id === plan.id).length),
      1
    );

    const conflict = await agentAdmin().createPlanIdempotent(
      adminId,
      plan,
      idempotencyKey,
      "hash-v2"
    );
    assert.equal(conflict.kind, "conflict");

    await database().query("DELETE FROM agent_plans WHERE id = $1", [plan.id]);
    const stale = await agentAdmin().createPlanIdempotent(
      adminId,
      plan,
      idempotencyKey,
      "hash-v1"
    );
    assert.equal(stale.kind, "stale_replay");
  }
);

test(
  "方案：updatePlan CAS——not_found / version_conflict（带 currentRevision）/ updated",
  { skip: SKIP },
  async () => {
    const repo = agentAdmin();
    const plan = makePlanRow(uid("plan"));
    await repo.createPlan(plan);

    const missingPlan = makePlanRow(uid("missing"));
    const notFound = await repo.updatePlan(
      {
        ...missingPlan,
        steps: ["第一步", "第二步"],
        revision: 2
      },
      1
    );
    assert.equal(notFound.kind, "not_found");

    const current = await repo.findPlan(plan.id);
    assert.ok(current !== null);
    const stale = await repo.updatePlan(
      { ...current, name: "不该写入", revision: 99 },
      99
    );
    assert.equal(stale.kind, "version_conflict");
    if (stale.kind === "version_conflict") {
      assert.equal(stale.currentRevision, 1);
    }

    const updated = await repo.updatePlan(
      {
        ...current,
        name: "改名方案",
        steps: ["新步骤"],
        revision: 2,
        updatedAt: "2026-01-05T00:00:00.000Z"
      },
      1
    );
    assert.equal(updated.kind, "updated");
    const reread = await repo.findPlan(plan.id);
    assert.equal(reread?.name, "改名方案");
    assert.deepEqual(reread?.steps, ["新步骤"]);
    assert.equal(reread?.revision, 2);

    // 更新后旧 expectedRevision 立即失效。
    const conflictAfter = await repo.updatePlan(
      { ...(await repo.findPlan(plan.id))!, revision: 3 },
      1
    );
    assert.equal(conflictAfter.kind, "version_conflict");
    if (conflictAfter.kind === "version_conflict") {
      assert.equal(conflictAfter.currentRevision, 2);
    }
  }
);

test(
  "方案：setPlanStatus CAS——not_found / version_conflict / updated（revision+1）",
  { skip: SKIP },
  async () => {
    const repo = agentAdmin();
    assert.equal(
      (
        await repo.setPlanStatus(
          uid("missing"),
          1,
          "enabled",
          "2026-01-05T00:00:00.000Z"
        )
      ).kind,
      "not_found"
    );

    const plan = makePlanRow(uid("plan"));
    await repo.createPlan(plan);
    const conflict = await repo.setPlanStatus(
      plan.id,
      5,
      "enabled",
      "2026-01-05T00:00:00.000Z"
    );
    assert.equal(conflict.kind, "version_conflict");
    if (conflict.kind === "version_conflict") {
      assert.equal(conflict.currentRevision, 1);
    }

    const updated = await repo.setPlanStatus(
      plan.id,
      1,
      "enabled",
      "2026-01-05T00:00:00.000Z"
    );
    assert.equal(updated.kind, "updated");
    if (updated.kind === "updated") {
      assert.equal(updated.plan.status, "enabled");
      assert.equal(updated.plan.revision, 2);
      assert.equal(updated.plan.updatedAt, "2026-01-05T00:00:00.000Z");
    }
  }
);

test(
  "方案：setPlanStatusGuarded——version_conflict / guard 拒绝不提交 / 通过则同事务置 enabled",
  { skip: SKIP },
  async () => {
    const repo = agentAdmin();
    assert.equal(
      (
        await repo.setPlanStatusGuarded(
          uid("missing"),
          1,
          "enabled",
          "2026-01-05T00:00:00.000Z",
          () => []
        )
      ).kind,
      "not_found"
    );

    const videoId = uid("video");
    await insertVideoContentItem(videoId, "unpublished");
    const plan = makePlanRow(uid("plan"), { videoResourceId: videoId });
    await repo.createPlan(plan);

    const conflict = await repo.setPlanStatusGuarded(
      plan.id,
      7,
      "enabled",
      "2026-01-05T00:00:00.000Z",
      () => []
    );
    assert.equal(conflict.kind, "version_conflict");

    // 视频未发布：guard 在事务内重读到 unpublished，拒绝且不提交。
    let guardSawVideo: { id: string; status: string } | null | undefined;
    const rejected = await repo.setPlanStatusGuarded(
      plan.id,
      1,
      "enabled",
      "2026-01-05T00:00:00.000Z",
      (_plan, video) => {
        guardSawVideo = video;
        return video === null || video.status !== "published"
          ? ["关联视频未发布"]
          : [];
      }
    );
    assert.equal(rejected.kind, "validation_failed");
    assert.equal(guardSawVideo?.status, "unpublished");
    assert.equal((await repo.findPlan(plan.id))?.status, "draft");
    assert.equal((await repo.findPlan(plan.id))?.revision, 1);

    // 视频发布后 guard 通过，同事务置 enabled 且 revision+1。
    await database().query(
      "UPDATE content_items SET status = 'published' WHERE id = $1",
      [videoId]
    );
    const updated = await repo.setPlanStatusGuarded(
      plan.id,
      1,
      "enabled",
      "2026-01-06T00:00:00.000Z",
      (_plan, video) =>
        video === null || video.status !== "published"
          ? ["关联视频未发布"]
          : []
    );
    assert.equal(updated.kind, "updated");
    if (updated.kind === "updated") {
      assert.equal(updated.plan.status, "enabled");
      assert.equal(updated.plan.revision, 2);
    }
  }
);

test(
  "方案：updatePlanGuarded——version_conflict / guard 事务内重读视频拒绝不提交 / 通过则同事务更新",
  { skip: SKIP },
  async () => {
    const repo = agentAdmin();
    const missingPlan = makePlanRow(uid("missing"));
    assert.equal(
      (
        await repo.updatePlanGuarded(
          { ...missingPlan, steps: ["第一步"], revision: 2 },
          1,
          () => []
        )
      ).kind,
      "not_found"
    );

    const videoId = uid("video");
    await insertVideoContentItem(videoId, "unpublished");
    const plan = makePlanRow(uid("plan"), { videoResourceId: videoId });
    await repo.createPlan(plan);
    const current = await repo.findPlan(plan.id);
    assert.ok(current !== null);

    const conflict = await repo.updatePlanGuarded(
      { ...current, name: "不该写入", revision: 9 },
      9,
      () => []
    );
    assert.equal(conflict.kind, "version_conflict");
    if (conflict.kind === "version_conflict") {
      assert.equal(conflict.currentRevision, 1);
    }

    // 视频未发布：guard 在事务内按新内容的 videoResourceId 重读到
    // unpublished，拒绝且不提交（方案名不被写入）。
    let guardSawVideo: { id: string; status: string } | null | undefined;
    const rejected = await repo.updatePlanGuarded(
      { ...current, name: "改名方案", revision: 2 },
      1,
      (_plan, video) => {
        guardSawVideo = video;
        return video === null || video.status !== "published"
          ? ["关联视频未发布"]
          : [];
      }
    );
    assert.equal(rejected.kind, "validation_failed");
    assert.equal(guardSawVideo?.status, "unpublished");
    assert.equal((await repo.findPlan(plan.id))?.name, `方案-${plan.id}`);
    assert.equal((await repo.findPlan(plan.id))?.revision, 1);

    // 视频发布后 guard 通过，同事务写入新内容且 revision 推进。
    await database().query(
      "UPDATE content_items SET status = 'published' WHERE id = $1",
      [videoId]
    );
    const updated = await repo.updatePlanGuarded(
      { ...current, name: "改名方案", revision: 2 },
      1,
      (_plan, video) =>
        video === null || video.status !== "published"
          ? ["关联视频未发布"]
          : []
    );
    assert.equal(updated.kind, "updated");
    assert.equal((await repo.findPlan(plan.id))?.name, "改名方案");
    assert.equal((await repo.findPlan(plan.id))?.revision, 2);
  }
);

// ==================== 模型配置（含加密 api_key） ====================

function makeModelConfig(overrides: Partial<ModelConfigRow> = {}): ModelConfigRow {
  return {
    provider: "openai-compatible",
    modelName: "deepseek-chat",
    timeoutSeconds: 30,
    maxOutputTokens: 1024,
    knowledgeRetrievalEnabled: 1,
    retrievalCount: 3,
    explanationEnabled: 1,
    apiKey: "sk-test-secret",
    updatedBy: "admin-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastTestStatus: null,
    lastTestAt: null,
    ...overrides
  };
}

test(
  "模型配置：空表 getModelConfig 返回 null",
  { skip: SKIP },
  async () => {
    await database().query("DELETE FROM agent_model_config");
    assert.equal(await agentAdmin().getModelConfig(), null);
  }
);

test(
  "模型配置：upsert 插入后 get 读回，api_key 密文落库 + encryption_key_version，读取解密还原",
  { skip: SKIP },
  async () => {
    await database().query("DELETE FROM agent_model_config");
    const result = await agentAdmin().upsertModelConfig(
      makeModelConfig(),
      null
    );
    assert.equal(result, "updated");

    const { rows } = await database().query<{
      api_key: string | null;
      encryption_key_version: string | null;
    }>(
      "SELECT api_key, encryption_key_version FROM agent_model_config WHERE id = 1"
    );
    const raw = rows[0];
    assert.ok(raw !== undefined);
    assert.ok(raw.api_key !== null);
    // 落库的是密文 JSON，不是明文；密钥版本随行记录。
    assert.notEqual(raw.api_key, "sk-test-secret");
    assert.ok(raw.api_key.includes("ciphertext"));
    assert.equal(raw.encryption_key_version, "plaintext-dev");

    const read = await agentAdmin().getModelConfig();
    assert.ok(read !== null);
    assert.equal(read.apiKey, "sk-test-secret");
    assert.equal(read.modelName, "deepseek-chat");
    assert.equal(read.timeoutSeconds, 30);
    assert.equal(read.knowledgeRetrievalEnabled, 1);
    assert.equal(read.updatedAt, "2026-01-01T00:00:00.000Z");
  }
);

test(
  "模型配置：单行 CAS——expectedUpdatedAt 匹配更新，陈旧快照返回 conflict 且不覆盖",
  { skip: SKIP },
  async () => {
    await database().query("DELETE FROM agent_model_config");
    const repo = agentAdmin();
    await repo.upsertModelConfig(
      makeModelConfig({ updatedAt: "2026-01-01T00:00:00.000Z" }),
      null
    );

    const matched = await repo.upsertModelConfig(
      makeModelConfig({
        modelName: "model-v2",
        updatedAt: "2026-01-02T00:00:00.000Z"
      }),
      "2026-01-01T00:00:00.000Z"
    );
    assert.equal(matched, "updated");
    assert.equal((await repo.getModelConfig())?.modelName, "model-v2");

    // 陈旧 expectedUpdatedAt（并发覆盖场景）→ conflict，数据不被覆盖。
    const stale = await repo.upsertModelConfig(
      makeModelConfig({
        modelName: "model-stale",
        updatedAt: "2026-01-03T00:00:00.000Z"
      }),
      "2026-01-01T00:00:00.000Z"
    );
    assert.equal(stale, "conflict");
    assert.equal((await repo.getModelConfig())?.modelName, "model-v2");
  }
);

test(
  "模型配置：apiKey 为 null 时落库 NULL 且读取为 null",
  { skip: SKIP },
  async () => {
    await database().query("DELETE FROM agent_model_config");
    const repo = agentAdmin();
    await repo.upsertModelConfig(makeModelConfig({ apiKey: null }), null);
    const { rows } = await database().query<{
      api_key: string | null;
      encryption_key_version: string | null;
    }>(
      "SELECT api_key, encryption_key_version FROM agent_model_config WHERE id = 1"
    );
    assert.equal(rows[0]?.api_key, null);
    assert.equal(rows[0]?.encryption_key_version, null);
    const read = await repo.getModelConfig();
    assert.equal(read?.apiKey, null);
  }
);

// ==================== 模拟测试用例 ====================

async function insertTestCase(
  id: string,
  status: "completed" | "failed",
  createdAt: string
): Promise<void> {
  await database().query(
    `INSERT INTO agent_test_cases(
       id, input_text, status, result_json, created_by, created_at
     ) VALUES ($1, $2, $3, $4, NULL, $5)`,
    [id, `输入-${id}`, status, "{}", createdAt]
  );
}

test(
  "测试用例：findTestCase / listTestCases（created_at DESC + id ASC，LIMIT 生效）",
  { skip: SKIP },
  async () => {
    const repo = agentAdmin();
    assert.equal(await repo.findTestCase(uid("missing")), null);

    const older = uid("tc");
    const newer = uid("tc");
    await insertTestCase(older, "completed", "2026-01-01T00:00:00.000Z");
    await insertTestCase(newer, "failed", "2026-01-02T00:00:00.000Z");

    const found = await repo.findTestCase(older);
    assert.ok(found !== null);
    assert.equal(found.status, "completed");
    assert.equal(found.inputText, `输入-${older}`);

    const listed = await repo.listTestCases(100);
    const ids = listed.map((row) => row.id);
    assert.ok(ids.indexOf(newer) < ids.indexOf(older));

    const limited = await repo.listTestCases(1);
    assert.equal(limited.length, 1);
    assert.equal(limited[0]?.id, ids[0]);
  }
);

// ==================== 内容集成 ====================

test(
  "内容集成：findVideoResource 只认 kind='video'，缺失/非视频返回 null",
  { skip: SKIP },
  async () => {
    const repo = agentAdmin();
    const videoId = uid("video");
    const articleId = uid("article");
    await insertVideoContentItem(videoId, "published", "video");
    await insertVideoContentItem(articleId, "published", "article");

    const video = await repo.findVideoResource(videoId);
    assert.deepEqual(video, { id: videoId, status: "published" });
    assert.equal(await repo.findVideoResource(articleId), null);
    assert.equal(await repo.findVideoResource(uid("missing")), null);
  }
);

// ==================== 远程上传：from-media 知识创建 ====================

test(
  "add-from-media：findMedia 读取素材行；createKnowledgeFromMedia 同事务插知识+分块+幂等行",
  { skip: SKIP },
  async () => {
    const repo = agentAdmin();
    const adminId = uid("admin");
    await ensureAdmin(adminId);
    const media = makeMedia(uid("med"));
    await repo.registerMedia(media);

    // findMedia：与 content-aux findMedia 同形状。
    const found = await repo.findMedia(media.id);
    assert.ok(found !== null);
    assert.equal(found.filename, media.filename);
    assert.equal(found.storedPath, media.storedPath);
    assert.equal(found.status, "ready");
    assert.equal(await repo.findMedia(uid("missing")), null);

    const knowledge = makeKnowledge(uid("kno"));
    const created = await repo.createKnowledgeFromMedia(
      adminId,
      media.id,
      knowledge,
      "sha-remote-1",
      "sha-remote-1"
    );
    assert.equal(created.kind, "created");
    if (created.kind === "created") {
      assert.equal(created.item.id, knowledge.id);
    }

    // 媒体行已在库，不重复插入；知识行 source_media_id 以 mediaId 为准。
    const { rows: mediaRows } = await database().query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM content_resource_media WHERE id = $1",
      [media.id]
    );
    assert.equal(mediaRows[0]?.n, 1);
    const stored = await repo.findKnowledge(knowledge.id);
    assert.equal(stored?.sourceMediaId, media.id);
    assert.equal(stored?.chunkCount, knowledge.chunks.length);

    // 幂等重放：同 scope 同键同 hash → replayed 返回原知识（不重复创建）。
    const replayed = await repo.createKnowledgeFromMedia(
      adminId,
      media.id,
      makeKnowledge(uid("kno-other")),
      "sha-remote-1",
      "sha-remote-1"
    );
    assert.equal(replayed.kind, "replayed");
    if (replayed.kind === "replayed") {
      assert.equal(replayed.item.id, knowledge.id);
    }

    // 同键异 hash → conflict（与 createKnowledgeSource 同语义）。
    const conflict = await repo.createKnowledgeFromMedia(
      adminId,
      media.id,
      knowledge,
      "sha-remote-1",
      "different-hash"
    );
    assert.equal(conflict.kind, "conflict");
  }
);
