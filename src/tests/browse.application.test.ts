import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../app/composition-root.js";
import type { CommandResult } from "../kernel/result.js";
import type {
  BrowseHome,
  PatientMessage,
  PublicContent
} from "../modules/browse/contracts.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { seedContent } from "./content-fixture.js";

// 测试进程以本地开发模式启动：未配置 KANGMIN_ENCRYPTION_KEYS 时，
// 组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为 PlaintextEncryption
//（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";


function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-browse-"));
  const databasePath = join(directory, "content.sqlite");
  seedContent(databasePath);
  return { databasePath, application: createApplication(databasePath) };
}

test("Browse 不需登录即可读取已发布首页和分类", async () => {
  const { application } = fixture();
  try {
    const home = dataOf<BrowseHome>(await application.execute({
      command: "browse"
    }));
    assert.deepEqual(home.articles.map((item) => item.id), ["article-public"]);
    assert.deepEqual(home.videos.map((item) => item.id), ["video-public"]);
    assert.equal(home.recentlyUpdated[0]?.id, "video-public");
    assert.deepEqual(home.categories.articles, ["鼻健康"]);
    assert.deepEqual(home.categories.videos, ["居家护理"]);
  } finally {
    application.close();
  }
});

test("列表、搜索和详情共用发布门禁", async () => {
  const { application } = fixture();
  try {
    const listed = dataOf<{ items: PublicContent[] }>(await application.execute({
      command: "browse article list"
    }));
    assert.deepEqual(listed.items.map((item) => item.id), ["article-public"]);
    assert.match(listed.items[0]?.disclaimer ?? "", /不代替门诊诊断/u);

    const publicSearch = dataOf<{ items: PublicContent[] }>(
      await application.execute({
        command: "browse video search",
        input: { query: "鼻腔" }
      })
    );
    assert.deepEqual(publicSearch.items.map((item) => item.id), ["video-public"]);

    for (const [kind, id] of [
      ["article", "article-draft"],
      ["article", "article-unpublished"],
      ["article", "article-hidden"],
      ["video", "video-review"],
      ["video", "video-invalid-version"],
      ["video", "video-broken-media"]
    ] as const) {
      const hidden = await application.execute({
        command: `browse ${kind} show`,
        input: { id }
      });
      assert.equal(hidden.ok, false, id);
      if (!hidden.ok) {
        assert.equal(hidden.error.code, "resource_not_found", id);
      }
    }

    const leakedSearch = dataOf<{ items: PublicContent[] }>(
      await application.execute({
        command: "browse article search",
        input: { query: "秘密" }
      })
    );
    assert.deepEqual(leakedSearch.items, []);

    const wildcardSearch = dataOf<{ items: PublicContent[] }>(
      await application.execute({
        command: "browse article search",
        input: { query: "%_" }
      })
    );
    assert.deepEqual(wildcardSearch.items, []);
  } finally {
    application.close();
  }
});

test("Browse SQLite 在应用重启后保持相同可见投影", async () => {
  const { application, databasePath } = fixture();
  application.close();
  const restarted = createApplication(databasePath);
  try {
    const shown = dataOf<PublicContent>(await restarted.execute({
      command: "browse video show",
      input: { id: "video-public" }
    }));
    assert.equal(shown.mediaUrl, "/media/video-public.mp4");
    assert.equal(shown.source, "已审核测试来源");
  } finally {
    restarted.close();
  }
});

test("站内消息要求登录，未发布不可见，已读状态按患者隔离", async () => {
  const { application, databasePath } = fixture();
  try {
    for (const username of ["message-user-a", "message-user-b"]) {
      dataOf<{ patientId: string }>(await application.execute({
        command: "account register",
        input: { username, password: "message-pass-123" }
      }));
    }
    const loginA = dataOf<{ token: string }>(await application.execute({
      command: "account login",
      input: { username: "message-user-a", password: "message-pass-123" }
    }));
    const loginB = dataOf<{ token: string }>(await application.execute({
      command: "account login",
      input: { username: "message-user-b", password: "message-pass-123" }
    }));

    const database = new KangminDatabase(databasePath);
    try {
      const now = new Date().toISOString();
      const insert = database.connection.prepare(`
        INSERT INTO content_messages(
          id, title, body, summary, status, revision, published_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
      `);
      insert.run("message-published", "本周鼻健康提醒", "记得记录症状", "每周提醒", "published", now, now, now);
      insert.run("message-draft", "草稿", "不可见", null, "draft", null, now, now);
    } finally {
      database.close();
    }

    const anonymous = await application.execute({ command: "browse message list" });
    assert.equal(anonymous.ok, false);
    if (!anonymous.ok) assert.equal(anonymous.error.code, "authentication_required");

    const first = dataOf<{ items: PatientMessage[] }>(await application.execute({
      command: "browse message list",
      sessionToken: loginA.token
    }));
    assert.deepEqual(first.items.map((item) => item.id), ["message-published"]);
    assert.equal(first.items[0]?.readAt, null);

    const countBefore = dataOf<{ count: number }>(await application.execute({
      command: "browse message unread-count",
      sessionToken: loginA.token
    }));
    assert.equal(countBefore.count, 1);

    const read = dataOf<PatientMessage>(await application.execute({
      command: "browse message read",
      input: { id: "message-published" },
      sessionToken: loginA.token
    }));
    assert.notEqual(read.readAt, null);

    const countAfter = dataOf<{ count: number }>(await application.execute({
      command: "browse message unread-count",
      sessionToken: loginA.token
    }));
    assert.equal(countAfter.count, 0);

    const otherPatient = dataOf<{ items: PatientMessage[] }>(await application.execute({
      command: "browse message list",
      sessionToken: loginB.token
    }));
    assert.equal(otherPatient.items[0]?.readAt, null);
  } finally {
    application.close();
  }
});
