import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

import { ASSESSMENT_QUESTIONS } from "../modules/clinical-rules/assessment-questionnaire.js";

interface CommonJsModule { exports: Record<string, unknown> }

function loadModule(
  relativePath: string,
  globals: Record<string, unknown> = {},
  requireValue: Record<string, unknown> = {}
): Record<string, unknown> {
  const module: CommonJsModule = { exports: {} };
  const source = readFileSync(resolve("miniprogram", relativePath), "utf8");
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name: string) => name === "./local-experience"
      ? loadModule("utils/local-experience.js")
      : requireValue,
    console,
    Promise,
    Date,
    Math,
    Object,
    Array,
    String,
    RegExp,
    ...globals
  }, { filename: relativePath });
  return module.exports;
}

interface PageDefinition {
  data: Record<string, any>;
  setData?: (changes: Record<string, any>, callback?: () => void) => void;
  [key: string]: any;
}

function loadPage(
  relativePath: string,
  modules: Record<string, unknown>,
  wxValue: Record<string, unknown> = { setNavigationBarTitle: () => undefined }
): PageDefinition {
  const source = readFileSync(resolve("miniprogram", relativePath), "utf8");
  let definition: PageDefinition | null = null;
  vm.runInNewContext(source, {
    Page: (page: PageDefinition) => { definition = page; },
    require: (name: string) => name === "../../utils/questionnaire"
      ? loadModule("utils/questionnaire.js")
      : modules[name] ?? {},
    wx: wxValue,
    Promise,
    Date,
    Math,
    Number,
    Object,
    Array,
    String,
    RegExp,
    setTimeout,
    clearTimeout,
    console
  }, { filename: relativePath });
  assert.ok(definition !== null, `${relativePath} 未注册 Page`);
  return definition;
}

interface RequestOptions {
  url: string;
  method: string;
  data: unknown;
  header: Record<string, string>;
  success(response: { statusCode: number; data: unknown }): void;
  fail(reason: { errMsg: string }): void;
}

function createWxMock(handler: (options: RequestOptions) => void, initialToken = "") {
  const storage: Record<string, any> = initialToken
    ? { "kangmin.session.token": initialToken }
    : {};
  let loginCount = 0;
  let removeCount = 0;
  return {
    api: {
      request: handler,
      login: ({ success }: { success(value: { code: string }): void }) => {
        loginCount += 1;
        success({ code: `login-code-${loginCount}` });
      },
      getStorageSync: (key: string) => storage[key] ?? "",
      setStorageSync: (key: string, value: any) => { storage[key] = value; },
      removeStorageSync: (key: string) => { removeCount += 1; delete storage[key]; }
    },
    loginCount: () => loginCount,
    removeCount: () => removeCount
  };
}

test("小程序公共请求免登录，患者记录经 wx.login 换取 Bearer 会话", async () => {
  const calls: RequestOptions[] = [];
  const wxMock = createWxMock((options) => {
    calls.push(options);
    if (options.url.endsWith("/v1/auth/wechat")) {
      options.success({ statusCode: 200, data: { ok: true, data: { token: "token-1" } } });
      return;
    }
    options.success({ statusCode: 200, data: { ok: true, data: { items: [] } } });
  });
  const exports = loadModule("utils/request.js", { wx: wxMock.api }, {
    apiBaseUrl: "https://example.test",
    requestTimeoutMs: 1000
  });
  const createClient = exports.createClient as (
    api: typeof wxMock.api,
    options: { apiBaseUrl: string; requestTimeoutMs: number; wechatLoginEnabled: boolean }
  ) => { command(name: string, input: object, options: { auth: boolean }): Promise<unknown> };
  const client = createClient(wxMock.api, {
    apiBaseUrl: "https://example.test",
    requestTimeoutMs: 1000,
    wechatLoginEnabled: true
  });

  await client.command("browse article list", {}, { auth: false });
  assert.equal(wxMock.loginCount(), 0);
  assert.equal(calls[0]?.header.Authorization, undefined);

  await client.command("record overview", {}, { auth: true });
  assert.equal(wxMock.loginCount(), 1);
  assert.match(calls[1]?.url ?? "", /\/v1\/auth\/wechat$/u);
  assert.equal(calls[2]?.header.Authorization, "Bearer token-1");
});

test("患者命令遇到 401 清理旧令牌并只重登重试一次", async () => {
  const calls: RequestOptions[] = [];
  let commandCount = 0;
  const wxMock = createWxMock((options) => {
    calls.push(options);
    if (options.url.endsWith("/v1/auth/wechat")) {
      options.success({ statusCode: 200, data: { ok: true, data: { token: "fresh-token" } } });
      return;
    }
    commandCount += 1;
    if (commandCount === 1) {
      options.success({
        statusCode: 401,
        data: { ok: false, error: { code: "authentication_required", message: "会话失效" } }
      });
      return;
    }
    options.success({ statusCode: 200, data: { ok: true, data: { monthRecordCount: 0 } } });
  }, "stale-token");
  const exports = loadModule("utils/request.js", { wx: wxMock.api }, {
    apiBaseUrl: "https://example.test",
    requestTimeoutMs: 1000
  });
  const createClient = exports.createClient as (
    api: typeof wxMock.api,
    options: { apiBaseUrl: string; requestTimeoutMs: number; wechatLoginEnabled: boolean }
  ) => { command(name: string, input: object, options: { auth: boolean }): Promise<unknown> };
  const client = createClient(wxMock.api, {
    apiBaseUrl: "https://example.test",
    requestTimeoutMs: 1000,
    wechatLoginEnabled: true
  });

  await client.command("record overview", {}, { auth: true });
  assert.equal(wxMock.removeCount(), 1);
  assert.equal(wxMock.loginCount(), 1);
  assert.equal(calls.at(-1)?.header.Authorization, "Bearer fresh-token");
});

test("微信登录未配置时患者命令安全拒绝且不发出身份请求", async () => {
  const calls: RequestOptions[] = [];
  const wxMock = createWxMock((options) => calls.push(options));
  const exports = loadModule("utils/request.js", { wx: wxMock.api }, {
    apiBaseUrl: "https://example.test",
    requestTimeoutMs: 1000
  });
  const createClient = exports.createClient as (
    api: typeof wxMock.api,
    options: { apiBaseUrl: string; requestTimeoutMs: number; wechatLoginEnabled: boolean }
  ) => { command(name: string, input: object, options: { auth: boolean }): Promise<unknown> };
  const client = createClient(wxMock.api, {
    apiBaseUrl: "https://example.test",
    requestTimeoutMs: 1000,
    wechatLoginEnabled: false
  });

  await assert.rejects(
    client.command("record overview", {}, { auth: true }),
    (reason: unknown) => {
      assert.equal((reason as { code?: string }).code, "capability_unavailable");
      return true;
    }
  );
  assert.equal(wxMock.loginCount(), 0);
  assert.equal(calls.length, 0);
});

