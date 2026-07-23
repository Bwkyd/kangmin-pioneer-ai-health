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

test("server-renders the anti-allergy health home page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>抗敏先锋 · AI 鼻健康管理<\/title>/i);
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

test("keeps the assistant on home and profile content on its own page", async () => {
  const page = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8");

  assert.match(page, /type Tab = [^;]*"profile"/);
  assert.match(page, /setTab\("chat"\)/);
  assert.match(page, /诊一诊/);
  assert.match(page, /学一学/);
  assert.match(page, /tab === "profile"/);
  assert.match(page, /健康档案/);
  assert.match(page, /症状记录/);
  assert.match(page, /鼻健康科普/);
  assert.match(page, /隐私与授权/);
  assert.match(page, /nav-profile/);
  assert.match(page, />问助手<\/button>/);
  assert.match(css, /grid-template-columns:\s*repeat\(5, 1fr\)/);
  assert.match(css, /\.profile-view/);
});
