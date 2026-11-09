import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@kangmin/runtime/composition-root";
import { QwenPlanDialogueAdapter } from "@kangmin/integrations/ai/qwen-plan-dialogue-adapter";
import type { PreAssessmentDialogueInput, PreAssessmentDialogueResult } from "@kangmin/core/intelligence/agent/model-ports";
import type { ConversationShowResult, ConversationTurnResult } from "@kangmin/core/intelligence/agent/conversation-contracts";
import { KangminDatabase } from "@kangmin/database/sqlite/database";
import { parseStructuredAnswers } from "@kangmin/core/intelligence/agent/answer-parser";
import { createKangminHttpServer } from "@kangmin/api/server";
import vm from "node:vm";

process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

function fixture() {
  const calls: PreAssessmentDialogueInput[] = [];
  let extractionCalls = 0;
  let sessionToken: string | undefined;
  const databasePath = join(mkdtempSync(join(tmpdir(), "kangmin-pre-assessment-")), "test.sqlite");
  const application = createApplication(databasePath, {
    appEnvironment: "integration",
    extraction: { async extractCandidates() { extractionCalls++; return []; } },
    planKnowledgeRetrieval: { async searchEnabled() { return []; } },
    planDialogue: {
      async generatePlan() { return null; },
      async answerFollowUp() { return null; },
      async answerBeforeAssessment(input): Promise<PreAssessmentDialogueResult> {
        calls.push(input);
        return input.question === "开始评估"
          ? { mode: "assessment" }
          : { mode: "answer", answer: "过敏性鼻炎与感冒的原因不同。" };
      }
    }
  });
  async function exec(message: string, conversationId?: string) {
    const result = await application.execute({ command: "agent exec", input: { message, conversationId }, sessionToken });
    assert.ok(result.ok, JSON.stringify(result));
    return result.data as ConversationTurnResult;
  }
  async function login() {
    const input = { username: "dialogue_test", password: "local-test-password-123" };
    assert.ok((await application.execute({ command: "account register", input })).ok);
    const loggedIn = await application.execute({ command: "account login", input });
    assert.ok(loggedIn.ok);
    sessionToken = (loggedIn.data as { token: string }).token;
  }
  async function show(id: string) {
    const result = await application.execute({ command: "agent conversations show", input: { id }, sessionToken });
    assert.ok(result.ok, JSON.stringify(result));
    return result.data as ConversationShowResult;
  }
  return { application, calls, exec, login, show, databasePath, token: () => sessionToken, extractionCalls: () => extractionCalls };
}

test("问卷前科普连续追问使用模型与历史，不启动问卷或写入患者事实", async () => {
  const f = fixture();
  try {
    const first = await f.exec("什么是过敏性鼻炎？");
    const second = await f.exec("它和感冒有什么区别？", first.conversationId);
    const third = await f.exec("有口渴是什么原因？", first.conversationId);
    assert.match(second.message?.content ?? "", /原因不同/u);
    assert.equal(first.verdict, null);
    assert.equal(second.verdict, null);
    assert.equal(third.verdict, null);
    assert.equal(second.closed, false);
    assert.equal(f.extractionCalls(), 0);
    assert.equal(f.calls[0]?.pendingQuestions.length, 0);
    assert.equal(f.calls[1]?.recentMessages.length, 2);
    assert.equal(f.calls[1]?.recentMessages[0]?.content, "什么是过敏性鼻炎？");
    const db = new KangminDatabase(f.databasePath);
    try {
      assert.equal(db.connection.prepare("SELECT COUNT(*) AS n FROM agent_confirmed_answers").get()?.n, 0);
    } finally { db.close(); }
  } finally { f.application.close(); }
});

test("问卷中插问后仍保留当前节点，选项继续按确定性规则推进", async () => {
  const f = fixture();
  try {
    await f.login();
    const first = await f.exec("开始评估");
    assert.equal(first.verdict?.nextQuestions[0]?.fieldCode, "q1");
    const question = await f.exec("为什么要问打喷嚏？", first.conversationId);
    assert.deepEqual(question.verdict?.nextQuestions, first.verdict?.nextQuestions);
    const restored = await f.show(first.conversationId);
    assert.deepEqual(restored.lastDecision?.nextQuestions, question.verdict?.nextQuestions);
    assert.equal(restored.messages.at(-1)?.content, question.message?.content);
    assert.equal(f.calls.at(-1)?.pendingQuestions[0]?.fieldCode, "q1");
    const answer = await f.exec("q1=C", first.conversationId);
    assert.equal(answer.verdict?.nextQuestions[0]?.fieldCode, "q2");
    assert.equal(f.calls.length, 2, "结构化选项不经过模型分流");
  } finally { f.application.close(); }
});

test("问卷前急症与个体药量先于模型分流，不产生个性化方案", async () => {
  const f = fixture();
  try {
    const emergency = await f.exec("口渴：是，呼吸困难，喘不过气了");
    assert.match(emergency.message?.content ?? "", /120|急诊/u);
    const dosage = await f.exec("这种药每天吃几片？");
    assert.match(dosage.message?.content ?? "", /医生|药师/u);
    assert.equal(emergency.verdict, null);
    assert.equal(emergency.closed, true);
    assert.equal(emergency.state, "completed");
    const resume = await f.application.execute({
      command: "agent exec", input: { message: "q1=C", conversationId: emergency.conversationId }
    });
    assert.equal(resume.ok, false);
    assert.equal(dosage.verdict, null);
    assert.equal(f.calls.length, 0);
    assert.equal(f.extractionCalls(), 0);
  } finally { f.application.close(); }
});

