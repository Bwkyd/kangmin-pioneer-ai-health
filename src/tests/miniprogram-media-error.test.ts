import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import test from "node:test";

const miniprogramRoot = "apps/kangmin-miniprogram/src";

function loadLearnPage(): { data: Record<string, unknown>; onMediaError(): void; setData?: (changes: Record<string, unknown>) => void } {
  const source = readFileSync(resolve(miniprogramRoot, "pages/learn/index.js"), "utf8");
  let page: { data: Record<string, unknown>; onMediaError(): void; setData?: (changes: Record<string, unknown>) => void } | null = null;
  vm.runInNewContext(source, {
    Page: (definition: typeof page) => { page = definition; },
    require(name: string) {
      if (name === "../../utils/request") return { networkAvailable: true, wechatLoginEnabled: true, mediaUrl: (value: string) => value };
      if (name === "../../utils/page") return { errorMessage: () => "加载失败" };
      if (name === "../../utils/content-body") return { parseContentBody: () => [] };
      if (name === "../../utils/learning-catalog") return {};
      throw new Error(`unexpected module: ${name}`);
    },
    wx: { setNavigationBarTitle: () => undefined },
    Promise, Date, Math, Number, Object, Array, String, RegExp, setTimeout, clearTimeout, console
  });
  assert.ok(page);
  return page;
}

test("小程序视频播放失败展示患者可懂提示，不暴露媒体地址", () => {
  const page = loadLearnPage();
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };
  page.onMediaError();
  assert.equal(page.data.mediaError, "视频暂时无法播放，请稍后重试。");
  assert.doesNotMatch(String(page.data.mediaError), /https?:\/\//u);
  const template = readFileSync(resolve(miniprogramRoot, "pages/learn/index.wxml"), "utf8");
  assert.match(template, /binderror="onMediaError"/u);
  assert.match(template, /wx:if="\{\{kind !== 'video' && coverUrl\}\}"/u, "视频详情不能同时渲染文章封面图");
});
