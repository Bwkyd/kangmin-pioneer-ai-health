import assert from "node:assert/strict";
import test from "node:test";
import { filterVideoItems, normalizeVideoTopicType, uniqueVideoCategories } from "../../../lib/content/video-topics.ts";

const videos = [
  { id: "symptom-1", category: "鼻塞", topicType: "symptom" },
  { id: "symptom-2", category: "流清涕", topicType: "symptom" },
  { id: "syndrome-1", category: "肺气虚寒型", topicType: "syndrome" },
  { id: "general-1", category: "日常护理", topicType: undefined },
];

test("视频分类只按后台保存的分类维度和分类名称筛选", () => {
  assert.deepEqual(filterVideoItems(videos, "symptom", "all").map((item) => item.id), ["symptom-1", "symptom-2"]);
  assert.deepEqual(filterVideoItems(videos, "syndrome", "肺气虚寒型").map((item) => item.id), ["syndrome-1"]);
  assert.deepEqual(filterVideoItems(videos, "all", "日常护理").map((item) => item.id), ["general-1"]);
  assert.deepEqual(filterVideoItems(videos, "symptom", "肺气虚寒型"), []);
});

test("视频分类导航只展示当前维度下的已有分类", () => {
  assert.deepEqual(uniqueVideoCategories(videos, "symptom"), ["鼻塞", "流清涕"]);
  assert.deepEqual(uniqueVideoCategories(videos, "syndrome"), ["肺气虚寒型"]);
  assert.deepEqual(uniqueVideoCategories(videos, "all"), ["鼻塞", "肺气虚寒型", "流清涕", "日常护理"]);
});

test("未知或缺失分类维度默认进入通用内容，不会伪造症状或证型", () => {
  assert.equal(normalizeVideoTopicType(undefined), "general");
  assert.equal(normalizeVideoTopicType("invented-clinical-rule"), "general");
});
