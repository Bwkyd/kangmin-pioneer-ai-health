import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import type {
  AdminContentItem,
  PublishGuardState
} from "../modules/admin/content-admin-repository.js";
import type {
  ContentCategoryRow,
  ContentMediaRow,
  ContentMessageRow,
  MediaReferenceCounts
} from "../modules/admin/content-aux-repository.js";
import { KangminPgDatabase } from "../infrastructure/postgres/pg-database.js";
import { PgContentAdminRepository } from "../infrastructure/postgres/pg-content-admin-repository.js";
import { PgContentAuxRepository } from "../infrastructure/postgres/pg-content-aux-repository.js";
import { PgContentReadRepository } from "../infrastructure/postgres/pg-content-read-repository.js";
import {
  createPgTestDatabase,
  type PgTestDatabase
} from "./pg-test-database.js";

const databaseUrl = process.env.KANGMIN_TEST_DATABASE_URL;

if (databaseUrl === undefined) {
  test("pg-content-repository 契约测试", { skip: "未配置 KANGMIN_TEST_DATABASE_URL" }, () => {
    // 跳过：未配置 PostgreSQL 连接串。
  });
} else {
  let testDatabase: PgTestDatabase;
  let db: KangminPgDatabase;
  let adminRepo: PgContentAdminRepository;
  let auxRepo: PgContentAuxRepository;
  let readRepo: PgContentReadRepository;
  let planOpenReadRepo: PgContentReadRepository;

  const ADMIN_ID = "admin-1";
  const T0 = "2026-01-01T00:00:00.000Z";

  before(async () => {
    const created = await createPgTestDatabase("pg_content");
    assert.ok(created !== null);
    testDatabase = created;
    db = new KangminPgDatabase(testDatabase.url);
    await db.ready;
    adminRepo = new PgContentAdminRepository(db);
    auxRepo = new PgContentAuxRepository(db);
    readRepo = new PgContentReadRepository(db);
    planOpenReadRepo = new PgContentReadRepository(db, {
      planBrowseEnabled: true
    });
  });

  after(async () => {
    await db.close();
    await testDatabase.close();
  });

  beforeEach(async () => {
    await db.ready;
    // 按外键依赖顺序清库，再重建幂等表依赖的管理员账号。
    await db.query("DELETE FROM agent_plans");
    await db.query("DELETE FROM content_items");
    await db.query("DELETE FROM content_messages");
    await db.query("DELETE FROM agent_knowledge_items");
    await db.query("DELETE FROM content_resource_media");
    await db.query("DELETE FROM content_categories");
    await db.query("DELETE FROM admin_idempotency");
    await db.query("DELETE FROM admin_accounts");
    await db.query(
      `INSERT INTO admin_accounts(id, username, password_hash, role, revision, created_at, updated_at)
       VALUES ($1, $2, 'hash', 'admin', 1, $3, $3)`,
      [ADMIN_ID, "admin1", T0]
    );
  });

  function makeItem(
    id: string,
    overrides: Partial<AdminContentItem> = {}
  ): AdminContentItem {
    return {
      id,
      kind: "article",
      title: `标题${id}`,
      category: "鼻炎科普",
      summary: "摘要",
      body: "正文",
      source: "编辑部",
      status: "draft",
      revision: 1,
      publishedAt: null,
      updatedAt: T0,
      coverMediaId: null,
      mediaId: null,
      instructions: "",
      precautions: "",
      disclaimer: "",
      methodTags: [],
      displayOrder: 0,
      ...overrides
    };
  }

  function makeMedia(
    id: string,
    overrides: Partial<ContentMediaRow> = {}
  ): ContentMediaRow {
    return {
      id,
      kind: "image",
      filename: `${id}.png`,
      storedPath: `/media/${id}.png`,
      sizeBytes: 1024,
      mimeType: "image/png",
      sha256: `sha-${id}`,
      status: "ready",
      failureReason: null,
      createdBy: ADMIN_ID,
      createdAt: T0,
      updatedAt: T0,
      ...overrides
    };
  }

  function makeMessage(
    id: string,
    overrides: Partial<ContentMessageRow> = {}
  ): ContentMessageRow {
    return {
      id,
      title: `公告${id}`,
      body: "公告正文",
      summary: null,
      categoryId: null,
      status: "draft",
      revision: 1,
      publishedAt: null,
      createdBy: ADMIN_ID,
      createdAt: T0,
      updatedAt: T0,
      ...overrides
    };
  }

  async function insertCategory(
    id: string,
    name: string,
    kind: ContentCategoryRow["kind"],
    displayOrder = 0
  ): Promise<void> {
    const result = await auxRepo.createCategory({
      id,
      name,
      kind,
      description: null,
      displayOrder,
      revision: 1,
      createdAt: T0,
      updatedAt: T0
    });
    assert.equal(result, "created");
  }

  interface BrowseItemSeed {
    id: string;
    kind?: "article" | "video";
    title?: string;
    category?: string;
    summary?: string;
    status?: string;
    patientVisible?: number;
    versionValid?: number;
    mediaAvailable?: number;
    publishedAt?: string | null;
    updatedAt?: string;
    mediaId?: string | null;
    coverMediaId?: string | null;
  }

  /** 直接写入浏览端测试数据（默认满足全部公开可见门禁）。 */
  async function insertBrowseItem(seed: BrowseItemSeed): Promise<void> {
    await db.query(
      `INSERT INTO content_items(
        id, kind, title, category, summary, body, source,
        cover_url, media_url, status, patient_visible, version_valid,
        media_available, published_at, updated_at, revision,
        cover_media_id, media_id
      ) VALUES ($1, $2, $3, $4, $5, '正文', '编辑部', NULL, NULL,
                $6, $7, $8, $9, $10, $11, 1, $12, $13)`,
      [
        seed.id,
        seed.kind ?? "article",
        seed.title ?? "公开文章",
        seed.category ?? "鼻炎科普",
        seed.summary ?? "摘要",
        seed.status ?? "published",
        seed.patientVisible ?? 1,
        seed.versionValid ?? 1,
        seed.mediaAvailable ?? 1,
        seed.publishedAt === undefined ? T0 : seed.publishedAt,
        seed.updatedAt ?? T0,
        seed.coverMediaId ?? null,
        seed.mediaId ?? null
      ]
    );
  }

  async function insertPlan(
    id: string,
    name: string,
    status: string,
    displayOrder: number,
    revision: number,
    stepsJson: string
  ): Promise<void> {
    await db.query(
      `INSERT INTO agent_plans(
        id, name, syndrome, method, steps_json, precautions, risks,
        contraindications, display_order, status, revision, created_at, updated_at
      ) VALUES ($1, $2, '肺气虚', '调理概要', $3, '注意', '风险', '禁忌',
                $4, $5, $6, $7, $7)`,
      [id, name, stepsJson, displayOrder, status, revision, T0]
    );
  }

  // ================= ContentAdminRepository =================

  test("admin.create 新建内容：draft 默认值、find/list 读回、methodTags 往返", async () => {
    const item = makeItem("c1", {
      kind: "video",
      methodTags: ["按揉", "热敷"],
      instructions: "每日两次",
      displayOrder: 3
    });
    const outcome = await adminRepo.create(ADMIN_ID, item, "key-c1", "hash-c1");
    assert.deepEqual(outcome, { kind: "created", item });

    const found = await adminRepo.find("video", "c1");
    assert.deepEqual(found, item);
    assert.equal(await adminRepo.find("article", "c1"), null);
    assert.equal(await adminRepo.find("video", "missing"), null);

    assert.deepEqual(await adminRepo.list("video"), [item]);
    assert.deepEqual(await adminRepo.list("video", "published"), []);
    assert.deepEqual(await adminRepo.list("video", "draft"), [item]);
    assert.deepEqual(await adminRepo.list("article"), []);

    // 建库默认值：draft / patient_visible=0 / version_valid=1 /
    // media_available=1 / published_at NULL / revision=1 / created_by=admin。
    const { rows } = await db.query<{
      status: string;
      patient_visible: number;
      version_valid: number;
      media_available: number;
      published_at: string | null;
      revision: number;
      created_by: string;
    }>(
      `SELECT status, patient_visible, version_valid, media_available,
              published_at, revision, created_by
       FROM content_items WHERE id = 'c1'`
    );
    assert.deepEqual(rows[0], {
      status: "draft",
      patient_visible: 0,
      version_valid: 1,
      media_available: 1,
      published_at: null,
      revision: 1,
      created_by: ADMIN_ID
    });
  });

  test("admin.create 幂等重放返回原始记录，不重复插入", async () => {
    const item = makeItem("c2");
    const first = await adminRepo.create(ADMIN_ID, item, "key-c2", "hash-c2");
    assert.equal(first.kind, "created");

    // 同键同 hash：重放返回存储的原内容（原始 id），即使请求体重发。
    const second = await adminRepo.create(ADMIN_ID, item, "key-c2", "hash-c2");
    assert.deepEqual(second, { kind: "replayed", item });

    const { rows } = await db.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM content_items"
    );
    assert.equal(rows[0]?.count, 1);
  });

  test("admin.create 同键异 hash → conflict", async () => {
    const item = makeItem("c3");
    await adminRepo.create(ADMIN_ID, item, "key-c3", "hash-a");
    const outcome = await adminRepo.create(ADMIN_ID, item, "key-c3", "hash-b");
    assert.deepEqual(outcome, { kind: "conflict" });
  });

  test("admin.create 目标已删除的同键重放 → stale_replay（不返回幻影记录）", async () => {
    const item = makeItem("c4");
    await adminRepo.create(ADMIN_ID, item, "key-c4", "hash-c4");
    await db.query("DELETE FROM content_items WHERE id = 'c4'");
    const outcome = await adminRepo.create(ADMIN_ID, item, "key-c4", "hash-c4");
    assert.deepEqual(outcome, { kind: "stale_replay" });
  });

  test("admin.update CAS：not_found / version_conflict / 成功后同步素材 URL", async () => {
    await auxRepo.createMedia(makeMedia("m-cover", { storedPath: "/media/cover.png" }));
    await auxRepo.createMedia(
      makeMedia("m-video", { kind: "video", storedPath: "/media/video.mp4" })
    );
    const item = makeItem("c5", {
      coverMediaId: "m-cover",
      mediaId: "m-video"
    });
    await adminRepo.create(ADMIN_ID, item, "key-c5", "hash-c5");

    const notFound = await adminRepo.update(makeItem("missing"), 1);
    assert.deepEqual(notFound, { kind: "not_found" });

    const conflict = await adminRepo.update(makeItem("c5", { revision: 9 }), 9);
    assert.deepEqual(conflict, { kind: "version_conflict", currentRevision: 1 });

    const publishing = makeItem("c5", {
      status: "published",
      revision: 2,
      publishedAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      coverMediaId: "m-cover",
      mediaId: "m-video",
      title: "更新后的标题"
    });
    const updated = await adminRepo.update(publishing, 1);
    assert.deepEqual(updated, { kind: "updated", item: publishing });

    // 发布置 patient_visible=1，并把 cover_url/media_url 改写为公开媒体
    // 路由 /v1/media/<med_id>（媒体交付链 issue-151，不再落对象键裸键）。
    const { rows } = await db.query<{
      title: string;
      patient_visible: number;
      cover_url: string;
      media_url: string;
      revision: number;
    }>(
      `SELECT title, patient_visible, cover_url, media_url, revision
       FROM content_items WHERE id = 'c5'`
    );
    assert.deepEqual(rows[0], {
      title: "更新后的标题",
      patient_visible: 1,
      cover_url: "/v1/media/m-cover",
      media_url: "/v1/media/m-video",
      revision: 2
    });

    // 已推进到 revision 2，旧 expectedRevision 再写 → 冲突。
    const stale = await adminRepo.update(publishing, 1);
    assert.deepEqual(stale, { kind: "version_conflict", currentRevision: 2 });
  });

  test("admin.updateGuarded：事务内依赖快照 + validation_failed 不写库", async () => {
    await insertCategory("cat-1", "鼻炎科普", "article");
    await auxRepo.createMedia(makeMedia("m-g1"));
    await auxRepo.createMedia(
      makeMedia("m-g2", { kind: "video", status: "processing" })
    );
    const item = makeItem("c6", {
      coverMediaId: "m-g1",
      mediaId: "m-g2"
    });
    await adminRepo.create(ADMIN_ID, item, "key-c6", "hash-c6");

    // guard 收到事务内快照：启用分类、ready 封面、processing 视频素材。
    // （found:false 分支表示引用悬空素材，SQLite/PG 均有外键约束，
    // 正常路径无法造出，属防御性分支，不在此构造。）
    let observed: PublishGuardState | null = null;
    const failed = await adminRepo.updateGuarded(item, 1, (state) => {
      observed = state;
      return state.media !== null &&
        state.media.found &&
        state.media.status !== "ready"
        ? ["media"]
        : [];
    });
    assert.deepEqual(failed, { kind: "validation_failed", missing: ["media"] });
    assert.deepEqual(observed, {
      category: { status: "active", kind: "article" },
      coverMedia: { found: true, status: "ready", kind: "image" },
      media: { found: true, status: "processing", kind: "video" },
      bodyMedia: []
    });
    // validation_failed 整体回滚：行保持 draft。
    assert.equal((await adminRepo.find("article", "c6"))?.status, "draft");

    // guard 放行 → 正常更新。
    const publishing = makeItem("c6", {
      status: "published",
      revision: 2,
      publishedAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z"
    });
    const updated = await adminRepo.updateGuarded(publishing, 1, () => []);
    assert.deepEqual(updated, { kind: "updated", item: publishing });

    assert.deepEqual(await adminRepo.updateGuarded(publishing, 5, () => []), {
      kind: "version_conflict",
      currentRevision: 2
    });
    assert.deepEqual(await adminRepo.updateGuarded(makeItem("missing"), 1, () => []), {
      kind: "not_found"
    });
  });

  test("admin.updateGuarded 停用分类被 guard 拒绝", async () => {
    await insertCategory("cat-2", "已停用分类", "article");
    assert.equal(await auxRepo.disableCategory("cat-2", 1, T0), "updated");
    const item = makeItem("c7", { category: "已停用分类" });
    await adminRepo.create(ADMIN_ID, item, "key-c7", "hash-c7");

    const result = await adminRepo.updateGuarded(item, 1, (state) =>
      state.category?.status === "disabled" ? ["category"] : []
    );
    assert.deepEqual(result, { kind: "validation_failed", missing: ["category"] });
  });

  test("admin 并发 CAS：同 expectedRevision 并发更新只有一个成功", async () => {
    const item = makeItem("c8");
    await adminRepo.create(ADMIN_ID, item, "key-c8", "hash-c8");
    const a = makeItem("c8", { title: "A", revision: 2 });
    const b = makeItem("c8", { title: "B", revision: 2 });
    const results = await Promise.all([
      adminRepo.updateGuarded(a, 1, () => []),
      adminRepo.updateGuarded(b, 1, () => [])
    ]);
    const kinds = results.map((result) => result.kind).sort();
    assert.deepEqual(kinds, ["updated", "version_conflict"]);
  });

  // ================= ContentAuxRepository：分类 =================

  test("aux 分类：创建/重名/查询/排序与 kind 过滤", async () => {
    await insertCategory("cat-b", "乙类", "article", 2);
    await insertCategory("cat-a", "甲类", "article", 1);
    await insertCategory("cat-g", "通用", "general", 0);

    // 重名（唯一约束）→ name_taken；同 id 不同名同样冲突。
    assert.equal(
      await auxRepo.createCategory({
        id: "cat-c",
        name: "甲类",
        kind: "article",
        description: null,
        displayOrder: 9,
        revision: 1,
        createdAt: T0,
        updatedAt: T0
      }),
      "name_taken"
    );

    const byName = await auxRepo.findCategoryByName("甲类");
    assert.equal(byName?.id, "cat-a");
    assert.equal(byName?.status, "active");
    const byId = await auxRepo.findCategoryById("cat-b");
    assert.equal(byId?.name, "乙类");
    assert.equal(await auxRepo.findCategoryById("missing"), null);
    assert.equal(await auxRepo.findCategoryByName("missing"), null);

    // display_order ASC, name ASC；kind 过滤。
    assert.deepEqual(
      (await auxRepo.listCategories()).map((row) => row.name),
      ["通用", "甲类", "乙类"]
    );
    assert.deepEqual(
      (await auxRepo.listCategories("article")).map((row) => row.name),
      ["甲类", "乙类"]
    );
  });

  test("aux.updateCategory：CAS、COALESCE 部分更新、重名、停用后拒绝", async () => {
    await insertCategory("cat-u", "原名", "article");
    await insertCategory("cat-v", "占位", "video");

    assert.equal(await auxRepo.updateCategory("missing", 1, {}, T0), "not_found");
    assert.equal(
      await auxRepo.updateCategory("cat-u", 9, { name: "新名" }, T0),
      "version_conflict"
    );

    // 只改 name：description/displayOrder 保持原值（COALESCE 语义），revision+1。
    assert.equal(
      await auxRepo.updateCategory("cat-u", 1, { name: "新名" }, "2026-01-03T00:00:00.000Z"),
      "updated"
    );
    const renamed = await auxRepo.findCategoryById("cat-u");
    assert.equal(renamed?.name, "新名");
    assert.equal(renamed?.displayOrder, 0);
    assert.equal(renamed?.revision, 2);
    assert.equal(renamed?.updatedAt, "2026-01-03T00:00:00.000Z");

    // 改名为已占用名称 → name_taken，且不回写。
    assert.equal(
      await auxRepo.updateCategory("cat-u", 2, { name: "占位" }, T0),
      "name_taken"
    );
    assert.equal((await auxRepo.findCategoryById("cat-u"))?.name, "新名");

    // 停用后 updateCategory 一律 version_conflict。
    assert.equal(await auxRepo.disableCategory("cat-u", 2, T0), "updated");
    assert.equal(
      await auxRepo.updateCategory("cat-u", 3, { name: "再改" }, T0),
      "version_conflict"
    );
  });

  test("aux.disableCategory：CAS 与重复停用", async () => {
    await insertCategory("cat-d", "待停用", "article");
    assert.equal(await auxRepo.disableCategory("missing", 1, T0), "not_found");
    assert.equal(await auxRepo.disableCategory("cat-d", 9, T0), "version_conflict");
    assert.equal(await auxRepo.disableCategory("cat-d", 1, T0), "updated");
    const disabled = await auxRepo.findCategoryById("cat-d");
    assert.equal(disabled?.status, "disabled");
    assert.equal(disabled?.revision, 2);
    // 已停用再停用 → version_conflict。
    assert.equal(await auxRepo.disableCategory("cat-d", 2, T0), "version_conflict");
  });

  // ================= ContentAuxRepository：素材 =================

  test("aux 素材：createMedia / findMedia / listMedia 排序", async () => {
    await auxRepo.createMedia(
      makeMedia("m-1", { createdAt: "2026-01-01T00:00:00.000Z" })
    );
    await auxRepo.createMedia(
      makeMedia("m-2", { createdAt: "2026-01-02T00:00:00.000Z" })
    );
    const found = await auxRepo.findMedia("m-1");
    assert.equal(found?.storedPath, "/media/m-1.png");
    assert.equal(await auxRepo.findMedia("missing"), null);
    // created_at DESC, id ASC。
    assert.deepEqual(
      (await auxRepo.listMedia()).map((row) => row.id),
      ["m-2", "m-1"]
    );
  });

  test("aux.createMediaIdempotent：created / replayed / conflict / stale_replay", async () => {
    const media = makeMedia("m-i1");
    const created = await auxRepo.createMediaIdempotent(ADMIN_ID, media, "fp-1", "hash-1");
    assert.deepEqual(created, { kind: "created", item: media });

    // 同指纹重传 → 重放返回原素材，不重复登记。
    const replayed = await auxRepo.createMediaIdempotent(ADMIN_ID, media, "fp-1", "hash-1");
    assert.deepEqual(replayed, { kind: "replayed", item: media });
    assert.equal((await auxRepo.listMedia()).length, 1);

    const conflict = await auxRepo.createMediaIdempotent(ADMIN_ID, media, "fp-1", "hash-other");
    assert.deepEqual(conflict, { kind: "conflict" });

    // 素材被删后同键重放 → stale_replay。
    await db.query("DELETE FROM content_resource_media WHERE id = 'm-i1'");
    const stale = await auxRepo.createMediaIdempotent(ADMIN_ID, media, "fp-1", "hash-1");
    assert.deepEqual(stale, { kind: "stale_replay" });
  });

  test("aux.countMediaReferences/listMediaReferences：同时返回全状态计数与引用去向", async () => {
    await auxRepo.createMedia(makeMedia("m-r1"));
    // 已发布内容引用（计入）。
    await insertBrowseItem({ id: "pub-1", mediaId: "m-r1" });
    // 草稿内容引用（不计入）。
    await insertBrowseItem({ id: "draft-1", status: "draft", mediaId: "m-r1" });
    // 封面与正文附件引用也必须进入同一权威读模型与删除保护。
    await insertBrowseItem({ id: "cover-1", coverMediaId: "m-r1" });
    await insertBrowseItem({ id: "body-1" });
    await db.query(
      "UPDATE content_items SET body = '/v1/media/m-r1' WHERE id = 'body-1'"
    );
    // 已启用知识引用（计入）。
    await db.query(
      `INSERT INTO agent_knowledge_items(
        id, name, source_media_id, size_bytes, status, created_at, updated_at
      ) VALUES ('k-1', '知识1', 'm-r1', 10, 'enabled', $1, $1)`,
      [T0]
    );
    // 停用知识引用（不计入）。
    await db.query(
      `INSERT INTO agent_knowledge_items(
        id, name, source_media_id, size_bytes, status, created_at, updated_at
      ) VALUES ('k-2', '知识2', 'm-r1', 10, 'disabled', $1, $1)`,
      [T0]
    );

    assert.deepEqual(await auxRepo.countMediaReferences("m-r1"), {
      contentResources: 4,
      knowledgeItems: 2,
      publishedResources: 3,
      enabledKnowledge: 1,
      // 方案引用视频内容（content_items），不直接引用素材。
      enabledPlans: 0
    });
    assert.deepEqual(await auxRepo.listMediaReferences(), [
      { mediaId: "m-r1", entityType: "article", entityId: "body-1", name: "公开文章", status: "published", role: "body" },
      { mediaId: "m-r1", entityType: "article", entityId: "cover-1", name: "公开文章", status: "published", role: "cover" },
      { mediaId: "m-r1", entityType: "article", entityId: "draft-1", name: "公开文章", status: "draft", role: "file" },
      { mediaId: "m-r1", entityType: "article", entityId: "pub-1", name: "公开文章", status: "published", role: "file" },
      { mediaId: "m-r1", entityType: "knowledge", entityId: "k-1", name: "知识1", status: "enabled", role: "knowledge_source" },
      { mediaId: "m-r1", entityType: "knowledge", entityId: "k-2", name: "知识2", status: "disabled", role: "knowledge_source" }
    ]);
  });

  test("aux.disableMediaGuarded：not_found / validation_failed / updated 清失败原因", async () => {
    const noReferences = (counts: MediaReferenceCounts): string[] =>
      counts.publishedResources + counts.enabledKnowledge + counts.enabledPlans > 0
        ? ["referenced"]
        : [];

    assert.deepEqual(
      await auxRepo.disableMediaGuarded("missing", T0, noReferences),
      { kind: "not_found" }
    );

    await auxRepo.createMedia(makeMedia("m-d1"));
    await insertBrowseItem({ id: "pub-d1", coverMediaId: "m-d1" });
    const blocked = await auxRepo.disableMediaGuarded("m-d1", T0, noReferences);
    assert.deepEqual(blocked, { kind: "validation_failed", missing: ["referenced"] });
    // 回滚：素材仍 ready。
    assert.equal((await auxRepo.findMedia("m-d1"))?.status, "ready");

    await auxRepo.createMedia(
      makeMedia("m-d2", { status: "failed", failureReason: "转码失败" })
    );
    const updated = await auxRepo.disableMediaGuarded(
      "m-d2",
      "2026-01-04T00:00:00.000Z",
      noReferences
    );
    assert.equal(updated.kind, "updated");
    if (updated.kind === "updated") {
      assert.equal(updated.media.status, "disabled");
      assert.equal(updated.media.updatedAt, "2026-01-04T00:00:00.000Z");
    }
    const after = await auxRepo.findMedia("m-d2");
    assert.equal(after?.status, "disabled");
    assert.equal(after?.failureReason, null);
  });

  test("aux.deleteMediaGuarded：任一状态的业务引用都拦截删除", async () => {
    const noReferences = (counts: MediaReferenceCounts): string[] =>
      counts.contentResources + counts.knowledgeItems > 0
        ? ["referenced"]
        : [];

    assert.deepEqual(await auxRepo.deleteMediaGuarded("missing", noReferences), {
      kind: "not_found"
    });

    await auxRepo.createMedia(makeMedia("m-x1"));
    await insertBrowseItem({ id: "pub-x1", mediaId: "m-x1" });
    assert.deepEqual(await auxRepo.deleteMediaGuarded("m-x1", noReferences), {
      kind: "validation_failed",
      missing: ["referenced"]
    });
    assert.notEqual(await auxRepo.findMedia("m-x1"), null);

    // 草稿内容与停用知识也必须先由业务任务显式解除引用。
    await auxRepo.createMedia(makeMedia("m-x2"));
    await insertBrowseItem({
      id: "draft-x2",
      status: "draft",
      mediaId: "m-x2",
      coverMediaId: "m-x2"
    });
    await db.query(
      `INSERT INTO agent_knowledge_items(
        id, name, source_media_id, size_bytes, status, created_at, updated_at
      ) VALUES ('k-x2', '知识', 'm-x2', 10, 'disabled', $1, $1)`,
      [T0]
    );
    assert.deepEqual(await auxRepo.deleteMediaGuarded("m-x2", noReferences), {
      kind: "validation_failed",
      missing: ["referenced"]
    });
    assert.notEqual(await auxRepo.findMedia("m-x2"), null);
    const { rows: itemRows } = await db.query<{
      media_id: string | null;
      cover_media_id: string | null;
      status: string;
    }>("SELECT media_id, cover_media_id, status FROM content_items WHERE id = 'draft-x2'");
    assert.deepEqual(itemRows[0], {
      media_id: "m-x2",
      cover_media_id: "m-x2",
      status: "draft"
    });
    const { rows: knowledgeRows } = await db.query<{
      source_media_id: string | null;
    }>("SELECT source_media_id FROM agent_knowledge_items WHERE id = 'k-x2'");
    assert.equal(knowledgeRows[0]?.source_media_id, "m-x2");
    await db.query("UPDATE content_items SET media_id = NULL, cover_media_id = NULL WHERE id = 'draft-x2'");
    await db.query("UPDATE agent_knowledge_items SET source_media_id = NULL WHERE id = 'k-x2'");
    assert.deepEqual(await auxRepo.deleteMediaGuarded("m-x2", noReferences), { kind: "deleted" });
    assert.equal(await auxRepo.findMedia("m-x2"), null);
  });

  // ================= ContentAuxRepository：公告 =================

  test("aux 公告：创建/查询/列表过滤与排序", async () => {
    await auxRepo.createMessage(
      makeMessage("msg-1", { updatedAt: "2026-01-01T00:00:00.000Z" })
    );
    await auxRepo.createMessage(
      makeMessage("msg-2", {
        status: "published",
        publishedAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z"
      })
    );
    assert.equal((await auxRepo.findMessage("msg-1"))?.title, "公告msg-1");
    assert.equal(await auxRepo.findMessage("missing"), null);
    // updated_at DESC, id ASC。
    assert.deepEqual(
      (await auxRepo.listMessages()).map((row) => row.id),
      ["msg-2", "msg-1"]
    );
    assert.deepEqual(
      (await auxRepo.listMessages("published")).map((row) => row.id),
      ["msg-2"]
    );
  });

  test("aux.createMessageIdempotent：created / replayed / conflict / stale_replay", async () => {
    const message = makeMessage("msg-i1");
    const created = await auxRepo.createMessageIdempotent(ADMIN_ID, message, "mk-1", "mh-1");
    assert.deepEqual(created, { kind: "created", item: message });

    const replayed = await auxRepo.createMessageIdempotent(ADMIN_ID, message, "mk-1", "mh-1");
    assert.deepEqual(replayed, { kind: "replayed", item: message });
    assert.equal((await auxRepo.listMessages()).length, 1);

    const conflict = await auxRepo.createMessageIdempotent(ADMIN_ID, message, "mk-1", "mh-x");
    assert.deepEqual(conflict, { kind: "conflict" });

    await db.query("DELETE FROM content_messages WHERE id = 'msg-i1'");
    const stale = await auxRepo.createMessageIdempotent(ADMIN_ID, message, "mk-1", "mh-1");
    assert.deepEqual(stale, { kind: "stale_replay" });
  });

  test("aux.updateMessage CAS 与 setMessageStatus revision 自增", async () => {
    await auxRepo.createMessage(makeMessage("msg-u1"));

    assert.deepEqual(await auxRepo.updateMessage(makeMessage("missing"), 1), {
      kind: "not_found"
    });
    assert.deepEqual(await auxRepo.updateMessage(makeMessage("msg-u1"), 9), {
      kind: "version_conflict",
      currentRevision: 1
    });

    const editing = makeMessage("msg-u1", { title: "改后标题", revision: 2 });
    assert.deepEqual(await auxRepo.updateMessage(editing, 1), {
      kind: "updated",
      message: editing
    });

    // setMessageStatus：revision 自增并返回事务内重读的最新行。
    const published = await auxRepo.setMessageStatus(
      "msg-u1",
      2,
      "published",
      "2026-01-05T00:00:00.000Z",
      "2026-01-05T00:00:00.000Z"
    );
    assert.equal(published.kind, "updated");
    if (published.kind === "updated") {
      assert.equal(published.message.status, "published");
      assert.equal(published.message.revision, 3);
      assert.equal(published.message.publishedAt, "2026-01-05T00:00:00.000Z");
      assert.equal(published.message.title, "改后标题");
    }

    assert.deepEqual(
      await auxRepo.setMessageStatus("msg-u1", 2, "unpublished", null, T0),
      { kind: "version_conflict", currentRevision: 3 }
    );
    assert.deepEqual(
      await auxRepo.setMessageStatus("missing", 1, "published", T0, T0),
      { kind: "not_found" }
    );
  });

  // ================= ContentReadRepository =================

  test("read.list/find 只返回已发布且全部可见门禁就绪的内容", async () => {
    await insertBrowseItem({ id: "ok-1" });
    await insertBrowseItem({ id: "draft-1", status: "draft" });
    await insertBrowseItem({ id: "unpub-1", status: "unpublished" });
    await insertBrowseItem({ id: "invisible-1", patientVisible: 0 });
    await insertBrowseItem({ id: "stale-1", versionValid: 0 });
    await insertBrowseItem({ id: "nomedia-1", mediaAvailable: 0 });
    await insertBrowseItem({ id: "nodate-1", publishedAt: null });

    assert.deepEqual(
      (await readRepo.list("article")).map((row) => row.id),
      ["ok-1"]
    );
    assert.equal((await readRepo.find("article", "ok-1"))?.id, "ok-1");
    assert.equal(await readRepo.find("article", "draft-1"), null);
    assert.equal(await readRepo.find("video", "ok-1"), null);

    // 浏览端投影附带固定免责声明。
    const visible = await readRepo.find("article", "ok-1");
    assert.equal(
      visible?.disclaimer,
      "本内容仅作健康科普和居家管理参考，不代替门诊诊断和专业医疗建议。"
    );
  });

  test("read.list/listPage 按 updated_at DESC, id ASC 排序并分页", async () => {
    await insertBrowseItem({ id: "p-1", updatedAt: "2026-01-01T00:00:00.000Z" });
    await insertBrowseItem({ id: "p-2", updatedAt: "2026-01-03T00:00:00.000Z" });
    await insertBrowseItem({ id: "p-3", updatedAt: "2026-01-02T00:00:00.000Z" });

    assert.deepEqual(
      (await readRepo.list("article")).map((row) => row.id),
      ["p-2", "p-3", "p-1"]
    );
    assert.deepEqual(
      (await readRepo.listPage("article", 2, 0)).map((row) => row.id),
      ["p-2", "p-3"]
    );
    assert.deepEqual(
      (await readRepo.listPage("article", 2, 2)).map((row) => row.id),
      ["p-1"]
    );
    assert.deepEqual(await readRepo.listPage("article", 2, 3), []);
  });

  test("read.search：标题/分类/摘要匹配、通配符转义、ASCII 大小写不敏感", async () => {
    await insertBrowseItem({
      id: "s-1",
      title: "鼻炎 100% 缓解",
      category: "鼻炎科普",
      summary: "居家护理"
    });
    await insertBrowseItem({
      id: "s-2",
      title: "ABC 鼻炎指南",
      category: "健康",
      summary: "科普"
    });
    await insertBrowseItem({
      id: "s-3",
      title: "鼻炎草稿",
      status: "draft"
    });

    // 命中标题。
    assert.deepEqual(
      (await readRepo.search("article", "缓解")).map((row) => row.id),
      ["s-1"]
    );
    // 命中分类。
    assert.deepEqual(
      (await readRepo.search("article", "健康")).map((row) => row.id),
      ["s-2"]
    );
    // 命中摘要。
    assert.deepEqual(
      (await readRepo.search("article", "居家")).map((row) => row.id),
      ["s-1"]
    );
    // % 按字面处理（likePatternOf 转义通配符），不匹配任意串。
    assert.deepEqual(
      (await readRepo.search("article", "100%")).map((row) => row.id),
      ["s-1"]
    );
    // SQLite LIKE 默认 ASCII 大小写不敏感，PG 侧用 ILIKE 对齐。
    assert.deepEqual(
      (await readRepo.search("article", "abc")).map((row) => row.id),
      ["s-2"]
    );
    // 未发布内容不可见。
    assert.deepEqual(await readRepo.search("article", "草稿"), []);
  });

  test("read.categories：启用分类 + general 通用，按 display_order/name 排序", async () => {
    await insertCategory("cat-r1", "鼻炎科普", "article", 1);
    await insertCategory("cat-r2", "基础", "general", 0);
    await insertCategory("cat-r3", "视频精选", "video", 0);
    await insertCategory("cat-r4", "已停用", "article", 0);
    assert.equal(await auxRepo.disableCategory("cat-r4", 1, T0), "updated");

    assert.deepEqual(await readRepo.categories("article"), ["基础", "鼻炎科普"]);
    assert.deepEqual(await readRepo.categories("video"), ["基础", "视频精选"]);
  });

  test("read 方案双门禁：planBrowseEnabled=false 时全部短路为空", async () => {
    await insertPlan("plan-1", "儿童鼻炎调理", "enabled", 0, 1, '["步骤一"]');
    assert.deepEqual(await readRepo.listPlans(), []);
    assert.equal(await readRepo.findPlan("plan-1"), null);
    assert.deepEqual(await readRepo.searchPlans("鼻炎", 10), []);
  });

  test("read 方案：仅 enabled 可见，排序 display_order ASC, id ASC", async () => {
    await insertPlan("plan-1", "儿童鼻炎调理", "enabled", 1, 3, '["步骤一", "步骤二"]');
    await insertPlan("plan-2", "成人鼻炎方案", "enabled", 0, 1, "[]");
    await insertPlan("plan-3", "草稿方案", "draft", 0, 1, "[]");

    assert.deepEqual(
      (await planOpenReadRepo.listPlans()).map((row) => row.id),
      ["plan-2", "plan-1"]
    );
    assert.deepEqual(await planOpenReadRepo.listPlans(), [
      { id: "plan-2", name: "成人鼻炎方案", publishedRevision: 1 },
      { id: "plan-1", name: "儿童鼻炎调理", publishedRevision: 3 }
    ]);
    assert.equal(await planOpenReadRepo.findPlan("plan-3"), null);
    assert.equal(await planOpenReadRepo.findPlan("missing"), null);
  });

  test("read.findPlan 详情：string[] 与对象数组两种 steps_json 格式兼容", async () => {
    // 历史契约：string[] 按顺序映射为 {step: i+1, title}。
    await insertPlan("plan-a", "方案A", "enabled", 0, 3, '["步骤一", "步骤二"]');
    const legacy = await planOpenReadRepo.findPlan("plan-a");
    assert.deepEqual(legacy?.steps, [
      { step: 1, title: "步骤一" },
      { step: 2, title: "步骤二" }
    ]);
    assert.equal(legacy?.summary, "调理概要");
    assert.equal(legacy?.publishedRevision, 3);
    // 临床字段投影（issue-151）：precautions/risks/contraindications
    // 原样透出；无视频引用为 null。
    assert.equal(legacy?.precautions, "注意");
    assert.equal(legacy?.risks, "风险");
    assert.equal(legacy?.contraindications, "禁忌");
    assert.equal(legacy?.videoResourceId, null);
    assert.equal(
      legacy?.disclaimer,
      "本内容仅作健康科普和居家管理参考，不代替门诊诊断和专业医疗建议。"
    );

    // 当前格式：合法对象保留、非法条目丢弃、string 项按原始下标映射。
    await insertPlan(
      "plan-b",
      "方案B",
      "enabled",
      1,
      2,
      '[{"step": 1, "title": "第一步", "description": "d"}, {"bad": true}, "后续"]'
    );
    const current = await planOpenReadRepo.findPlan("plan-b");
    assert.deepEqual(current?.steps, [
      { step: 1, title: "第一步", description: "d" },
      { step: 3, title: "后续" }
    ]);

    // 有视频引用的方案透出 videoResourceId。
    await insertBrowseItem({ id: "video-for-plan", kind: "video" });
    await db.query(
      `INSERT INTO agent_plans(
        id, name, syndrome, method, steps_json, precautions, risks,
        contraindications, video_resource_id, display_order, status,
        revision, created_at, updated_at
      ) VALUES ('plan-video', '带视频方案', '肺气虚', '调理概要', '["步骤一"]',
                '注意B', '风险B', '禁忌B', 'video-for-plan', 2, 'enabled',
                1, $1, $1)`,
      [T0]
    );
    const withVideo = await planOpenReadRepo.findPlan("plan-video");
    assert.equal(withVideo?.videoResourceId, "video-for-plan");
    assert.equal(withVideo?.precautions, "注意B");
    assert.equal(withVideo?.risks, "风险B");
    assert.equal(withVideo?.contraindications, "禁忌B");

    // steps_json 解析失败回退空列表，绝不宽松解析。
    await insertPlan("plan-c", "方案C", "enabled", 2, 1, "not-json");
    assert.deepEqual((await planOpenReadRepo.findPlan("plan-c"))?.steps, []);
  });

  test("read.searchPlans：名称匹配 + limit 截断 + 通配符转义", async () => {
    await insertPlan("plan-s1", "儿童鼻炎调理", "enabled", 1, 1, "[]");
    await insertPlan("plan-s2", "成人鼻炎方案", "enabled", 0, 1, "[]");
    await insertPlan("plan-s3", "鼻炎草稿", "draft", 0, 1, "[]");

    assert.deepEqual(
      (await planOpenReadRepo.searchPlans("鼻炎", 10)).map((row) => row.id),
      ["plan-s2", "plan-s1"]
    );
    // limit 截断（按 display_order ASC, id ASC 取前 N 条）。
    assert.deepEqual(
      (await planOpenReadRepo.searchPlans("鼻炎", 1)).map((row) => row.id),
      ["plan-s2"]
    );
    assert.deepEqual(await planOpenReadRepo.searchPlans("儿童", 10).then((rows) => rows.map((row) => row.id)), ["plan-s1"]);
    // 草稿不可见；% 字面匹配。
    assert.deepEqual(await planOpenReadRepo.searchPlans("草稿", 10), []);
    assert.deepEqual(await planOpenReadRepo.searchPlans("%", 10), []);
  });

  test("read.findPublishedMedia：仅 published 引用可见，素材状态原样返回（issue-151）", async () => {
    await auxRepo.createMedia(makeMedia("m-pub"));
    await auxRepo.createMedia(makeMedia("m-cover-pub"));
    await auxRepo.createMedia(makeMedia("m-draft"));
    await auxRepo.createMedia(makeMedia("m-disabled", { status: "disabled" }));
    await insertBrowseItem({ id: "item-published", kind: "video", mediaId: "m-pub", coverMediaId: "m-cover-pub" });
    await insertBrowseItem({ id: "item-draft", status: "draft", mediaId: "m-draft" });
    await insertBrowseItem({ id: "item-disabled-media", mediaId: "m-disabled" });

    // media_id 与 cover_media_id 两种引用都可命中。
    const found = await readRepo.findPublishedMedia("m-pub");
    assert.deepEqual(found, {
      storedPath: "/media/m-pub.png",
      mimeType: "image/png",
      status: "ready"
    });
    assert.equal(
      (await readRepo.findPublishedMedia("m-cover-pub"))?.storedPath,
      "/media/m-cover-pub.png"
    );

    // 仅被草稿引用 / 不存在 → null（不泄露存在性）。
    assert.equal(await readRepo.findPublishedMedia("m-draft"), null);
    assert.equal(await readRepo.findPublishedMedia("m-missing"), null);

    // 素材被停用但仍有 published 引用：行返回且状态原样（disabled），
    // 可用性门禁留给服务层（非 ready 不服务）。
    assert.equal((await readRepo.findPublishedMedia("m-disabled"))?.status, "disabled");
  });

  test("迁移 0002：裸键存量改写为 /v1/media/<id>，无引用行不触碰（issue-151）", async () => {
    await auxRepo.createMedia(makeMedia("m-old-cover"));
    await auxRepo.createMedia(makeMedia("m-old-video", { kind: "video" }));
    // 模拟 0002 前的旧数据：cover_url/media_url 落对象键裸键（stored_path）。
    await db.query(
      `INSERT INTO content_items(
        id, kind, title, category, summary, body, source,
        cover_url, media_url, status, patient_visible, version_valid,
        media_available, published_at, updated_at, revision,
        cover_media_id, media_id
      ) VALUES ('legacy-item', 'video', '旧内容', '鼻炎科普', '摘要', '正文',
                '编辑部', '/media/m-old-cover.png', '/media/m-old-video.mp4',
                'published', 1, 1, 1, $1, $1, 1, 'm-old-cover', 'm-old-video'),
               ('legacy-free', 'article', '自由文本', '鼻炎科普', '摘要', '正文',
                '编辑部', 'https://example.invalid/x.jpg', NULL,
                'published', 1, 1, 1, $1, $1, 1, NULL, NULL)`,
      [T0]
    );
    // 回退账本模拟旧库：0002 未应用，重开连接触发迁移重放。
    await db.query(
      "DELETE FROM schema_migrations WHERE version = '0002_content_media_public_urls'"
    );
    const remigrated = new KangminPgDatabase(testDatabase.url);
    try {
      await remigrated.ready;
      const { rows } = await remigrated.query<{
        id: string;
        cover_url: string | null;
        media_url: string | null;
      }>(
        "SELECT id, cover_url, media_url FROM content_items ORDER BY id ASC"
      );
      assert.deepEqual(rows, [
        {
          id: "legacy-free",
          cover_url: "https://example.invalid/x.jpg",
          media_url: null
        },
        {
          id: "legacy-item",
          cover_url: "/v1/media/m-old-cover",
          media_url: "/v1/media/m-old-video"
        }
      ]);
    } finally {
      await remigrated.close();
    }
  });

  // ---- 远程上传会话（upload-init / confirm / cleanup-orphans 的仓储语义） ----

  test("aux.findMediaBySha256：ready 优先于 processing，processing 优先于 failed", async () => {
    await auxRepo.createMediaDraft(ADMIN_ID, makeMedia("m-sha-failed", {
      sha256: "sha-dup",
      status: "failed",
      createdAt: "2026-01-01T00:00:00.000Z"
    }));
    await auxRepo.createMediaDraft(ADMIN_ID, makeMedia("m-sha-processing", {
      sha256: "sha-dup",
      status: "processing",
      createdAt: "2026-01-02T00:00:00.000Z"
    }));
    // 无 ready 行：取 processing（中断重试重发票据的那一行）。
    const processing = await auxRepo.findMediaBySha256("sha-dup");
    assert.equal(processing?.id, "m-sha-processing");

    await auxRepo.createMediaDraft(ADMIN_ID, makeMedia("m-sha-ready", {
      sha256: "sha-dup",
      status: "ready",
      createdAt: "2026-01-03T00:00:00.000Z"
    }));
    // 有 ready 行：无论创建先后都优先（重复上传重放 completed）。
    const ready = await auxRepo.findMediaBySha256("sha-dup");
    assert.equal(ready?.id, "m-sha-ready");
    assert.equal(await auxRepo.findMediaBySha256("sha-missing"), null);
  });

  test("aux.createMediaDraft：processing 直入，不写 admin_idempotency", async () => {
    const media = makeMedia("m-draft-1", { status: "processing" });
    await auxRepo.createMediaDraft(ADMIN_ID, media);
    assert.deepEqual(await auxRepo.findMedia("m-draft-1"), media);
    const { rows } = await db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM admin_idempotency"
    );
    assert.equal(rows[0]?.n, 0);
  });

  test("aux.transitionMediaStatus：CAS 命中 updated；谓词不命中 version_conflict；缺失 not_found", async () => {
    await auxRepo.createMediaDraft(ADMIN_ID, makeMedia("m-cas-1", { status: "processing" }));
    const updated = await auxRepo.transitionMediaStatus("m-cas-1", "processing", {
      status: "ready",
      failureReason: null,
      updatedAt: "2026-01-02T00:00:00.000Z"
    });
    assert.equal(updated, "updated");
    const row = await auxRepo.findMedia("m-cas-1");
    assert.equal(row?.status, "ready");
    assert.equal(row?.failureReason, null);
    assert.equal(row?.updatedAt, "2026-01-02T00:00:00.000Z");

    // 已转 ready：再以 processing 作谓词 → version_conflict，状态不被覆盖。
    const conflict = await auxRepo.transitionMediaStatus("m-cas-1", "processing", {
      status: "failed",
      failureReason: "上传内容校验失败",
      updatedAt: T0
    });
    assert.equal(conflict, "version_conflict");
    assert.equal((await auxRepo.findMedia("m-cas-1"))?.status, "ready");

    assert.equal(
      await auxRepo.transitionMediaStatus("m-missing", "processing", {
        status: "ready",
        failureReason: null,
        updatedAt: T0
      }),
      "not_found"
    );
  });

  test("aux.listStaleProcessingMedia + deleteMediaRow：阈值过滤与物理删除", async () => {
    await auxRepo.createMediaDraft(ADMIN_ID, makeMedia("m-stale", {
      status: "processing",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }));
    await auxRepo.createMediaDraft(ADMIN_ID, makeMedia("m-fresh", {
      status: "processing",
      updatedAt: "2026-01-03T00:00:00.000Z"
    }));
    // ready 行即使更旧也不在孤儿清理范围。
    await auxRepo.createMediaDraft(ADMIN_ID, makeMedia("m-ready-old", {
      status: "ready",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }));
    const stale = await auxRepo.listStaleProcessingMedia("2026-01-02T00:00:00.000Z");
    assert.deepEqual(stale.map((row) => row.id), ["m-stale"]);

    await auxRepo.deleteMediaRow("m-stale");
    assert.equal(await auxRepo.findMedia("m-stale"), null);
    assert.deepEqual(
      (await auxRepo.listStaleProcessingMedia("2026-01-02T00:00:00.000Z")).map((row) => row.id),
      []
    );
  });
}
