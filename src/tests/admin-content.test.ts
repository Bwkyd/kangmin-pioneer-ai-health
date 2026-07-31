import assert from "node:assert/strict";

// 测试进程以本地开发模式启动：组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为
// PlaintextEncryption（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdminApplication } from "../app/admin-composition-root.js";
import { createApplication } from "../app/composition-root.js";
import type { CommandResult } from "../kernel/result.js";
import type {
  AdminArticle,
  AdminContentItem
} from "../modules/admin/content-admin-repository.js";
import type {
  ContentCategoryRow,
  ContentMediaRow,
  ContentMessageRow
} from "../modules/admin/content-aux-repository.js";

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

async function fixture(): Promise<{
  app: ReturnType<typeof createAdminApplication>;
  databasePath: string;
  mediaDirectory: string;
  token: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-admin-content-"));
  const databasePath = join(directory, "content.sqlite");
  const mediaDirectory = join(directory, "admin-media");
  mkdirSync(mediaDirectory, { recursive: true });
  const app = createAdminApplication(databasePath, { mediaDirectory });
  const session = await app.sessions.createDevelopmentSession("owner-content");
  return { app, databasePath, mediaDirectory, token: session.token };
}

test("文章发布闭环：create→update→publish→患者可见→unpublish 不可见", async () => {
  const { app, databasePath, token } = await fixture();
  try {
    dataOf<ContentCategoryRow>(
      await app.execute({
        command: "content category create",
        adminToken: token,
        input: { name: "日常防护", kind: "article", description: "日常防护分类" }
      })
    );

    const created = dataOf<AdminArticle>(
      await app.execute({
        command: "content article create",
        adminToken: token,
        input: {
          title: "换季鼻敏感注意事项",
          category: "日常防护",
          idempotencyKey: "content-loop-1"
        }
      })
    );
    assert.equal(created.status, "draft");

    // 过期修订号 → version_conflict
    const stale = await app.execute({
      command: "content article update",
      adminToken: token,
      input: { id: created.id, expectedRevision: 99, title: "迟到标题" }
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "version_conflict");

    // 缺 --yes 不能发布
    const noConfirm = await app.execute({
      command: "content article publish",
      adminToken: token,
      input: { id: created.id, expectedRevision: 1 }
    });
    assert.equal(noConfirm.ok, false);
    if (!noConfirm.ok) assert.equal(noConfirm.error.code, "confirmation_required");

    // 草稿内容不完整（缺摘要/正文/来源）不能发布
    const invalid = await app.execute({
      command: "content article publish",
      adminToken: token,
      input: { id: created.id, expectedRevision: 1, yes: true }
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.code, "validation_failed");

    const updated = dataOf<AdminArticle>(
      await app.execute({
        command: "content article update",
        adminToken: token,
        input: {
          id: created.id,
          expectedRevision: 1,
          summary: "换季科普摘要",
          body: "换季期间注意保暖和清洁，正文内容。",
          source: "客户已审核来源"
        }
      })
    );
    assert.equal(updated.revision, 2);

    const published = dataOf<AdminArticle>(
      await app.execute({
        command: "content article publish",
        adminToken: token,
        input: { id: created.id, expectedRevision: 2, yes: true }
      })
    );
    assert.equal(published.status, "published");

    // 预览包含校验结果与患者可见性
    const preview = dataOf<{ patientVisible: boolean; validation: { ok: boolean } }>(
      await app.execute({ command: "content article preview", adminToken: token, input: { id: created.id } })
    );
    assert.equal(preview.patientVisible, true);
    assert.equal(preview.validation.ok, true);

    // 患者 browse 可见（同一数据库，无身份要求）
    const patient = createApplication(databasePath);
    try {
      const visible = await patient.execute({
        command: "browse article show",
        input: { id: created.id }
      });
      assert.equal(visible.ok, true);
    } finally {
      patient.close();
    }

    // 下架后患者不可见
    const unpublished = dataOf<AdminArticle>(
      await app.execute({
        command: "content article unpublish",
        adminToken: token,
        input: { id: created.id, expectedRevision: 3, yes: true }
      })
    );
    assert.equal(unpublished.status, "unpublished");
    const patientAfter = createApplication(databasePath);
    try {
      const hidden = await patientAfter.execute({
        command: "browse article show",
        input: { id: created.id }
      });
      assert.equal(hidden.ok, false);
      if (!hidden.ok) assert.equal(hidden.error.code, "resource_not_found");
    } finally {
      patientAfter.close();
    }

    // 列表按状态过滤
    const drafts = dataOf<{ items: AdminArticle[] }>(
      await app.execute({
        command: "content article list",
        adminToken: token,
        input: { status: "unpublished" }
      })
    );
    assert.equal(drafts.items.length, 1);
  } finally {
    app.close();
  }
});

test("视频发布需要可用素材；素材引用保护与删除", async () => {
  const { app, databasePath, mediaDirectory, token } = await fixture();
  try {
    const videoFile = join(mediaDirectory, "demo.mp4");
    writeFileSync(videoFile, "fake-video-bytes");

    const media = dataOf<ContentMediaRow>(
      await app.execute({
        command: "content media upload",
        adminToken: token,
        input: { file: videoFile }
      })
    );
    assert.equal(media.status, "ready");

    const video = dataOf<AdminContentItem>(
      await app.execute({
        command: "content video create",
        adminToken: token,
        input: { title: "鼻腔护理基础视频", category: "居家护理", idempotencyKey: "video-1" }
      })
    );

    // 未关联视频素材不能发布
    const noMedia = await app.execute({
      command: "content video publish",
      adminToken: token,
      input: { id: video.id, expectedRevision: 1, yes: true }
    });
    assert.equal(noMedia.ok, false);
    if (!noMedia.ok) assert.equal(noMedia.error.code, "validation_failed");

    const videoUpdated = dataOf<AdminContentItem>(
      await app.execute({
        command: "content video update",
        adminToken: token,
        input: {
          id: video.id,
          expectedRevision: 1,
          summary: "基础护理视频",
          body: "居家鼻腔护理演示。",
          source: "客户已审核来源",
          mediaId: media.id
        }
      })
    );
    const published = dataOf<AdminContentItem>(
      await app.execute({
        command: "content video publish",
        adminToken: token,
        input: { id: videoUpdated.id, expectedRevision: 2, yes: true }
      })
    );
    assert.equal(published.status, "published");

    // 患者 browse 视频可见
    const patient = createApplication(databasePath);
    try {
      const visible = await patient.execute({
        command: "browse video show",
        input: { id: video.id }
      });
      assert.equal(visible.ok, true);
    } finally {
      patient.close();
    }

    // 被已发布内容引用的素材不能停用或删除
    const disableRef = await app.execute({
      command: "content media disable",
      adminToken: token,
      input: { id: media.id, yes: true }
    });
    assert.equal(disableRef.ok, false);
    if (!disableRef.ok) assert.equal(disableRef.error.code, "validation_failed");

    const deleteRef = await app.execute({
      command: "content media delete",
      adminToken: token,
      input: { id: media.id, yes: true }
    });
    assert.equal(deleteRef.ok, false);
    if (!deleteRef.ok) assert.equal(deleteRef.error.code, "validation_failed");

    // 下架后可以停用与删除
    dataOf(
      await app.execute({
        command: "content video unpublish",
        adminToken: token,
        input: { id: video.id, expectedRevision: 3, yes: true }
      })
    );
    dataOf(
      await app.execute({
        command: "content media disable",
        adminToken: token,
        input: { id: media.id, yes: true }
      })
    );
    const deleted = dataOf<{ deleted: boolean }>(
      await app.execute({
        command: "content media delete",
        adminToken: token,
        input: { id: media.id, yes: true }
      })
    );
    assert.equal(deleted.deleted, true);
  } finally {
    app.close();
  }
});

test("公告状态机与分类停用后禁止新发布", async () => {
  const { app, token } = await fixture();
  try {
    dataOf<ContentCategoryRow>(
      await app.execute({
        command: "content category create",
        adminToken: token,
        input: { name: "公告分类", kind: "message" }
      })
    );

    // 公告创建要求标题与正文
    const missingBody = await app.execute({
      command: "content message create",
      adminToken: token,
      input: { title: "无正文公告" }
    });
    assert.equal(missingBody.ok, false);
    if (!missingBody.ok) assert.equal(missingBody.error.code, "validation_failed");

    const message = dataOf<ContentMessageRow>(
      await app.execute({
        command: "content message create",
        adminToken: token,
        input: { title: "系统维护通知", body: "本周六 02:00-04:00 系统维护。" }
      })
    );
    assert.equal(message.status, "draft");

    const published = dataOf<ContentMessageRow>(
      await app.execute({
        command: "content message publish",
        adminToken: token,
        input: { id: message.id, expectedRevision: 1, yes: true }
      })
    );
    assert.equal(published.status, "published");

    const unpublished = dataOf<ContentMessageRow>(
      await app.execute({
        command: "content message unpublish",
        adminToken: token,
        input: { id: message.id, expectedRevision: 2, yes: true }
      })
    );
    assert.equal(unpublished.status, "unpublished");

    // 分类停用后，引用该分类的新内容不能发布
    dataOf<ContentCategoryRow>(
      await app.execute({
        command: "content category create",
        adminToken: token,
        input: { name: "待停用分类", kind: "article" }
      })
    );
    const article = dataOf<AdminArticle>(
      await app.execute({
        command: "content article create",
        adminToken: token,
        input: {
          title: "引用停用分类的文章",
          category: "待停用分类",
          summary: "摘要",
          body: "正文内容。",
          source: "来源",
          idempotencyKey: "article-disabled-cat"
        }
      })
    );
    const categoryList = dataOf<{ items: ContentCategoryRow[] }>(
      await app.execute({
        command: "content category list",
        adminToken: token,
        input: { kind: "article" }
      })
    );
    const category = categoryList.items.find(
      (item) => item.name === "待停用分类"
    ) as ContentCategoryRow;
    dataOf(
      await app.execute({
        command: "content category disable",
        adminToken: token,
        input: { id: category.id, expectedRevision: category.revision, yes: true }
      })
    );
    const blocked = await app.execute({
      command: "content article publish",
      adminToken: token,
      input: { id: article.id, expectedRevision: 1, yes: true }
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "validation_failed");
  } finally {
    app.close();
  }
});
