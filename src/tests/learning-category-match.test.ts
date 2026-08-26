import assert from "node:assert/strict";
import test from "node:test";

import { belongsToLearningCategory } from "../modules/browse/learning-category-match.js";

const adult = { id: "adult", aliases: ["成人快速通窍"], titles: ["鼻三线姜刮", "迎香穴"] };
const child = { id: "child", aliases: ["儿童快速通窍"], titles: ["鼻三线姜刮", "鼻炎手法"] };
const categories = [adult, child];

test("学一学分类以明确人群优先，不让共享标题跨成人儿童串组", () => {
  const explicitlyChild = { category: "儿童快速通窍", title: "鼻三线姜刮" };
  assert.equal(belongsToLearningCategory(explicitlyChild, adult, categories), false);
  assert.equal(belongsToLearningCategory(explicitlyChild, child, categories), true);
});

test("学一学分类只允许唯一标题兜底，歧义和重复别名都安全拒绝", () => {
  assert.equal(belongsToLearningCategory({ category: "", title: "迎香穴" }, adult, categories), true);
  assert.equal(belongsToLearningCategory({ category: "", title: "鼻三线姜刮" }, adult, categories), false);
  const duplicateAlias = [{ ...adult, aliases: ["通窍"] }, { ...child, aliases: ["通窍"] }];
  assert.equal(belongsToLearningCategory({ category: "通窍", title: "迎香穴" }, adult, duplicateAlias), false);
});
