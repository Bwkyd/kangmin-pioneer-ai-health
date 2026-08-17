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
