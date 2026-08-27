import { KangminDatabase } from "@kangmin/database/sqlite/database";

interface FixtureContent {
  id: string;
  kind: "article" | "video";
  title: string;
  category: string;
  status: "draft" | "review" | "published" | "unpublished" | "failed";
  patientVisible: number;
  versionValid: number;
  mediaAvailable: number;
}

const ITEMS: FixtureContent[] = [
  {
    id: "article-public",
    kind: "article",
    title: "换季鼻健康科普",
    category: "鼻健康",
    status: "published",
    patientVisible: 1,
    versionValid: 1,
    mediaAvailable: 1
  },
  {
    id: "article-draft",
    kind: "article",
    title: "草稿秘密内容",
    category: "内部",
    status: "draft",
    patientVisible: 1,
    versionValid: 1,
    mediaAvailable: 1
  },
  {
    id: "article-unpublished",
    kind: "article",
    title: "已下架内容",
    category: "旧版",
    status: "unpublished",
    patientVisible: 1,
    versionValid: 1,
    mediaAvailable: 1
  },
  {
    id: "article-hidden",
    kind: "article",
    title: "管理员可见内容",
    category: "内部",
    status: "published",
    patientVisible: 0,
    versionValid: 1,
    mediaAvailable: 1
  },
  {
    id: "video-public",
    kind: "video",
    title: "鼻腔护理基础视频",
    category: "居家护理",
    status: "published",
    patientVisible: 1,
    versionValid: 1,
    mediaAvailable: 1
  },
  {
    id: "video-review",
    kind: "video",
    title: "待审核视频",
    category: "待审核",
    status: "review",
    patientVisible: 1,
    versionValid: 1,
    mediaAvailable: 1
  },
  {
    id: "video-invalid-version",
    kind: "video",
    title: "无效版本视频",
    category: "旧版",
    status: "published",
    patientVisible: 1,
    versionValid: 0,
    mediaAvailable: 1
  },
  {
    id: "video-broken-media",
    kind: "video",
    title: "媒体失效视频",
    category: "媒体失效",
    status: "published",
    patientVisible: 1,
    versionValid: 1,
    mediaAvailable: 0
  }
];

/**
 * 分类统一（评审 A P1-6）：browse 分类清单改读 content_categories，
 * 这里只种子 browse 断言需要的启用分类（鼻健康/居家护理）。
 * 其余 fixture 分类（内部/旧版/待审核/媒体失效）属于不可见或未发布
 * 内容，若以 active 种子会破坏 browse.application.test.ts 的分类
 * 精确相等断言，故不建对应行。
 */
const TIMESTAMP = "2026-07-30T00:00:00.000Z";

export function seedContent(databasePath: string): void {
  const database = new KangminDatabase(databasePath);
  try {
    const categoryStatement = database.connection.prepare(`
      INSERT INTO content_categories(
        id, name, kind, description, display_order, status,
        revision, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, 0, 'active', 1, ?, ?)
    `);
    for (const category of [
      { id: "category-nose-health", name: "鼻健康", kind: "article" },
      { id: "category-home-care", name: "居家护理", kind: "video" }
    ]) {
      categoryStatement.run(
        category.id,
        category.name,
        category.kind,
        TIMESTAMP,
        TIMESTAMP
      );
    }
    const statement = database.connection.prepare(`
      INSERT INTO content_items(
        id, kind, title, category, summary, body, source,
        cover_url, media_url, status, patient_visible,
        version_valid, media_available, published_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of ITEMS) {
      statement.run(
        item.id,
        item.kind,
        item.title,
        item.category,
        `${item.title}的摘要`,
        item.kind === "article" ? `${item.title}正文` : null,
        "已审核测试来源",
        `/media/${item.id}.jpg`,
        item.kind === "video" ? `/media/${item.id}.mp4` : null,
        item.status,
        item.patientVisible,
        item.versionValid,
        item.mediaAvailable,
        item.status === "published" ? TIMESTAMP : null,
        item.id === "video-public"
          ? "2026-07-31T00:00:00.000Z"
          : TIMESTAMP
      );
    }
  } finally {
    database.close();
  }
}
