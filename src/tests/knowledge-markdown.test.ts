import assert from "node:assert/strict";
import test from "node:test";

import { chunkKnowledgeText } from "../modules/agent-admin/knowledge-markdown.js";

test("Markdown 分块保留标准章节层级，且每块不超过 1200 字符", () => {
  const text = [
    "# 手册",
    "",
    "### 分度强推荐治疗方案",
    "",
    "#### 中重度",
    "",
    "##### 热敏灸法",
    "",
    `操作说明：${"内容。".repeat(500)}`
  ].join("\n");
  const chunks = chunkKnowledgeText(text, "16-分度推荐方案.md");
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 1200));
  assert.ok(chunks.every((chunk, index) => chunk.index === index));
  assert.match(chunks[0]?.text ?? "", /资料章节：16-分度推荐方案\.md/u);
  assert.match(chunks[0]?.text ?? "", /分度强推荐治疗方案 > 中重度 > 热敏灸法/u);
});

test("只有标题的知识仍产生可索引切块", () => {
  assert.deepEqual(chunkKnowledgeText("# 单一标题", "标题.md"), [{
    index: 0,
    text: "资料章节：标题.md\n知识主题：单一标题"
  }]);
});