test("客户体验版在无微信登录时把健康记录保存在本机并贯通概览、日历和趋势", async () => {
  const calls: RequestOptions[] = [];
  const wxMock = createWxMock((options) => calls.push(options));
  const exports = loadModule("utils/request.js", { wx: wxMock.api }, {
    apiBaseUrl: "https://example.test",
    requestTimeoutMs: 1000,
    wechatLoginEnabled: false,
    anonymousRecordsEnabled: true
  });
  const createClient = exports.createClient as (
    api: typeof wxMock.api,
    options: { apiBaseUrl: string; requestTimeoutMs: number; wechatLoginEnabled: boolean; anonymousRecordsEnabled: boolean }
  ) => { command(name: string, input: Record<string, unknown>, options: { auth: boolean }): Promise<any> };
  const options = {
    apiBaseUrl: "https://example.test",
    requestTimeoutMs: 1000,
    wechatLoginEnabled: false,
    anonymousRecordsEnabled: true
  };
  const client = createClient(wxMock.api, options);

  const privacy = await client.command("account privacy", {}, { auth: false });
  assert.match(privacy.statement, /只保存在当前设备/u);
  await client.command("account consent update", { decision: "granted" }, { auth: true });
  await client.command("record profile update", {
    expectedRevision: 0,
    displayName: "体验患者",
    birthDate: null,
    sex: "unspecified",
    allergyHistory: null
  }, { auth: true });
  const symptomInput = {
    localDate: "2026-08-26",
    sneezing: 1,
    runnyNose: 2,
    nasalCongestion: 3,
    nasalItching: 0,
    notes: null,
    idempotencyKey: "local-symptom-1"
  };
  const firstSymptom = await client.command("record symptom add", symptomInput, { auth: true });
  const replayedSymptom = await client.command("record symptom add", symptomInput, { auth: true });
  assert.equal(replayedSymptom.id, firstSymptom.id, "重复提交应重放原记录而不是新增一条");
  await assert.rejects(
    client.command("record symptom add", { ...symptomInput, sneezing: 2 }, { auth: true }),
    (reason: unknown) => (reason as { code?: string }).code === "conflict"
  );
  await assert.rejects(
    client.command("record symptom add", { ...symptomInput, idempotencyKey: "local-symptom-conflict" }, { auth: true }),
    (reason: unknown) => (reason as { code?: string }).code === "conflict"
  );
  await assert.rejects(
    client.command("record symptom add", { ...symptomInput, localDate: "2099-01-01", idempotencyKey: "future" }, { auth: true }),
    (reason: unknown) => (reason as { code?: string }).code === "validation_failed"
  );
  await assert.rejects(
    client.command("record symptom add", { ...symptomInput, sneezing: 4, idempotencyKey: "bad-score" }, { auth: true }),
    (reason: unknown) => (reason as { code?: string }).code === "validation_failed"
  );

  const restoredClient = createClient(wxMock.api, options);
  const overview = await restoredClient.command("record overview", {}, { auth: true });
  const calendar = await restoredClient.command("record calendar", { month: "2026-08" }, { auth: true });
  const trend = await restoredClient.command("record trend", { from: "2026-08-01", to: "2026-08-31" }, { auth: true });
  const profile = await restoredClient.command("record profile show", {}, { auth: true });
  const unread = await restoredClient.command("browse message unread-count", {}, { auth: true });

  assert.deepEqual({
    recentSymptomDate: overview.recentSymptomDate,
    monthRecordCount: overview.monthRecordCount,
    lastTnss: overview.lastTnss,
    calendarTotal: calendar.days[0]?.tnssTotal,
    trendTotal: trend.items[0]?.tnssTotal,
    displayName: profile.displayName,
    unread: unread.count
  }, {
    recentSymptomDate: "2026-08-26",
    monthRecordCount: 1,
    lastTnss: 6,
    calendarTotal: 6,
    trendTotal: 6,
    displayName: "体验患者",
    unread: 0
  });
  assert.equal(wxMock.loginCount(), 0);
  assert.equal(calls.length, 0);
});

