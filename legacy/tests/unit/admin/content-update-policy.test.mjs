import assert from "node:assert/strict";
import test from "node:test";

import { resolveContentUpdateFields } from "../../../lib/admin/content-update.ts";

const existing = {
  type: "video",
  title: "原视频标题",
  category: "鼻塞",
  summary: "原摘要",
  body: "",
  source: "原来源",
  media_id: "media-video-1",
};

test("后台部分更新保留未提交字段，显式空素材才解除绑定", () => {
  const changed = resolveContentUpdateFields(
    existing,
    { summary: "新摘要", candidateKind: "pediatric", changeDiff: "新增儿童边界" },
    { videoTopicType: "symptom" },
  );

  assert.deepEqual(changed, {
    title: "原视频标题",
    category: "鼻塞",
    summary: "新摘要",
    body: "",
    source: "原来源",
    mediaId: "media-video-1",
    metadata: JSON.stringify({ videoTopicType: "symptom" }),
    clinicalCandidateKind: "pediatric",
    clinicalChangeDiff: "新增儿童边界",
  });

  const detached = resolveContentUpdateFields(
    existing,
    { mediaId: "" },
    { videoTopicType: "symptom" },
  );
  assert.equal(detached.mediaId, null);
});

test("文章图片关联支持保存、替换和显式移除", () => {
  const existingArticle = {
    type: "article",
    title: "原文章标题",
    category: "日常护理",
    summary: "原摘要",
    body: "原正文",
    source: "原来源",
    media_id: "media-image-1",
  };

  const replaced = resolveContentUpdateFields(
    existingArticle,
    { mediaId: "media-image-2" },
    {},
  );
  assert.equal(replaced.mediaId, "media-image-2");
  assert.equal(replaced.body, "原正文");

  const removed = resolveContentUpdateFields(existingArticle, { mediaId: "" }, {});
  assert.equal(removed.mediaId, null);
});
