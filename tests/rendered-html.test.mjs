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

  assert.match(page, /\| "home"/);
  assert.match(page, /\| "profile"/);
  assert.match(page, /\| "healthProfile"/);
  assert.match(page, /\| "allergenRecord"/);
  assert.match(page, /setTab\("chat"\)/);
  assert.match(page, /诊一诊/);
  assert.match(page, /学一学/);
  assert.match(page, /过敏日历/);
  assert.match(page, /鼻健康科普/);
  assert.match(page, /tab === "profile"/);
  assert.match(page, /tab === "healthProfile"/);
  assert.match(page, /tab === "allergenRecord"/);
  assert.match(page, /基础信息/);
  assert.match(page, /过敏史/);
  assert.match(page, /常见诱因/);
  assert.match(page, /用药记录/);
  assert.match(page, /患者自述/);
  assert.doesNotMatch(page, /护理视频待审核|请用指腹轻柔按揉鼻翼两侧/);
  assert.match(page, /不会自动判定为症状病因/);
  assert.match(page, /康复建议会先做安全筛查，并且只使用已审核的内容/);
  assert.match(page, /内部演示内容 · 待医学审核/);
  assert.match(page, /暂无真实健康记录/);
  assert.match(page, /<strong>过敏原记录<\/strong><i>记录今天<\/i>/);
  assert.match(page, /disabled=\{symptomStatus !== "ready" \|\| !scoresComplete\}/);
  assert.match(page, /scoresComplete \? symptomLabel\(totalScore\) : "请完成评分"/);
  assert.doesNotMatch(page, /知识库已连接|症状正在缓解|肺气虚寒倾向|个性化外治建议/);
  assert.match(css, /grid-template-columns:\s*repeat\(5, 1fr\)/);
  assert.match(css, /\.profile-view/);
  assert.match(css, /\.health-profile-view/);
  assert.match(css, /\.allergen-record-view/);
});

test("uses the server-owned health-record contract without a client user id", async () => {
  const adapter = await readFile(new URL("../app/health-records.ts", import.meta.url), "utf8");
  const discover = await readFile(new URL("../app/discover/page.tsx", import.meta.url), "utf8");

  assert.match(adapter, /commonTriggers: TriggerProjection\[\]/);
  assert.match(adapter, /"\/api\/v1\/health-records\/profile"/);
  assert.match(adapter, /"\/api\/v1\/health-records\/exposures"/);
  assert.match(adapter, /method: "PATCH"/);
  assert.match(adapter, /"if-match"/);
  assert.match(adapter, /"idempotency-key"/);
  assert.match(adapter, /credentials: "same-origin"/);
  assert.doesNotMatch(adapter, /["']x-user-id["']/i);
  assert.doesNotMatch(discover, /["']x-user-id["']/i);
  assert.doesNotMatch(adapter, /花粉监测/);
});