test("明确症状陈述可解析，询问症状原因不能被截取成确认事实", () => {
  assert.deepEqual(parseStructuredAnswers("有口渴。", []), [{ fieldCode: "thirst", state: "yes" }]);
  assert.deepEqual(parseStructuredAnswers("没有怕风", []), [{ fieldCode: "fear_wind", state: "no" }]);
  assert.deepEqual(parseStructuredAnswers("有口渴，没有怕风。", []), [
    { fieldCode: "thirst", state: "yes" }, { fieldCode: "fear_wind", state: "no" }
  ]);
  assert.deepEqual(parseStructuredAnswers("有口渴.", []), [{ fieldCode: "thirst", state: "yes" }]);
  for (const question of ["有口渴是什么原因？", "有口渴吗？", "没有怕风就是好了吗？"]) {
    assert.deepEqual(parseStructuredAnswers(question, []), []);
  }
});

test("患者 HTTP 流式科普、历史回读与插问后的选项一致，急症终止旧评估", async () => {
  const f = fixture();
  const server = createKangminHttpServer(f.application, { appEnvironment: "integration" });
  try {
    await f.login();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/v1/patient/agent/stream`;
    let requestSequence = 0;
    async function stream(message: string, conversationId?: string) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${f.token()}` },
        body: JSON.stringify({ schemaVersion: "1", requestId: `stream-${++requestSequence}`, input: { message, conversationId } })
      });
      assert.equal(response.status, 200);
      const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
      const done = events.at(-1).data as ConversationTurnResult;
      assert.equal(events.at(-1).type, "done");
      assert.equal(events.filter((event) => event.type === "delta").map((event) => event.content).join(""), done.message?.content);
      const restored = await f.show(done.conversationId);
      assert.equal(restored.messages.at(-1)?.content, done.message?.content);
      assert.deepEqual(restored.lastDecision?.nextQuestions, done.verdict?.nextQuestions ?? []);
      return done;
    }
    const first = await stream("开始评估");
    const answer = await stream("有口渴是什么原因？", first.conversationId);
    assert.equal(answer.verdict?.nextQuestions[0]?.fieldCode, "q1");
    assert.match(answer.message?.content ?? "", /原因不同/u);
    const continued = await stream("q1=C", first.conversationId);
    assert.equal(continued.verdict?.nextQuestions[0]?.fieldCode, "q2");
    const emergency = await stream("口渴：是，呼吸困难，喘不过气", first.conversationId);
    assert.equal(emergency.closed, true);
    assert.equal(emergency.verdict, null);
    const detail = await f.show(first.conversationId);
    let page: any;
    vm.runInNewContext(readFileSync("apps/kangmin-miniprogram/src/pages/assistant/index.js", "utf8"), {
      Page: (value: unknown) => { page = value; },
      require: (name: string) => name.endsWith("questionnaire") ? { visibleAnswer: () => null } : {},
      wx: { setStorageSync: () => {} }, Date, setTimeout, clearTimeout
    });
    page.setData = (changes: object) => { page.data = { ...page.data, ...changes }; };
    page.loadPlanVideos = () => {};
    page.applyConversation(detail);
    assert.equal(page.data.canSend, false);
    assert.equal(page.data.endReason, "", "急症终态不能误报为规则版本更新");
    assert.equal(page.data.pendingQuestions.length, 0);
    const rejected = await f.application.execute({
      command: "agent exec", input: { message: "q2=B", conversationId: first.conversationId }, sessionToken: f.token()
    });
    assert.equal(rejected.ok, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    f.application.close();
  }
});

test("Qwen 问卷前回答严格校验分流 JSON，失败不退回机械问卷", async () => {
  const input: PreAssessmentDialogueInput = {
    question: "它是什么？", sources: [], pendingQuestions: [],
    recentMessages: [{ role: "user", content: "我想了解过敏性鼻炎。" }, { role: "assistant", content: "你想了解哪方面？" }]
  };
  const payloads: unknown[] = [
    { mode: "answer", answer: "一种过敏反应。" },
    { mode: "assessment" },
    { mode: "assessment", syndromeCode: "invented" },
    { mode: "answer", answer: "" }
  ];
  const adapter = new QwenPlanDialogueAdapter({
    apiKey: "test-only-placeholder",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      assert.equal(request.enable_thinking, false);
      assert.deepEqual(request.messages.slice(1, -1), input.recentMessages);
      assert.equal(request.messages.at(-1).role, "user");
      assert.deepEqual(JSON.parse(request.messages.at(-1).content), {
        pendingQuestions: [], sources: [], question: input.question
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payloads.shift()) } }] }));
    }
  });
  assert.deepEqual(await adapter.answerBeforeAssessment(input), { mode: "answer", answer: "一种过敏反应。" });
  assert.deepEqual(await adapter.answerBeforeAssessment(input), { mode: "assessment" });
  assert.deepEqual(await adapter.answerBeforeAssessment(input), { mode: "answer", answer: null });
  assert.deepEqual(await adapter.answerBeforeAssessment(input), { mode: "answer", answer: null });
  assert.equal(await new QwenPlanDialogueAdapter({}).answerBeforeAssessment(input), null);
});