test("客户体验版真实页面链路可授权、保存症状并在日历和我的页回显", async () => {
  const wxMock = createWxMock(() => { throw new Error("本地体验链路不应发送网络请求"); });
  const requestExports = loadModule("utils/request.js", { wx: wxMock.api }, {
    apiBaseUrl: "https://example.test",
    requestTimeoutMs: 1000,
    wechatLoginEnabled: false,
    anonymousRecordsEnabled: true
  });
  const createClient = requestExports.createClient as (
    api: typeof wxMock.api,
    options: { apiBaseUrl: string; requestTimeoutMs: number; wechatLoginEnabled: boolean; anonymousRecordsEnabled: boolean }
  ) => Record<string, any>;
  const api = {
    ...createClient(wxMock.api, {
      apiBaseUrl: "https://example.test",
      requestTimeoutMs: 1000,
      wechatLoginEnabled: false,
      anonymousRecordsEnabled: true
    }),
    wechatLoginEnabled: false,
    anonymousRecordsEnabled: true
  };
  const navigations: string[] = [];
  const wxPage = {
    ...wxMock.api,
    showToast: () => undefined,
    switchTab: ({ url }: { url: string }) => navigations.push(url),
    navigateTo: ({ url }: { url: string }) => navigations.push(url)
  };
  const pageUtils = { selectTab: () => undefined, errorMessage: (error: any) => error?.message || "加载失败" };
  const dateUtils = loadModule("utils/date.js");
  const symptom = loadPage("pages/symptom-edit/index.js", {
    "../../utils/request": api,
    "../../utils/date": dateUtils,
    "../../utils/page": pageUtils
  }, wxPage);
  symptom.setData = (changes) => { symptom.data = { ...symptom.data, ...changes }; };
  symptom.onLoad({ date: "2026-08-26" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(symptom.data.error, "");
  assert.equal(symptom.data.consentGranted, false);
  symptom.setData({ consentAccepted: true });
  symptom.grantConsent();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(symptom.data.consentGranted, true);
  symptom.setData({ scores: { sneezing: 1, runnyNose: 2, nasalCongestion: 1, nasalItching: 0 } });
  symptom.save();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const calendar = loadPage("pages/calendar/index.js", {
    "../../utils/request": api,
    "../../utils/date": dateUtils,
    "../../utils/page": pageUtils
  }, wxPage);
  calendar.setData = (changes) => { calendar.data = { ...calendar.data, ...changes }; };
  calendar.onShow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calendar.data.error, "");
  assert.equal(calendar.data.trend.length, 1);
  assert.equal(calendar.data.trend[0]?.tnssTotal, 4);
  assert.equal(calendar.data.cells.find((cell: any) => cell.date === "2026-08-26")?.hasSymptom, true);

  const mine = loadPage("pages/mine/index.js", {
    "../../utils/request": api,
    "../../utils/page": pageUtils
  }, wxPage);
  mine.setData = (changes) => { mine.data = { ...mine.data, ...changes }; };
  mine.onShow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(mine.data.overviewError, "");
  assert.equal(mine.data.profileError, "");
  assert.equal(mine.data.unreadError, "");
  assert.equal(mine.data.overview.monthRecordCount, 1);
  assert.equal(mine.data.overview.lastTnss, 4);
  assert.equal(mine.data.localExperience, true);
});

test("体验版匿名问助手不触发微信登录并发送无身份请求", async () => {
  const calls: any[] = [];
  let receiveChunk: ((value: { data: ArrayBuffer }) => void) | null = null;
  let loginCount = 0;
  const task = {
    onChunkReceived(listener: (value: { data: ArrayBuffer }) => void) { receiveChunk = listener; },
    abort() { /* noop */ }
  };
  const wx = {
    request(options: any) {
      calls.push(options);
      setTimeout(() => {
        const encoded = new TextEncoder().encode([
          '{"type":"start"}\n',
          '{"type":"done","data":{"message":{"content":"体验回答"}}}\n'
        ].join(""));
        assert.ok(receiveChunk);
        receiveChunk!({ data: encoded.buffer });
        options.success({ statusCode: 200, data: new ArrayBuffer(0) });
      }, 0);
      return task;
    },
    getStorageSync: () => "",
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined,
    login: () => { loginCount += 1; throw new Error("体验版匿名问助手不应触发 wx.login"); }
  };
  const exports = loadModule("utils/request.js", { wx, ArrayBuffer, Uint8Array }, {
    apiBaseUrl: "https://example.test",
    requestTimeoutMs: 1000,
    wechatLoginEnabled: false,
    anonymousAgentEnabled: true
  });
  const client = (exports.createClient as any)(wx, {
    apiBaseUrl: "https://example.test",
    requestTimeoutMs: 1000,
    wechatLoginEnabled: false,
    anonymousAgentEnabled: true
  });
  const result = await client.streamAgent({ message: "你好" }, {});
  assert.equal(result.message.content, "体验回答");
  assert.equal(loginCount, 0);
  assert.equal(calls[0].header.Authorization, "");
});

test("小程序流式请求按 NDJSON 增量输出，并正确还原跨 chunk 的中文 UTF-8", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let receiveChunk: ((value: { data: ArrayBuffer }) => void) | null = null;
  let aborted = false;
  const task = {
    onChunkReceived(listener: (value: { data: ArrayBuffer }) => void) { receiveChunk = listener; },
    abort() { aborted = true; }
  };
  const wx = {
    request(options: any) {
      calls.push(options);
      setTimeout(() => {
        assert.ok(receiveChunk);
        const encoded = new TextEncoder().encode([
          '{"type":"start"}\n',
          '{"type":"delta","content":"你"}\n',
          '{"type":"delta","content":"好"}\n',
          '{"type":"done","data":{"message":{"content":"你好"}}}\n'
        ].join(""));
        const split = encoded.findIndex((value, index) => index > 20 && value >= 0x80);
        receiveChunk!({ data: encoded.slice(0, split + 1).buffer });
        receiveChunk!({ data: encoded.slice(split + 1).buffer });
        options.success({ statusCode: 200, data: new ArrayBuffer(0) });
      }, 0);
      return task;
    },
    getStorageSync: () => "stream-token",
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined,
    login: () => { throw new Error("不应重复登录"); }
  };
  const exports = loadModule("utils/request.js", { wx, ArrayBuffer, Uint8Array }, {
    apiBaseUrl: "https://example.test",
    requestTimeoutMs: 1000,
    wechatLoginEnabled: true
  });
  const createClient = exports.createClient as (api: typeof wx, options: Record<string, unknown>) => {
    streamAgent(input: Record<string, unknown>, handlers: { onStart: () => void; onDelta: (content: string) => void }): Promise<any>;
  };
  const client = createClient(wx, { apiBaseUrl: "https://example.test", requestTimeoutMs: 1000, wechatLoginEnabled: true });
  const starts: number[] = [];
  const deltas: string[] = [];
  const result = await client.streamAgent({ message: "你好" }, {
    onStart: () => starts.push(1),
    onDelta: (content) => deltas.push(content)
  });
  assert.deepEqual(starts, [1]);
  assert.deepEqual(deltas, ["你", "好"]);
  assert.equal(result.message.content, "你好");
  assert.equal(calls[0]?.enableChunked, true);
  assert.equal(calls[0]?.enableHttp2, false);
  assert.equal(calls[0]?.responseType, "arraybuffer");
  assert.equal((calls[0]?.header as Record<string, string>).Authorization, "Bearer stream-token");
  assert.equal(aborted, false);
});

test("小程序流式请求在登录尚未完成时中止也会结束 Promise", async () => {
  let requestCount = 0;
  const wx = {
    request() { requestCount += 1; throw new Error("中止后不应发起业务请求"); },
    getStorageSync: () => "",
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined,
    login() { /* 保持登录 Promise 挂起，验证 abort 能立即收口。 */ }
  };
  const client = (loadModule("utils/request.js", { wx, ArrayBuffer, Uint8Array }, {
    apiBaseUrl: "https://example.test",
    requestTimeoutMs: 1000,
    wechatLoginEnabled: true
  }) as any).createClient(wx, {
    apiBaseUrl: "https://example.test",
    requestTimeoutMs: 1000,
    wechatLoginEnabled: true
  });
  const stream = client.streamAgent({ message: "你好" }, {});
  stream.abort();
  await assert.rejects(stream, (reason: any) => reason?.code === "stream_aborted");
  assert.equal(requestCount, 0);
});

test("小程序日历工具生成完整 42 格并保留服务端症状投影", () => {
  const dateModule = loadModule("utils/date.js") as {
    buildCalendarCells(month: string, days: unknown[]): Array<Record<string, unknown>>;
    monthRange(month: string): { from: string; to: string };
  };
  const cells = dateModule.buildCalendarCells("2026-08", [
    { localDate: "2026-08-17", symptomId: "sym-1", tnssTotal: 6 }
  ]);
  assert.equal(cells.length, 42);
  const range = dateModule.monthRange("2026-02");
  assert.equal(range.from, "2026-02-01");
  assert.equal(range.to, "2026-02-28");
  assert.equal(cells.find((item) => item.date === "2026-08-17")?.tnssTotal, 6);
  assert.equal(cells.find((item) => item.date === "2026-08-17")?.severity, "moderate");
});

test("小程序消息页读取列表，打开未读消息后标记为已读", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const message = {
    id: "message-1",
    title: "本周鼻健康提醒",
    body: "记得记录症状",
    summary: "每周提醒",
    publishedAt: "2026-08-17T08:00:00.000Z",
    readAt: null
  };
  const api = {
    command: async (name: string, input: Record<string, unknown>, options: Record<string, unknown>) => {
      calls.push({ name, input, options });
      if (name === "browse message list") return { items: [message] };
      if (name === "browse message show") return message;
      if (name === "browse message read") return { ...message, readAt: "2026-08-17T08:01:00.000Z" };
      throw new Error(`unexpected command: ${name}`);
    }
  };
  const page = loadPage("pages/messages/index.js", {
    "../../utils/request": api,
    "../../utils/page": { errorMessage: () => "加载失败" }
  });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };

  page.onLoad();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls[0]?.name, "browse message list");
  assert.equal(page.data.items[0]?.displayDate, "2026年8月17日");
  assert.equal(page.data.items[0]?.readAt, null);

  page.openItem({ currentTarget: { dataset: { id: "message-1" } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.slice(1).map((call) => call.name), [
    "browse message show",
    "browse message read"
  ]);
  assert.notEqual(page.data.selected.readAt, null);
  assert.notEqual(page.data.items[0]?.readAt, null);
});

