import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const miniprogramRoot = "apps/kangmin-miniprogram/src";
interface CommonJsModule { exports: Record<string, unknown> }

function loadModule(
  relativePath: string,
  globals: Record<string, unknown> = {},
  requireValue: Record<string, unknown> = {}
): Record<string, unknown> {
  const module: CommonJsModule = { exports: {} };
  const source = readFileSync(resolve(miniprogramRoot, relativePath), "utf8");
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
  const source = readFileSync(resolve(miniprogramRoot, relativePath), "utf8");
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

function createWxMock(handler: (options: RequestOptions) => void) {
  let loginCount = 0;
  return {
    api: {
      request: handler,
      login: ({ success }: { success(value: { code: string }): void }) => {
        loginCount += 1;
        success({ code: `login-code-${loginCount}` });
      },
      getStorageSync: () => "",
      setStorageSync: () => undefined,
      removeStorageSync: () => undefined
    },
    loginCount: () => loginCount
  };
}

test("体验版没有微信合法域名时请求层 fail-closed，但本地健康记录仍可用", async () => {
  const calls: RequestOptions[] = [];
  const wxMock = createWxMock((options) => calls.push(options));
  const exports = loadModule("utils/request.js", { wx: wxMock.api }, {
    apiBaseUrl: "",
    networkEnabled: false,
    requestTimeoutMs: 1000,
    wechatLoginEnabled: false,
    anonymousAgentEnabled: false,
    anonymousRecordsEnabled: true
  });
  const createClient = exports.createClient as (api: typeof wxMock.api, options: Record<string, unknown>) => Record<string, any>;
  const client = createClient(wxMock.api, {
    apiBaseUrl: "",
    networkEnabled: false,
    requestTimeoutMs: 1000,
    wechatLoginEnabled: false,
    anonymousAgentEnabled: false,
    anonymousRecordsEnabled: true
  });

  assert.equal(client.networkAvailable, false);
  await assert.rejects(
    client.command("browse video list", {}, { auth: false }),
    (reason: unknown) => {
      assert.equal((reason as { code?: string }).code, "network_unavailable");
      assert.match((reason as { message?: string }).message || "", /正式微信联调后开放/u);
      return true;
    }
  );
  await assert.rejects(
    client.streamAgent({ message: "你好" }, {}),
    (reason: unknown) => (reason as { code?: string }).code === "network_unavailable"
  );
  const privacy = await client.command("account privacy", {}, { auth: false });
  assert.match(privacy.statement, /只保存在当前设备/u);
  assert.equal(calls.length, 0, "未配置合法域名时不得调用 wx.request");
});

test("小程序页面错误转换隐藏微信平台原始网络细节", () => {
  const pageUtils = loadModule("utils/page.js") as { errorMessage(error: Record<string, string>): string };
  const platformError = pageUtils.errorMessage({ code: "network_error", message: "request:fail url not in domain list" });
  assert.equal(platformError, "网络暂时不可用，请稍后重试。");
  assert.doesNotMatch(platformError, /request:fail|url not in domain list|errMsg/iu);
  assert.match(pageUtils.errorMessage({ code: "network_unavailable", message: "内部配置" }), /正式微信联调后开放/u);
});

test("健康档案窄屏记录行允许换行，操作按钮不使用原生宽度", () => {
  const styles = readFileSync(resolve(miniprogramRoot, "pages/health-profile/index.wxss"), "utf8");
  assert.match(styles, /\.record-row\s*\{[^}]*flex-wrap:\s*wrap/u);
  assert.match(styles, /\.row-actions\s*\{[^}]*min-width:\s*0/u);
  assert.match(styles, /\.row-actions button\s*\{[^}]*width:\s*96rpx/u);
});

test("小程序我的页隐私与关于入口打开可关闭的真实弹层，并可管理授权", async () => {
  const calls: string[] = [];
  const api = {
    wechatLoginEnabled: false,
    anonymousRecordsEnabled: true,
    command: async (name: string) => {
      calls.push(name);
      if (name === "account privacy") return { policyVersion: "privacy-v1", statement: "健康数据只保存在当前设备" };
      if (name === "account consent show") return { items: [{ consentType: "health_data", decision: "denied" }] };
      if (name === "record overview") return { consecutiveDays: 0, monthRecordCount: 0, lastTnss: null };
      if (name === "record profile show") return { revision: 0 };
      if (name === "browse message unread-count") return { count: 0 };
      if (name === "account consent update") return { consentType: "health_data", decision: "granted" };
      throw new Error(`unexpected command: ${name}`);
    }
  };
  const page = loadPage("pages/mine/index.js", {
    "../../utils/request": api,
    "../../utils/page": { selectTab: () => undefined, errorMessage: () => "加载失败" }
  }, { navigateTo: () => undefined, switchTab: () => undefined });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };
  page.onShow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  page.openPrivacy();
  assert.equal(page.data.privacyOpen, true);
  assert.equal(page.data.aboutOpen, false);
  page.toggleConsent();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.data.consentGranted, true);
  page.closeInfo();
  page.openAbout();
  assert.equal(page.data.aboutOpen, true);
  assert.equal(page.data.privacyOpen, false);
  page.closeInfo();
  assert.equal(page.data.aboutOpen, false);
  const template = readFileSync(resolve(miniprogramRoot, "pages/mine/index.wxml"), "utf8");
  assert.match(template, /bindtap="openPrivacy"/u);
  assert.match(template, /bindtap="openAbout"/u);
  assert.match(template, /class="info-overlay"/u);
  assert.ok(calls.includes("account consent show"));
  assert.ok(calls.includes("account consent update"));
});

test("小程序学一学在没有合法域名时展示受控未开放提示且不发网络请求", async () => {
  let commandCount = 0;
  const page = loadPage("pages/learn/index.js", {
    "../../utils/request": {
      networkAvailable: false,
      wechatLoginEnabled: false,
      command: async () => { commandCount += 1; throw new Error("不应请求内容服务"); },
      mediaUrl: (value: string) => value
    },
    "../../utils/page": {
      errorMessage: (error: { code: string }) => error.code === "network_unavailable" ? "内容服务尚未配置" : "加载失败"
    },
    "../../utils/content-body": { parseContentBody: () => [] },
    "../../utils/learning-catalog": loadModule("utils/learning-catalog.js")
  });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };
  page.onLoad({ kind: "video" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.data.loading, false);
  assert.equal(page.data.error, "内容服务尚未配置");
  assert.equal(page.data.contentAvailable, false);
  assert.equal(commandCount, 0);
});

test("小程序问助手在没有合法域名时保持不可用态，不显示可发送入口", () => {
  const page = loadPage("pages/assistant/index.js", {
    "../../utils/request": {
      networkAvailable: false,
      wechatLoginEnabled: false,
      anonymousAgentEnabled: true,
      command: async () => { throw new Error("不应调用私有接口"); },
      streamAgent: async () => { throw new Error("不应调用流式接口"); }
    },
    "../../utils/page": { selectTab: () => undefined, errorMessage: () => "不应展示内部错误" }
  }, { getStorageSync: () => "", setStorageSync: () => undefined, removeStorageSync: () => undefined });
  page.setData = (changes) => { page.data = { ...page.data, ...changes }; };
  page.onLoad();
  assert.equal(page.data.hydrated, true);
  assert.equal(page.data.capabilityUnavailable, true);
  assert.equal(page.data.startAvailable, false);
  assert.equal(page.data.canSend, false);
});
