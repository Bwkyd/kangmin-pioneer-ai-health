import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ARTICLE_CATEGORY_REGISTRY,
  VIDEO_CATEGORY_REGISTRY,
  VIDEO_TRUTH_ASSIGNMENTS
} from "@kangmin/core/operations/admin/content-category-registry";
import { KangminDatabase } from "../infrastructure/database.js";
import { SqliteContentReadRepository } from "../infrastructure/sqlite-content-read-repository.js";

test("视频分类注册表使用稳定树路径且只有叶节点可选择", () => {
  assert.equal(VIDEO_CATEGORY_REGISTRY.length, 19);
  const byId = new Map(VIDEO_CATEGORY_REGISTRY.map((node) => [node.id, node]));
  assert.equal(byId.get("video-adult")?.parentId, null);
  assert.equal(byId.get("video-adult-lung-qi-cold")?.parentId, "video-adult-conditioning");
  assert.equal(byId.get("video-child-conditioning-content")?.audience, "child");
  assert.ok(VIDEO_CATEGORY_REGISTRY.filter((node) => node.selectable).every((node) => node.nodeType === "leaf"));
});

test("文章仅有作者确认的科普文章分类，时间不进入分类树", () => {
  assert.deepEqual(ARTICLE_CATEGORY_REGISTRY, [{
    id: "article-general",
    kind: "article",
    parentId: null,
    name: "科普文章",
    audience: "all",
    nodeType: "leaf",
    selectable: true,
    displayOrder: 0
  }]);
});

test("truth 多分类映射显式保留且不跨成人儿童扩散", () => {
  const byTitle = new Map(VIDEO_TRUTH_ASSIGNMENTS.map((item) => [item.title, item.categoryIds]));
  assert.deepEqual(byTitle.get("抗敏要穴之息风止敏--耳穴过敏区"), [
    "video-adult-lung-qi-cold",
    "video-adult-spleen-qi",
    "video-adult-kidney-yang",
    "video-adult-lung-heat",
    "video-adult-mixed"
  ]);
  assert.deepEqual(byTitle.get("鼻三线姜刮"), ["video-child-quick-content"]);
  assert.deepEqual(byTitle.get("抗敏要穴之姜行通窍--鼻三线姜刮"), ["video-adult-quick-content"]);
});

test("SQLite 迁移建立分类树：文章唯一匹配自动迁移，未知值进入待确认报告", () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), "km-category-registry-")), "test.sqlite");
  let database = new KangminDatabase(databasePath);
  const insert = database.connection.prepare(`
    INSERT INTO content_items(
      id, kind, title, category, summary, body, source,
      cover_url, media_url, status, patient_visible,
      version_valid, media_available, published_at, updated_at
    ) VALUES (?, ?, ?, ?, '', NULL, '', NULL, NULL, 'draft', 0, 1, 1, NULL, ?)
  `);
  insert.run("adult-ear", "video", "抗敏要穴之息风止敏--耳穴过敏区", "成人调体", "2026-08-26T00:00:00.000Z");
  insert.run("child-quick", "video", "鼻三线姜刮", "儿童快速通窍", "2026-08-26T00:00:00.000Z");
  insert.run("article-unknown", "article", "换季科普", "鼻健康", "2026-08-26T00:00:00.000Z");
  insert.run("article-known", "article", "日常科普", "科普文章", "2026-08-26T00:00:00.000Z");
  insert.run("video-unknown", "video", "未收录视频", "旧视频分类", "2026-08-26T00:00:00.000Z");
  database.connection.prepare(`
    UPDATE content_items SET status = 'published', patient_visible = 1,
      published_at = '2026-08-25T00:00:00.000Z'
    WHERE id = 'video-unknown'
  `).run();
  database.connection.exec(`
    DELETE FROM content_category_migration_report;
    DELETE FROM content_item_category_links;
    DELETE FROM schema_migrations WHERE version = '0022_content_category_registry';
  `);
  database.close();

  database = new KangminDatabase(databasePath);
  try {
    const categories = database.connection.prepare(
      "SELECT id FROM content_category_registry ORDER BY id"
    ).all();
    assert.equal(categories.length, 20);
    const adultLinks = database.connection.prepare(`
      SELECT category_id FROM content_item_category_links
      WHERE content_id = 'adult-ear' ORDER BY category_id
    `).all() as unknown as Array<{ category_id: string }>;
    assert.deepEqual(adultLinks.map((row) => row.category_id), [
      "video-adult-kidney-yang",
      "video-adult-lung-heat",
      "video-adult-lung-qi-cold",
      "video-adult-mixed",
      "video-adult-spleen-qi"
    ]);
    const childLinks = database.connection.prepare(`
      SELECT category_id FROM content_item_category_links WHERE content_id = 'child-quick'
    `).all() as unknown as Array<{ category_id: string }>;
    assert.deepEqual(childLinks.map((row) => row.category_id), ["video-child-quick-content"]);
    const articleLinks = database.connection.prepare(`
      SELECT category_id FROM content_item_category_links WHERE content_id = 'article-known'
    `).all() as unknown as Array<{ category_id: string }>;
    assert.deepEqual(articleLinks.map((row) => row.category_id), ["article-general"]);
    const articleReport = database.connection.prepare(`
      SELECT status, reason, category_ids_json
      FROM content_category_migration_report WHERE content_id = 'article-unknown'
    `).get() as unknown as { status: string; reason: string; category_ids_json: string };
    assert.equal(articleReport.status, "migrated");
    assert.equal(articleReport.reason, "article_single_confirmed_category");
    assert.equal(articleReport.category_ids_json, '["article-general"]');
    const legacyArticleLinks = database.connection.prepare(`
      SELECT category_id FROM content_item_category_links WHERE content_id = 'article-unknown'
    `).all() as unknown as Array<{ category_id: string }>;
    assert.deepEqual(legacyArticleLinks.map((row) => row.category_id), ["article-general"]);
    const unresolvedReport = database.connection.prepare(`
      SELECT status, reason FROM content_category_migration_report WHERE content_id = 'video-unknown'
    `).get() as unknown as { status: string; reason: string };
    assert.equal(unresolvedReport.status, "unresolved");
    assert.equal(unresolvedReport.reason, "video_title_not_in_truth");
    const unresolvedVisibility = database.connection.prepare(`
      SELECT status, patient_visible, published_at
      FROM content_items WHERE id = 'video-unknown'
    `).get() as unknown as { status: string; patient_visible: number; published_at: string | null };
    assert.equal(unresolvedVisibility.status, "unpublished");
    assert.equal(unresolvedVisibility.patient_visible, 0);
    assert.equal(unresolvedVisibility.published_at, null);
  } finally {
    database.close();
  }
});