test("小程序消息详情失败时不展示缓存内容，旧请求不能覆盖新选择", async () => {
  const pending: Array<{ id: string; resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = [];
  const api = {
    command: (name: string, input: Record<string, unknown>) => {
      if (name === "browse message list") {
        return Promise.resolve({ items: [
          { id: "message-a", title: "旧消息", body: "旧正文", summary: "旧摘要", publishedAt: "2026-08-17T08:00:00.000Z", readAt: null },
          { id: "message-b", title: "新消息", body: "新正文", summary: "新摘要", publishedAt: "2026-08-17T09:00:00.000Z", readAt: null }
        ] });
      }
      if (name === "browse message show") {
        return new Promise((resolve, reject) => { pending.push({ id: String(input.id), resolve, reject }); });
      }
      throw new Error(`unexpected command: ${name}`);
    }
  };
  const page = loadPage("pages/messages/index.js", {
    "../../utils/request": api,
    "../../utils/page": { errorMessage: () => "消息已下架" }
  });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };

  page.onLoad();
  await new Promise((resolve) => setTimeout(resolve, 0));
  page.openItem({ currentTarget: { dataset: { id: "message-a" } } });
  page.openItem({ currentTarget: { dataset: { id: "message-b" } } });
  assert.deepEqual(pending.map((item) => item.id), ["message-a", "message-b"]);
  pending[0]!.reject({ code: "resource_not_found" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.data.detailLoading, true);
  assert.equal(page.data.error, "");
  pending[1]!.reject({ code: "resource_not_found" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.data.selected, null);
  assert.equal(page.data.detailLoading, false);
  assert.equal(page.data.error, "消息已下架");
});

test("小程序健康档案读取并展示基础信息、过敏原与用药记录", async () => {
  const calls: string[] = [];
  const api = {
    command: async (name: string) => {
      calls.push(name);
      if (name === "account consent show") return { items: [{ consentType: "health_data", decision: "granted" }] };
      if (name === "account privacy") return { policyVersion: "privacy-v1", statement: "健康数据说明" };
      if (name === "record profile show") return { displayName: "小林", birthDate: "1990-01-02", sex: "female", allergyHistory: "花粉过敏史", revision: 2 };
      if (name === "record exposure list") return { items: [{ id: "ex-1", localDate: "2026-08-18", factors: ["pollen", "other"], otherDescription: "装修粉尘", notes: "患者自述当天接触", revision: 1 }] };
      if (name === "record medication list") return { items: [{ id: "med-1", localDate: "2026-08-18", medicationName: "氯雷他定", dosage: "10 mg", actualUse: null, revision: 1 }] };
      throw new Error(`unexpected command: ${name}`);
    }
  };
  const page = loadPage("pages/health-profile/index.js", {
    "../../utils/request": api,
    "../../utils/page": { errorMessage: () => "加载失败" }
  });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };
  page.onLoad();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.data.consentGranted, true);
  assert.equal(page.data.profile.displayName, "小林");
  assert.equal(page.data.profileRevision, 2);
  assert.equal(page.data.exposureItems[0]?.factorsText, "花粉、其它（请简要描述）");
  assert.equal(page.data.medicationItems[0]?.dosageText, "10 mg");
  assert.deepEqual(calls, ["account consent show", "account privacy", "record profile show", "record exposure list", "record medication list"]);
});

test("小程序首页复用 Web 患者首页的信息结构、文案、比例和品牌资产", () => {
  const webHome = readFileSync(resolve("web/src/App.tsx"), "utf8");
  const webStyles = readFileSync(resolve("web/src/styles.css"), "utf8");
  const miniHome = readFileSync(resolve("miniprogram/pages/home/index.wxml"), "utf8");
  const miniStyles = readFileSync(resolve("miniprogram/pages/home/index.wxss"), "utf8");
  const sharedCopy = [
    "安全评估与方案建议",
    "诊一诊",
    "先做服务端规则和操作安全筛查，再匹配已审核康复方案。",
    "已发布科普内容",
    "学一学",
    "方案来自已审核内容，基于福建中医药大学抗敏先锋团队体质调理方案开发。",
    "今日待完成 · 患者自述",
    "过敏原记录",
    "科普文章与视频",
    "趋势展示占位",
    "暂无真实健康记录",
    "为你推荐",
    "今天读点什么",
    "科普文章 · 操作视频 · 调理方案"
  ];
  for (const copy of sharedCopy) {
    assert.ok(webHome.includes(copy), `Web 首页缺少基准文案：${copy}`);
    assert.ok(miniHome.includes(copy), `小程序首页未复用 Web 文案：${copy}`);
  }
  for (const divergentCopy of ["今天，也照顾好自己", "今日健康", "消息中心"]) {
    assert.equal(miniHome.includes(divergentCopy), false, `小程序首页仍残留独立改版文案：${divergentCopy}`);
  }
  assert.deepEqual(
    readFileSync(resolve("web/public/brand-banner.jpg")),
    readFileSync(resolve("miniprogram/assets/brand-banner.jpg"))
  );
  const proportionalStyles = [
    ["min-height: 190px", "min-height: 380rpx"],
    ["min-height: 126px", "min-height: 252rpx"],
    ["grid-template-columns: 1fr 110px", "grid-template-columns: 1fr 220rpx"],
    ["min-height: 105px", "min-height: 210rpx"]
  ] as const;
  for (const [webValue, miniValue] of proportionalStyles) {
    assert.ok(webStyles.includes(webValue), `Web 当前比例基准已变化：${webValue}`);
    assert.ok(miniStyles.includes(miniValue), `小程序未按 2rpx 映射当前 Web 比例：${miniValue}`);
  }
  for (const sharedColor of ["#daeadd", "#f5e8d7", "#8eb8a4", "#3d7c65", "#b8d6c9"]) {
    assert.ok(webStyles.includes(sharedColor), `Web 当前配色基准已变化：${sharedColor}`);
    assert.ok(miniStyles.includes(sharedColor), `小程序未复用当前 Web 配色：${sharedColor}`);
  }
  for (const staleColor of ["#dbe9f8", "#7fa7d3", "#285f9f", "#b7cee8"]) {
    assert.equal(miniStyles.includes(staleColor), false, `小程序仍残留旧首页配色：${staleColor}`);
  }
});

