import assert from "node:assert/strict";
import test from "node:test";

import { normalizeManualMarkdown } from "../scripts/prepare-manual-knowledge.js";

test("手册净化删除编校元数据和重复目录，保留正文、图注与边界", () => {
  const raw = [
    "---",
    'title: "测试"',
    "---",
    "",
    "### **过敏性鼻炎中医适宜技术手册",
    "",
    "### **目录",
    "",
    "第一章 2",
    "",
    "---",
    "",
    "# 中篇",
    "",
    "#### **第二节 灸类技术",
    "",
    "#### **一、热敏灸技术",
    "",
    "#### - **间接灸技术",
    "",
    "正文不可删除。",
    "",
    "![图 3 面部刮拭方向](<images/example.webp>)"
  ].join("\n");
  const normalized = normalizeManualMarkdown(raw, "第二章/测试.md");
  assert.doesNotMatch(normalized.text, /title:|### \*\*目录|第一章 2/u);
  assert.match(normalized.text, /正文不可删除/u);
  assert.match(normalized.text, /插图说明：图 3 面部刮拭方向/u);
  assert.match(normalized.text, /images\/example\.webp/u);
  assert.match(normalized.text, /不作为证型、分期、个体方案或操作参数的裁决依据/u);
  assert.match(normalized.text, /### \*\*第二节 灸类技术/u);
  assert.match(normalized.text, /#### \*\*一、热敏灸技术/u);
  assert.match(normalized.text, /#### - \*\*间接灸技术/u);
  assert.equal(normalized.imageCaptions, 1);
});
