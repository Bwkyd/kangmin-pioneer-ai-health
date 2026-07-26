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
    { summary: "新摘要" },
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
  });

  const detached = resolveContentUpdateFields(
    existing,
    { mediaId: "" },
    { videoTopicType: "symptom" },
  );
  assert.equal(detached.mediaId, null);
});