test("小程序首页只读取记录概览，并保持与 Web 一致的四条入口", async () => {
  const calls: string[] = [];
  const navigations: string[] = [];
  const api = {
    command: async (name: string) => {
      calls.push(name);
      return { recentSymptomDate: "2026-08-23", monthRecordCount: 3, consecutiveDays: 2 };
    }
  };
  const page = loadPage("pages/home/index.js", {
    "../../utils/request": api,
    "../../utils/page": { selectTab: () => undefined, errorMessage: () => "加载失败" }
  }, {
    navigateTo: ({ url }: { url: string }) => navigations.push(url),
    switchTab: ({ url }: { url: string }) => navigations.push(url)
  });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };
  page.onShow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["record overview"]);
  assert.equal(page.data.hasOverviewData, true);
  page.openAllergenRecord();
  page.openLearn();
  page.openAssistant();
  page.openCalendar();
  assert.deepEqual(navigations, [
    "/pages/health-profile/index?focus=exposure",
    "/pages/learn/index",
    "/pages/assistant/index",
    "/pages/calendar/index"
  ]);
});

test("小程序首页过敏原入口在授权并加载后定位到当天记录表单", async () => {
  const scrollCalls: Array<Record<string, unknown>> = [];
  const api = {
    command: async (name: string) => {
      if (name === "account consent show") return { items: [{ consentType: "health_data", decision: "granted" }] };
      if (name === "account privacy") return { policyVersion: "privacy-v1", statement: "健康数据说明" };
      if (name === "record profile show") return { revision: 0 };
      if (name === "record exposure list" || name === "record medication list") return { items: [] };
      throw new Error(`unexpected command: ${name}`);
    }
  };
  const page = loadPage("pages/health-profile/index.js", {
    "../../utils/request": api,
    "../../utils/page": { errorMessage: () => "加载失败" }
  }, {
    setNavigationBarTitle: () => undefined,
    pageScrollTo: (options: Record<string, unknown>) => scrollCalls.push(options)
  });
  page.setData = (changes, callback) => {
    page.data = { ...page.data, ...changes };
    if (typeof callback === "function") callback();
  };
  page.onLoad({ focus: "exposure" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(scrollCalls.length, 1);
  assert.equal(scrollCalls[0]?.selector, "#exposure-record");
  assert.equal(scrollCalls[0]?.duration, 300);
  assert.match(readFileSync(resolve("miniprogram/pages/health-profile/index.wxml"), "utf8"), /id="exposure-record"[\s\S]*过敏原暴露记录/u);
});

test("小程序我的页不把档案和概览读取失败伪装成空数据", async () => {
  const api = {
    command: async (name: string) => {
      if (name === "account privacy") return { policyVersion: "privacy-v1", statement: "健康数据说明" };
      throw { code: name === "record overview" ? "network_error" : "authentication_required" };
    }
  };
  const page = loadPage("pages/mine/index.js", {
    "../../utils/request": api,
    "../../utils/page": { selectTab: () => {}, errorMessage: (error: any) => error.code === "network_error" ? "网络暂时不可用" : "请先登录" }
  });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };
  page.onShow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.data.overview, null);
  assert.equal(page.data.overviewError, "网络暂时不可用");
  assert.equal(page.data.profile, null);
  assert.equal(page.data.profileError, "请先登录");
});

