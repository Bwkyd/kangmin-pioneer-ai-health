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
  setData?: (changes: Record<string, any>) => void;
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

test("小程序问助手复用服务端会话，支持首轮评估、续问和结果收口", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const storage: Record<string, string> = {};
  let turnCount = 0;
  const api = {
    command: async (name: string, input: Record<string, unknown>, options: Record<string, unknown>) => {
      calls.push({ name, input, options });
      assert.equal(options.auth, true);
      assert.equal(name, "agent exec");
      turnCount += 1;
      if (turnCount === 1) {
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
      assert.equal(name, "agent exec");
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
