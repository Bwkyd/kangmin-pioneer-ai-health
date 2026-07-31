import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../app/composition-root.js";
import type { CommandResult } from "../kernel/result.js";
import type {
  BrowseHome,
  PublicContent
} from "../modules/browse/contracts.js";
import { seedContent } from "./content-fixture.js";

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
      ["article", "article-withdrawn"],
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