test("小程序科普中心支持已发布方案详情和知识库问答入口", async () => {
  const calls: string[] = [];
  const api = {
    command: async (name: string, input: Record<string, unknown>) => {
      calls.push(name);
      if (name === "browse plan list") return { items: [{ id: "plan-1", name: "日常护理", publishedRevision: 1 }] };
      if (name === "browse plan show") return { id: "plan-1", name: "日常护理", summary: "按已审核步骤进行", steps: [{ step: 1, title: "记录症状", description: "按日记录" }], precautions: "不替代诊断", risks: "", contraindications: "", disclaimer: "仅供科普" };
      if (name === "agent knowledge ask") {
        assert.equal(input.question, "换季鼻塞怎么办");
        return { answer: "请先查看已审核资料。", sources: [{ knowledgeId: "k-1", name: "鼻健康手册", source: "团队资料" }], disclaimer: "仅供科普" };
      }
      throw new Error(`unexpected command: ${name}`);
    }
  };
  const page = loadPage("pages/learn/index.js", {
    "../../utils/request": { ...api, mediaUrl: (value: string) => value },
    "../../utils/page": { errorMessage: () => "加载失败" },
    "../../utils/content-body": { parseContentBody: () => [] },
    "../../utils/learning-catalog": loadModule("utils/learning-catalog.js")
  });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };
  page.onLoad({ kind: "plan" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.data.plans[0]?.name, "日常护理");
  page.openPlan({ currentTarget: { dataset: { id: "plan-1" } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.data.detail.steps[0].title, "记录症状");
  page.setData({ kind: "qa", qaQuestion: "换季鼻塞怎么办" });
  page.askKnowledge();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.data.qaAnswer.answer, "请先查看已审核资料。");
  assert.deepEqual(calls, ["browse plan list", "browse plan show", "agent knowledge ask"]);
});

test("小程序学一学对明确人群分类排他，歧义标题不跨人群兜底", () => {
  const catalog = loadModule("utils/learning-catalog.js") as {
    catalogs: Array<{ sections: Array<{ categories: Array<Record<string, unknown>> }> }>;
    belongsToCategory(item: Record<string, unknown>, category: Record<string, unknown>): boolean;
  };
  const adultQuick = catalog.catalogs[0]!.sections[0]!.categories[0]!;
  const childQuick = catalog.catalogs[1]!.sections[0]!.categories[0]!;
  const shared = { category: "儿童快速通窍", title: "鼻三线姜刮" };
  assert.equal(catalog.belongsToCategory(shared, adultQuick), false);
  assert.equal(catalog.belongsToCategory(shared, childQuick), true);
  assert.equal(catalog.belongsToCategory({ category: "", title: "鼻三线姜刮" }, adultQuick), false);
  assert.equal(catalog.belongsToCategory({ category: "", title: "鼻三线姜刮" }, childQuick), false);
});

test("小程序学一学固定四入口、目录内视频列表和五项主导航", async () => {
  const titles: string[] = [];
  const navigations: string[] = [];
  const api = {
    wechatLoginEnabled: false,
    mediaUrl: (value: string) => value,
    command: async (name: string) => {
      if (name === "browse video list") {
        return { items: [
          { id: "adult-1", category: "成人快速通窍", title: "迎香穴" },
          { id: "child-1", category: "儿童快速通窍", title: "鼻三线姜刮" }
        ] };
      }
      throw new Error(`unexpected command: ${name}`);
    }
  };
  const page = loadPage("pages/learn/index.js", {
    "../../utils/request": api,
    "../../utils/page": { errorMessage: () => "加载失败" },
    "../../utils/content-body": { parseContentBody: () => [] },
    "../../utils/learning-catalog": loadModule("utils/learning-catalog.js")
  }, {
    setNavigationBarTitle: ({ title }: { title: string }) => titles.push(title),
    navigateTo: ({ url }: { url: string }) => navigations.push(`navigate:${url}`),
    switchTab: ({ url }: { url: string }) => navigations.push(`tab:${url}`)
  });
  page.setData = (changes, callback) => {
    page.data = { ...page.data, ...changes };
    if (typeof callback === "function") callback();
  };

  page.onLoad({ kind: "video" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(titles.at(-1), "学一学");
  assert.deepEqual(page.data.items.map((item: { id: string }) => item.id), ["adult-1"]);
  page.switchKind({ currentTarget: { dataset: { kind: "qa" } } });
  assert.equal(page.data.kind, "qa");
  assert.match(page.data.knowledgeNotice, /暂不可用/u);
  page.switchPrimary({ currentTarget: { dataset: { mode: "navigate", url: "/pages/symptom-edit/index" } } });
  page.switchPrimary({ currentTarget: { dataset: { mode: "tab", url: "/pages/home/index" } } });
  assert.deepEqual(navigations, ["navigate:/pages/symptom-edit/index", "tab:/pages/home/index"]);

  const template = readFileSync(resolve("miniprogram/pages/learn/index.wxml"), "utf8");
  const config = JSON.parse(readFileSync(resolve("miniprogram/pages/learn/index.json"), "utf8"));
  assert.equal(config.navigationBarTitleText, "学一学");
  for (const label of ["操作视频", "科普文章", "调理方案", "知识问答"]) {
    assert.ok(template.includes(`>${label}</view>`), `缺少固定入口：${label}`);
  }
  const catalogMainStart = template.indexOf('<view class="catalog-main">');
  const videoListStart = template.indexOf('<view wx:else class="video-list">');
  const catalogMainEnd = template.indexOf("</view>\n      </view>\n    </view>", videoListStart);
  assert.ok(catalogMainStart >= 0 && videoListStart > catalogMainStart && catalogMainEnd > videoListStart, "视频列表必须位于目录主容器内");
  for (const label of ["首页", "问助手", "记录", "日历", "我的"]) {
    assert.ok(template.includes(`<text>${label}</text>`), `缺少主导航项：${label}`);
  }
});

test("小程序问助手删除页面内重复摘要和对话按钮，保留抽屉、结果卡和发送入口", () => {
  const web = readFileSync(resolve("web/src/App.tsx"), "utf8");
  const webStyles = readFileSync(resolve("web/src/styles.css"), "utf8");
  const mini = readFileSync(resolve("miniprogram/pages/assistant/index.wxml"), "utf8");
  const miniStyles = readFileSync(resolve("miniprogram/pages/assistant/index.wxss"), "utf8");
  const miniConfig = JSON.parse(readFileSync(resolve("miniprogram/pages/assistant/index.json"), "utf8"));
  const tabBar = readFileSync(resolve("miniprogram/custom-tab-bar/index.wxml"), "utf8");
  const questionnaire = loadModule("utils/questionnaire.js") as { questions: unknown };

  for (const sharedCopy of ["问问题或描述症状…"]) {
    assert.ok(web.includes(sharedCopy), `Web 当前问助手基准已变化：${sharedCopy}`);
    assert.ok(mini.includes(sharedCopy), `小程序问助手未复用 Web 当前文案：${sharedCopy}`);
  }
  for (const patientCopy of ["测一测我的鼻敏感情况", "约 2 分钟，回答几个简单问题", "开始测评"]) {
    assert.ok(mini.includes(patientCopy), `小程序问卷入口缺少患者文案：${patientCopy}`);
  }
  for (const sharedClass of ["custom-navigation", "navigation-subtitle", "menu-hitarea", "history-drawer", "new-chat-button", "time-label", "mini-avatar", "start-card", "composer-mascot", "composer-placeholder", "pending-option"]) {
    assert.ok(mini.includes(sharedClass), `小程序问助手缺少当前结构：${sharedClass}`);
  }
  for (const sharedStyle of ["margin: 20rpx 0 32rpx 68rpx", "width: 130rpx", "bottom: calc(108rpx + env(safe-area-inset-bottom))", "bottom: 100%"]) {
    assert.ok(miniStyles.includes(sharedStyle), `小程序问助手未锁定当前 Web 比例：${sharedStyle}`);
  }
  for (const sharedCopy of ["新建聊天", "评估已完成", "观看操作视频", "继续追问当前方案…"]) {
    assert.ok(mini.includes(sharedCopy), `小程序问助手未复用 Web 当前结构文案：${sharedCopy}`);
  }
  assert.equal(mini.includes("安全评估与方案建议"), false, "页面内不应重复展示评估摘要");
  assert.equal(mini.includes("历史对话"), false, "页面内不应重复展示历史对话按钮");
  for (const staleCopy of ["通过对话采集症状", "服务端会继续核对", "内容仅供健康科普与居家管理参考"]) {
    assert.equal(mini.includes(staleCopy), false, `小程序问助手仍残留旧版独立文案：${staleCopy}`);
  }
  assert.ok(mini.includes("聊天记录"), "侧滑抽屉应显示聊天记录标题");
  assert.ok(mini.includes("暂无聊天记录"), "微信能力不可用时应降级为空历史态");
  assert.ok(mini.includes("鼻健康智能助手"), "标题栏应与 Web 问助手名称对齐");
  assert.ok(mini.includes("问助手暂未开放"), "微信登录未配置时应使用中性不可用态");
  assert.ok(mini.includes("class=\"start-action\""), "问卷入口应提供明确的开始评估行动按钮");
  assert.ok(mini.includes('aria-label="新建聊天"'), "侧滑抽屉应提供可访问的新建聊天入口");
  assert.equal(mini.includes('button class="menu-button"'), false, "标题栏菜单不应使用命中盒可能扩大的原生 button");
  assert.ok(mini.includes("class=\"send-button {{(!hydrated || sending || !canSend || capabilityUnavailable) ? 'disabled' : ''}}\""), "小程序端应提供与 Web 一致的发送入口");
  assert.ok(mini.includes("confirm-type=\"send\""), "小程序端应同时保留键盘发送入口");
  assert.ok(mini.includes("class=\"result-card\""), "完成评估后应以 Web 同构的结果卡呈现方案");
  assert.equal(mini.includes("class=\"chat-toolbar\""), false, "页面内重复对话工具栏应删除");
  assert.ok(mini.includes("/assets/assistant-avatar.png"), "小程序端应使用作者提供的问助手头像");
  assert.equal(mini.includes('class="mini-avatar">抗'), false, "问助手头像不应继续使用文字占位");
  assert.ok(mini.includes("/assets/assistant-mascot-loop-v3.gif"), "小程序端应使用透明背景的循环吉祥物资产");
  assert.ok(mini.includes('class="pending-option {{sending ? \'disabled\' : \'\'}}"'), "补问题选项应使用不受原生 button 居中规则影响的点击容器");
  assert.ok(miniStyles.includes(".pending-card { width: calc(100% - 68rpx);"), "补问题卡应与聊天内容区对齐并避开助手头像");
  assert.ok(miniStyles.includes(".pending-question { width: 100%;"), "补问题目应撑满卡片宽度");
  assert.ok(miniStyles.includes(".pending-option > text:last-child"), "补问题选项文字应占满余下横向空间");
  assert.equal(miniStyles.includes(".assessment-banner"), false, "已删除的评估摘要不应残留样式");
  assert.ok(miniStyles.includes(".plan-video-button"), "小程序结果卡应提供匹配视频入口");
  assert.equal(miniStyles.includes("margin-left: 130rpx"), false, "吉祥物站到输入区上沿后不应留下空白占位");
  assert.equal(miniConfig.navigationBarTitleText, "抗敏先锋");
  assert.equal(miniConfig.navigationStyle, "custom");
  assert.ok(tabBar.includes('wx:if="{{!hidden}}"'), "聊天抽屉打开时应能隐藏独立自定义底栏");
  assert.ok(tabBar.includes('class="icon-mark"'), "底栏图标应保留统一的细节绘制层");
  assert.ok(readFileSync(resolve("miniprogram/custom-tab-bar/index.wxss"), "utf8").includes("selected:not(.action) .glyph"), "选中态应只突出图标，不铺满整块底栏入口");
  assert.ok(readFileSync(resolve("miniprogram/custom-tab-bar/index.wxss"), "utf8").includes("translateY(-8rpx)"), "记录主按钮应留在底栏横线以内");
  assert.ok(readFileSync(resolve("miniprogram/custom-tab-bar/index.wxss"), "utf8").includes("translate(-50%,-50%)"), "记录按钮十字应按几何中心绘制");
  assert.equal(JSON.stringify(questionnaire.questions), JSON.stringify(ASSESSMENT_QUESTIONS));
  assert.ok(webStyles.includes(".start-card"));
});

test("小程序聊天记录在微信能力未配置时降级为空态，不暴露环境配置错误", async () => {
  const api = {
    command: async (name: string) => {
      assert.equal(name, "agent conversations list");
      throw { code: "capability_unavailable", message: "微信登录尚未配置" };
    }
  };
  const page = loadPage("pages/assistant/index.js", {
    "../../utils/request": api,
    "../../utils/page": { selectTab: () => undefined, errorMessage: () => "不应展示的环境配置错误" }
  }, {
    getStorageSync: () => "",
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined
  });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };

  page.toggleHistory();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.data.historyLoading, false);
  assert.equal(page.data.historyUnavailable, true);
  assert.equal(page.data.historyError, "");
  assert.equal(page.data.history.length, 0);
});

test("小程序问助手在微信登录未配置时不展示红色配置错误", async () => {
  const calls: string[] = [];
  const api = {
    wechatLoginEnabled: false,
    command: async () => { throw new Error("不应调用私有接口"); },
    streamAgent: async () => { calls.push("stream"); throw { code: "capability_unavailable", message: "微信登录尚未配置" }; }
  };
  const page = loadPage("pages/assistant/index.js", {
    "../../utils/request": api,
    "../../utils/page": { selectTab: () => undefined, errorMessage: () => "不应展示的环境配置错误" }
  }, {
    getStorageSync: () => "",
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined
  });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };

  page.onLoad();
  assert.equal(page.data.capabilityUnavailable, true);
  assert.equal(page.data.startAvailable, false);
  assert.equal(page.data.canSend, false);
  assert.equal(page.data.error, "");
  page.beginConsultation();
  page.sendCurrent();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, []);
  assert.equal(page.data.error, "");
});

