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

test("server-renders the consent and internal-test boundary", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>抗敏先锋 · AI 鼻健康管理<\/title>/i);
  assert.match(html, /待临床确认，仅供内部测试/);
  assert.match(html, /固定规则先行，模型不决定证型/);
  assert.match(html, /我已阅读并同意按内部测试边界使用/);
  assert.match(html, /18 岁及以上/);
  assert.match(html, /未满 18 岁/);
  assert.match(html, /开始安全问诊/);
  assert.match(html, /不会保存健康数据/);
  assert.match(html, /请立即就医，不要等待本工具结果/);
});

test("the client submits every clinical answer to the rule API", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(page, /fetch\("\/api\/v1\/agent\/evaluate"/);
  assert.match(page, /method: "POST"/);
  assert.match(page, /diagnosedAllergicRhinitis: answers\.diagnosedAllergicRhinitis/);
  assert.match(page, /respiratoryEmergency: answers\.respiratoryEmergency/);
  assert.match(page, /persistentHighFever: answers\.persistentHighFever/);
  assert.match(page, /severeNoseBleed: answers\.severeNoseBleed/);
  assert.match(page, /unilateralFoulDischarge: answers\.unilateralFoulDischarge/);
  assert.match(page, /severeNeurologicalSymptoms: answers\.severeNeurologicalSymptoms/);
  assert.match(page, /sleepAffected: answers\.sleepAffected/);
  assert.match(page, /activityAffected: answers\.activityAffected/);
  assert.match(page, /workStudyAffected: answers\.workStudyAffected/);
  assert.match(page, /symptomTroublesome: answers\.symptomTroublesome/);
  assert.match(page, /thirst: answers\.thirst/);
  assert.match(page, /fatigue: answers\.fatigue/);
  assert.match(page, /limbsNotWarm: answers\.limbsNotWarm/);
  assert.match(page, /fearWind: answers\.fearWind/);
  assert.match(page, /coldIntolerance: answers\.coldIntolerance/);
  assert.doesNotMatch(page, /evaluateSyndrome|DRAFT_SYNDROME_RULES/);
  assert.match(css, /\.api-error/);
});

test("all safe result states have explicit UI handling", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /case "classified"/);
  assert.match(page, /no_approved_plan/);
  assert.match(page, /case "blocked"/);
  assert.match(page, /请停止自助评估并尽快就医/);
  assert.match(page, /case "conflict"/);
  assert.match(page, /case "no_match"/);
  assert.match(page, /case "need_more_information"/);
  assert.match(page, /case "referred"/);
  assert.match(page, /提交失败/);
  assert.match(page, /可直接重试/);
  assert.match(page, /补充描述（选填）/);
  assert.match(page, /不保存、不作为规则输入/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.doesNotMatch(page, /知识库已连接|症状正在缓解/);
});
