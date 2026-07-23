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

test("server-renders the internal-only MVP boundary", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>抗敏先锋 · AI 鼻健康管理<\/title>/i);
  assert.match(html, /待临床确认，仅供内部测试/);
  assert.match(html, /当前页面不提供诊断、真实证型或调理方案/);
  assert.match(html, /诊一诊/);
  assert.match(html, /学一学/);
  assert.match(html, /aria-label="主要功能"/);
  assert.match(html, />首页<\/button>/);
  assert.match(html, />问助手<\/button>/);
  assert.match(html, />日历<\/button>/);
  assert.match(html, /aria-label="新增症状记录"/);
  assert.match(html, />我的<\/button>/);
  assert.doesNotMatch(html, />科普<\/button>/);
});

test("does not present prototype data as connected clinical capability", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(page, /type Tab = [^;]*"profile"/);
  assert.match(page, /setTab\("chat"\)/);
  assert.match(page, /知识库未接入/);
  assert.match(page, /规则引擎尚未接入/);
  assert.match(page, /暂无经审核的适用方案/);
  assert.match(page, /量表版本未确认，不用于评估/);
  assert.match(page, /账号与健康档案尚未接入，不保存数据/);
  assert.doesNotMatch(page, /知识库已连接/);
  assert.doesNotMatch(page, /症状正在缓解/);
  assert.doesNotMatch(page, /换季敏感 · 肺气虚寒倾向/);
  assert.match(css, /\.prototype-notice/);
});
