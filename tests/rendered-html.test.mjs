import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the original mini-program home", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>抗敏先锋 · AI 鼻健康管理<\/title>/i);
  assert.match(html, /诊一诊/);
  assert.match(html, /学一学/);
  assert.match(html, /抗敏先锋鼻健康交互 Demo/);
  assert.match(html, /暂无真实健康记录/);
  assert.match(html, /aria-label="主要功能"/);
  assert.match(html, />首页<\/button>/);
  assert.match(html, />问助手<\/button>/);
  assert.match(html, />日历<\/button>/);
  assert.match(html, /aria-label="新增症状记录"/);
  assert.match(html, />我的<\/button>/);
  assert.doesNotMatch(html, /知识库已连接|症状正在缓解|肺气虚寒倾向|个性化外治建议/);
});

test("keeps every original demo section without presenting simulated medical facts", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(page, /type Tab = "home" \| "chat" \| "assessment" \| "articles" \| "profile"/);
  assert.match(page, /setTab\("chat"\)/);
  assert.match(page, /诊一诊/);
  assert.match(page, /学一学/);
  assert.match(page, /过敏日历/);
  assert.match(page, /鼻健康科普/);
  assert.match(page, /tab === "profile"/);
  assert.match(page, /当前不会输出诊断、证型或个性化治疗方案/);
  assert.match(page, /内部演示内容 · 待医学审核/);
  assert.match(page, /暂无真实健康记录/);
  assert.doesNotMatch(page, /知识库已连接|症状正在缓解|肺气虚寒倾向|个性化外治建议/);
  assert.match(css, /grid-template-columns:\s*repeat\(5, 1fr\)/);
  assert.match(css, /\.profile-view/);
});
