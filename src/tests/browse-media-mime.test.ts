import assert from "node:assert/strict";
import test from "node:test";

import { BrowseService } from "@kangmin/core/content/browse/browse-service";
import type {
  ContentReadRepository,
  PublishedMediaRef
} from "@kangmin/core/content/browse/content-read-repository";
import type { ObjectStoragePort } from "@kangmin/core/operations/system/object-storage-ports";

/**
 * 媒体路由 Content-Type 决策（issue-160）：库存 mime 是上传白名单通配
 * 形式（image/*、video/*），路由层按 storedPath 扩展名映射具体类型；
 * 具体 mime 原样使用；映射不到回退 application/octet-stream。
 */

function browseWithMedia(ref: PublishedMediaRef | null): BrowseService {
  const repository = {
    findPublishedMedia: async () => ref
  } as unknown as ContentReadRepository;
  const environment = {
    current: async () => {
      throw new Error("getPublishedMedia 不读取环境区块");
    }
  };
  const storage = {
    getObject: async () => Buffer.from("media-bytes")
  } as unknown as ObjectStoragePort;
  return new BrowseService(repository, environment, storage);
}

function mediaRef(mimeType: string | null, storedPath: string): PublishedMediaRef {
  return { storedPath, mimeType, status: "ready" };
}

test("通配 mime 按 storedPath 扩展名映射为具体 Content-Type", async () => {
  const cases: Array<[string, string, string]> = [
    ["video/*", "med_aaaaaaaaaaaa/clip.mp4", "video/mp4"],
    ["video/*", "med_aaaaaaaaaaaa/clip.webm", "video/webm"],
    ["image/*", "med_aaaaaaaaaaaa/cover.png", "image/png"],
    ["image/*", "med_aaaaaaaaaaaa/cover.jpg", "image/jpeg"],
    ["image/*", "med_aaaaaaaaaaaa/cover.jpeg", "image/jpeg"],
    ["image/*", "med_aaaaaaaaaaaa/cover.webp", "image/webp"],
    ["image/*", "med_aaaaaaaaaaaa/cover.svg", "image/svg+xml"],
    ["image/*", "med_aaaaaaaaaaaa/COVER.PNG", "image/png"],
    ["application/*", "med_aaaaaaaaaaaa/manual.pdf", "application/pdf"],
    ["text/*", "med_aaaaaaaaaaaa/notes.md", "text/markdown; charset=utf-8"]
  ];
  for (const [mimeType, storedPath, expected] of cases) {
    const media = await browseWithMedia(mediaRef(mimeType, storedPath)).getPublishedMedia("med_aaaaaaaaaaaa");
    assert.equal(media?.contentType, expected, `${mimeType} + ${storedPath}`);
  }
});

test("通配 mime 映射不到扩展名时回退 application/octet-stream", async () => {
  const unknown = await browseWithMedia(
    mediaRef("video/*", "med_aaaaaaaaaaaa/clip.mov")
  ).getPublishedMedia("med_aaaaaaaaaaaa");
  assert.equal(unknown?.contentType, "application/octet-stream");

  const noExtension = await browseWithMedia(
    mediaRef("image/*", "med_aaaaaaaaaaaa/cover")
  ).getPublishedMedia("med_aaaaaaaaaaaa");
  assert.equal(noExtension?.contentType, "application/octet-stream");
});

test("具体 mime 原样使用（白名单内），不在白名单回退 octet-stream", async () => {
  const concrete = await browseWithMedia(
    mediaRef("image/png", "med_aaaaaaaaaaaa/cover")
  ).getPublishedMedia("med_aaaaaaaaaaaa");
  assert.equal(concrete?.contentType, "image/png");

  const markdown = await browseWithMedia(
    mediaRef("text/markdown", "med_aaaaaaaaaaaa/notes.txt")
  ).getPublishedMedia("med_aaaaaaaaaaaa");
  assert.equal(markdown?.contentType, "text/markdown");

  // 绝不原样反射可被浏览器执行的库存类型。
  const html = await browseWithMedia(
    mediaRef("text/html", "med_aaaaaaaaaaaa/page.html")
  ).getPublishedMedia("med_aaaaaaaaaaaa");
  assert.equal(html?.contentType, "application/octet-stream");

  const missing = await browseWithMedia(
    mediaRef(null, "med_aaaaaaaaaaaa/cover.png")
  ).getPublishedMedia("med_aaaaaaaaaaaa");
  assert.equal(missing?.contentType, "application/octet-stream");
});

test("素材不可用或无已发布引用时不服务（null）", async () => {
  const disabledRef = mediaRef("video/*", "med_aaaaaaaaaaaa/clip.mp4");
  disabledRef.status = "disabled";
  assert.equal(
    await browseWithMedia(disabledRef).getPublishedMedia("med_aaaaaaaaaaaa"),
    null
  );
  assert.equal(
    await browseWithMedia(null).getPublishedMedia("med_aaaaaaaaaaaa"),
    null
  );
});