test("全部 truth 视频迁移前后 ID 与数量不变，分类矩阵逐项一致", () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), "km-category-matrix-")), "test.sqlite");
  let database = new KangminDatabase(databasePath);
  const insert = database.connection.prepare(`
    INSERT INTO content_items(
      id, kind, title, category, summary, body, source,
      cover_url, media_url, status, patient_visible,
      version_valid, media_available, published_at, updated_at
    ) VALUES (?, 'video', ?, '', '', NULL, '', NULL, NULL, 'draft', 0, 1, 1, NULL, ?)
  `);
  const beforeIds = VIDEO_TRUTH_ASSIGNMENTS.map((assignment, index) => {
    const id = `truth-video-${index + 1}`;
    insert.run(id, assignment.title, "2026-08-26T00:00:00.000Z");
    return id;
  });
  database.connection.exec(`
    DELETE FROM content_category_migration_report;
    DELETE FROM content_item_category_links;
    DELETE FROM schema_migrations WHERE version = '0022_content_category_registry';
  `);
  database.close();

  database = new KangminDatabase(databasePath);
  try {
    const afterIds = (database.connection.prepare(
      "SELECT id FROM content_items WHERE id LIKE 'truth-video-%' ORDER BY id"
    ).all() as unknown as Array<{ id: string }>).map((row) => row.id);
    assert.deepEqual(afterIds, [...beforeIds].sort());
    for (const [index, assignment] of VIDEO_TRUTH_ASSIGNMENTS.entries()) {
      const contentId = beforeIds[index]!;
      const links = database.connection.prepare(`
        SELECT category_id FROM content_item_category_links
        WHERE content_id = ? ORDER BY category_id
      `).all(contentId) as unknown as Array<{ category_id: string }>;
      assert.deepEqual(
        links.map((row) => row.category_id),
        [...assignment.categoryIds].sort(),
        assignment.title
      );
      const report = database.connection.prepare(`
        SELECT status, reason FROM content_category_migration_report WHERE content_id = ?
      `).get(contentId) as unknown as { status: string; reason: string };
      assert.equal(report.status, "migrated");
      assert.equal(report.reason, "video_truth_exact_title");
    }
  } finally {
    database.close();
  }
});

test("患者只读仓储按稳定 ID 返回活动分类树，文章不伪造分类", async () => {
  const database = new KangminDatabase(":memory:");
  try {
    const repository = new SqliteContentReadRepository(database);
    const videos = await repository.categoryRegistry("video");
    assert.equal(videos.length, 19);
    assert.deepEqual(videos.filter((node) => node.nodeType === "audience").map((node) => node.id), [
      "video-adult",
      "video-child"
    ]);
    assert.equal(videos.find((node) => node.id === "video-adult-lung-heat")?.selectable, true);
    assert.deepEqual(await repository.categoryRegistry("article"), [{
      id: "article-general",
      kind: "article",
      parentId: null,
      name: "科普文章",
      audience: "all",
      nodeType: "leaf",
      selectable: true,
      displayOrder: 0
    }]);
  } finally {
    database.close();
  }
});
