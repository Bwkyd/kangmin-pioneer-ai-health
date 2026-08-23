import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

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
    require: () => requireValue,
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
    require: (name: string) => modules[name] ?? {},
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
  const storage: Record<string, string> = initialToken
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
      setStorageSync: (key: string, value: string) => { storage[key] = value; },
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

test("小程序问助手复用服务端会话，支持首轮评估、续问和结果收口", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const storage: Record<string, string> = {};
  let turnCount = 0;
  const api = {
    command: async (name: string, input: Record<string, unknown>, options: Record<string, unknown>) => {
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
      handlers.onDelta("【缓解期】\n已完成当前评估，请结合页面中的已审核方案。");
      return {
        conversationId: "conversation-1",
        state: "completed",
        message: { content: "【缓解期】\n已完成当前评估，请结合页面中的已审核方案。" },
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
  assert.equal(storage["kangmin.agent.conversationId"], "conversation-1");

  page.onInput({ detail: { value: "最近鼻塞比较明显" } });
  page.sendCurrent();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls[1]?.input.conversationId, "conversation-1");
  assert.equal(calls[1]?.input.startMode, undefined);
  assert.equal(page.data.conversationState, "completed");
  assert.equal(page.data.followUpEnabled, true);
  assert.equal(page.data.pendingQuestions.length, 0);
  assert.equal(page.data.messages.some((item: any) => item.kind === "result"), true);
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
  assert.equal(page.data.messages.some((item: any) => item.text === "第 1 题：选择 A"), true);
  assert.equal(page.data.messages.some((item: any) => item.text === "q1=A"), false);

  page.toggleHistory();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["agent conversations show", "agent conversations list"]);
  assert.equal(page.data.history[0]?.stateLabel, "进行中");
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