test("小程序体验版在微信登录关闭时开放匿名问助手入口", async () => {
  const inputs: Record<string, unknown>[] = [];
  const api = {
    wechatLoginEnabled: false,
    anonymousAgentEnabled: true,
    command: async (name: string) => { throw new Error(`体验版不应调用私有命令：${name}`); },
    streamAgent: async (input: Record<string, unknown>) => {
      inputs.push(input);
      return {
        conversationId: "anonymous-conversation-1",
        state: "active",
        message: { content: "体验回答" },
        notices: [],
        verdict: { outcome: "need_more_information", nextQuestions: [] },
        closed: false
      };
    }
  };
  const page = loadPage("pages/assistant/index.js", {
    "../../utils/request": api,
    "../../utils/page": { selectTab: () => undefined, errorMessage: () => "不应展示的环境配置错误" }
  }, {
    getStorageSync: () => "",
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined
  });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };

  page.onLoad();
  assert.equal(page.data.capabilityUnavailable, false);
  assert.equal(page.data.startAvailable, true);
  assert.equal(page.data.canSend, true);
  page.beginConsultation();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.startMode, "inherit_assessment");
  assert.equal(page.data.error, "");
  assert.equal(page.data.messages.some((item: any) => item.text === "体验回答"), true);
});

test("小程序匿名体验忽略遗留会话 ID，不因历史接口受保护而降级", () => {
  let removed = 0;
  const api = {
    wechatLoginEnabled: false,
    anonymousAgentEnabled: true,
    command: () => { throw new Error("匿名体验不应恢复受保护的历史会话"); }
  };
  const page = loadPage("pages/assistant/index.js", {
    "../../utils/request": api,
    "../../utils/page": { selectTab: () => undefined, errorMessage: () => "加载失败" }
  }, {
    getStorageSync: () => "anonymous-conversation-leftover",
    setStorageSync: () => undefined,
    removeStorageSync: () => { removed += 1; }
  });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };

  page.onLoad();
  assert.equal(removed, 1);
  assert.equal(page.data.capabilityUnavailable, false);
  assert.equal(page.data.startAvailable, true);
  assert.equal(page.data.canSend, true);
});

test("小程序问助手请求返回微信能力未配置时回退到中性不可用态", async () => {
  const api = {
    command: async (name: string) => { throw new Error(`unexpected command: ${name}`); },
    streamAgent: async () => { throw { code: "capability_unavailable", message: "微信登录尚未配置" }; }
  };
  const page = loadPage("pages/assistant/index.js", {
    "../../utils/request": api,
    "../../utils/page": { selectTab: () => undefined, errorMessage: () => "不应展示的环境配置错误" }
  }, {
    getStorageSync: () => "",
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined
  });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };

  page.onLoad();
  page.onInput({ detail: { value: "请结合我最近的评估，告诉我当前方案重点" } });
  page.sendCurrent();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.data.capabilityUnavailable, true);
  assert.equal(page.data.error, "");
  assert.equal(page.data.retryMessage, "");
  assert.equal(page.data.messages.length, 1);
  assert.equal(page.data.messages[0]?.id, "welcome");
  assert.equal(page.data.input, "");
});

test("小程序问助手复用服务端会话，支持首轮评估、续问和结果收口", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const storage: Record<string, string> = {};
  let turnCount = 0;
  const api = {
    command: async (name: string, input: Record<string, unknown>, options: Record<string, unknown>) => {
      if (name === "browse video list") {
        assert.equal(options.auth, false);
        return { items: [{ id: "video-nasal-line", kind: "video", category: "成人快速通窍", title: "鼻三线姜姜刮" }] };
      }
      throw new Error(`unexpected command: ${name}`);
    },
    streamAgent: async (input: Record<string, unknown>, handlers: { onStart: () => void; onDelta: (content: string) => void }) => {
      const options = { auth: true };
      calls.push({ name: "agent exec", input, options });
      assert.equal(options.auth, true);
      turnCount += 1;
      handlers.onStart();
      if (turnCount === 1) {
        handlers.onDelta("为了继续评估，请回答下面的问题。");
        return {
          conversationId: "conversation-1",
          state: "active",
          message: { content: "为了继续评估，请回答下面的问题。" },
          notices: [],
          verdict: {
            outcome: "need_more_information",
            nextQuestions: [{ fieldCode: "q1", prompt: "您打喷嚏的情况是？" }]
          },
          closed: false
        };
      }
      handlers.onDelta("【缓解期】\n已完成当前评估，请结合页面中的已审核方案。\n1. 鼻三线姜姜刮\n【操作视频】\n操作视频已提供（见视频资源）。");
      return {
        conversationId: "conversation-1",
        state: "completed",
        message: { content: "【缓解期】\n已完成当前评估，请结合页面中的已审核方案。\n1. 鼻三线姜姜刮\n【操作视频】\n操作视频已提供（见视频资源）。" },
        notices: [{ content: "结果仅供健康管理参考。" }],
        verdict: { outcome: "classified", nextQuestions: [] },
        closed: true
      };
    }
  };
  const wx = {
    setNavigationBarTitle: () => undefined,
    getStorageSync: (key: string) => storage[key] ?? "",
    setStorageSync: (key: string, value: string) => { storage[key] = value; },
    removeStorageSync: (key: string) => { delete storage[key]; }
  };
  const page = loadPage("pages/assistant/index.js", {
    "../../utils/request": api,
    "../../utils/page": { selectTab: () => undefined, errorMessage: () => "加载失败" }
  }, wx);
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };

  page.onLoad();
  assert.equal(page.data.hydrated, true);
  page.beginConsultation();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls[0]?.name, "agent exec");
  assert.equal(calls[0]?.input.startMode, "inherit_assessment");
  assert.equal(calls[0]?.input.conversationId, undefined);
  assert.equal(page.data.conversationId, "conversation-1");
  assert.equal(page.data.pendingQuestions[0]?.fieldCode, "q1");
  assert.equal(page.data.pendingQuestions[0]?.title, "您打喷嚏的情况是？");
  assert.equal(page.data.pendingQuestions[0]?.options[0]?.value, "q1=A");
  assert.equal(storage["kangmin.agent.conversationId"], "conversation-1");

  page.answerPending({ currentTarget: { dataset: { value: "q1=A" } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls[1]?.input.conversationId, "conversation-1");
  assert.equal(calls[1]?.input.message, "q1=A");
  assert.equal(calls[1]?.input.startMode, undefined);
  assert.equal(page.data.conversationState, "completed");
  assert.equal(page.data.followUpEnabled, true);
  assert.equal(page.data.pendingQuestions.length, 0);
  assert.equal(page.data.messages.some((item: any) => item.kind === "result"), true);
  const result = page.data.messages.find((item: any) => item.kind === "result");
  assert.equal(result?.resultPhase, "缓解期");
  assert.equal(result?.resultBlocks?.some((block: any) => block.text === "已完成当前评估，请结合页面中的已审核方案。"), true);
  assert.equal(result?.resultBlocks?.some((block: any) => block.type === "video" && block.id === "video-nasal-line"), true);
  assert.equal(page.data.messages.some((item: any) => item.kind === "notice"), true);
});

test("小程序问助手恢复历史时只展示患者可读内容，并保留补问状态", async () => {
  const storage: Record<string, string> = { "kangmin.agent.conversationId": "conversation-2" };
  const calls: string[] = [];
  const api = {
    command: async (name: string) => {
      calls.push(name);
      if (name === "agent conversations show") {
        return {
          session: { id: "conversation-2", state: "active" },
          messages: [
            { id: "m-1", role: "user", content: "q1=A", createdAt: "2026-08-17T08:00:00.000Z" },
            { id: "m-2", role: "assistant", content: "请继续回答。", createdAt: "2026-08-17T08:01:00.000Z" }
          ],
          lastDecision: {
            outcome: "need_more_information",
            nextQuestions: [{ fieldCode: "q2", prompt: "您的鼻涕通常是？" }]
          }
        };
      }
      if (name === "agent conversations list") {
        return { items: [{ id: "conversation-2", state: "active", createdAt: "2026-08-17T08:00:00.000Z", updatedAt: "2026-08-17T08:01:00.000Z" }] };
      }
      throw new Error(`unexpected command: ${name}`);
    }
  };
  const wx = {
    setNavigationBarTitle: () => undefined,
    getStorageSync: (key: string) => storage[key] ?? "",
    setStorageSync: (key: string, value: string) => { storage[key] = value; },
    removeStorageSync: (key: string) => { delete storage[key]; }
  };
  const page = loadPage("pages/assistant/index.js", {
    "../../utils/request": api,
    "../../utils/page": { selectTab: () => undefined, errorMessage: () => "加载失败" }
  }, wx);
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };

  page.onLoad();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["agent conversations show"]);
  assert.equal(page.data.conversationState, "active");
  assert.equal(page.data.pendingQuestions[0]?.fieldCode, "q2");
  assert.equal(page.data.messages.some((item: any) => item.text === "频繁打喷嚏，一次连续数个至十几个"), true);
  assert.equal(page.data.messages.some((item: any) => item.text === "第 1 题：选择 A"), false);
  assert.equal(page.data.messages.some((item: any) => item.text === "q1=A"), false);

  page.toggleHistory();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["agent conversations show", "agent conversations list"]);
  assert.equal(page.data.history[0]?.stateLabel, "进行中");
  assert.equal(page.data.historyOpen, true);
  page.closeHistory();
  assert.equal(page.data.historyOpen, false);
});

test("小程序问助手失败时移除思考态、保留输入并提供安全重试", async () => {
  let attempts = 0;
  const api = {
    command: async (name: string) => {
      throw new Error(`unexpected command: ${name}`);
    },
    streamAgent: async () => {
      attempts += 1;
      if (attempts === 1) throw { code: "network_error", message: "网络暂时不可用" };
      return {
        conversationId: "conversation-3",
        state: "active",
        message: { content: "请继续回答服务端问题。" },
        notices: [],
        verdict: { outcome: "need_more_information", nextQuestions: [] },
        closed: false
      };
    }
  };
  const page = loadPage("pages/assistant/index.js", {
    "../../utils/request": api,
    "../../utils/page": { selectTab: () => undefined, errorMessage: () => "网络暂时不可用" }
  }, {
    setNavigationBarTitle: () => undefined,
    getStorageSync: () => "",
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined
  });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };

  page.onLoad();
  page.onInput({ detail: { value: "我最近鼻塞" } });
  page.sendCurrent();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.data.sending, false);
  assert.equal(page.data.retryMessage, "我最近鼻塞");
  assert.equal(page.data.input, "我最近鼻塞");
  assert.equal(page.data.messages.some((item: any) => item.kind === "thinking"), false);
  assert.equal(page.data.error, "网络暂时不可用");

  page.retry();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 2);
  assert.equal(page.data.conversationId, "conversation-3");
  assert.equal(page.data.error, "");
});
