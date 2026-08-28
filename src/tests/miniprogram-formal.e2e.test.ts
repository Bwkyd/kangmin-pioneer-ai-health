import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

import { DomainError } from "@kangmin/core/kernel/errors";
import type { WechatLoginPort } from "@kangmin/core/patient/account/wechat-login-port";
import { createAdminApplication } from "@kangmin/runtime/admin-composition-root";
import { createApplication } from "@kangmin/runtime/composition-root";
import { createKangminHttpServer } from "@kangmin/api/server";

// 集成测试使用明文测试密钥降级；正式/staging 组合根仍保持 fail-closed。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

const miniprogramRoot = "apps/kangmin-miniprogram/src";
const FORMAL_CONFIG = {
  apiBaseUrl: "https://api.example.test",
  networkEnabled: true,
  requestTimeoutMs: 2_000,
  anonymousAgentEnabled: false,
  anonymousRecordsEnabled: false,
  wechatLoginEnabled: true
};

interface HttpServerHandle {
  server: ReturnType<typeof createKangminHttpServer>;
  origin: string;
}

interface FormalRequestOptions {
  url: string;
  method: string;
  data: unknown;
  header: Record<string, string>;
  success(response: { statusCode: number; data: unknown }): void;
  fail(reason: { errMsg: string }): void;
}

interface FormalWxHandle {
  wx: {
    request(options: FormalRequestOptions): void;
    login(options: { success(value: { code: string }): void; fail(reason: unknown): void }): void;
    getStorageSync(key: string): unknown;
    setStorageSync(key: string, value: unknown): void;
    removeStorageSync(key: string): void;
    setNavigationBarTitle(options: { title: string }): void;
  };
  calls: FormalRequestOptions[];
  loginCount(): number;
}

interface FormalClient {
  command(name: string, input: Record<string, unknown>, options: { auth: boolean }): Promise<unknown>;
  mediaUrl(path: string | null | undefined): string;
  networkAvailable: boolean;
}

interface PageDefinition {
  data: Record<string, unknown>;
  setData?: (changes: Record<string, unknown>, callback?: () => void) => void;
  onLoad?: () => void;
  openItem?: (event: { currentTarget: { dataset: { id: string } } }) => void;
  [key: string]: unknown;
}

function dataOf<T>(value: unknown): T {
  return value as T;
}

async function listen(server: ReturnType<typeof createKangminHttpServer>): Promise<string> {
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createKangminHttpServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function startPatientServer(
  databasePath: string,
  wechatLogin: WechatLoginPort,
  mediaDirectory?: string
): Promise<HttpServerHandle & { application: ReturnType<typeof createApplication> }> {
  const application = mediaDirectory === undefined
    ? createApplication(databasePath, { appEnvironment: "integration" })
    : createApplication(databasePath, { appEnvironment: "integration", mediaDirectory });
  const server = createKangminHttpServer(application, {
    appEnvironment: "integration",
    wechatLogin
  });
  return { server, origin: await listen(server), application };
}

async function expectFailure(
  origin: string,
  token: string,
  name: string,
  input: Record<string, unknown>,
  status: number,
  errorCode: string
): Promise<void> {
  const response = await fetch(`${origin}/v1/patient/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      schemaVersion: "1",
      command: name,
      input,
      requestId: `e2e-failure-${name.replace(/\s+/gu, "-")}-${errorCode}`
    })
  });
  const body = await response.json() as {
    ok: boolean;
    error?: { code: string };
  };
  assert.equal(response.status, status, `${name}: ${JSON.stringify(body)}`);
  assert.equal(body.ok, false);
  assert.equal(body.error?.code, errorCode);
}

function localDateOffset(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function monthEnd(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const date = new Date(year, monthNumber, 0);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function createWechatStub(): WechatLoginPort & { calls: string[] } {
  const identities = new Map([
    ["mini-code-a", { appId: "wx-owned-test-app", openId: "open-a" }],
    ["mini-code-b", { appId: "wx-owned-test-app", openId: "open-b" }]
  ]);
  const calls: string[] = [];
  return {
    calls,
    async exchangeCode(code: string) {
      calls.push(code);
      const identity = identities.get(code);
      if (identity === undefined) {
        throw new DomainError("authentication_required", "微信登录码无效或已过期");
      }
      return identity;
    }
  };
}

function createFormalWx(origin: string, code: string): FormalWxHandle {
  const storage: Record<string, unknown> = {};
  const calls: FormalRequestOptions[] = [];
  let loginCalls = 0;
  const wx = {
    request(options: FormalRequestOptions) {
      calls.push(options);
      const target = new URL(options.url);
      void fetch(`${origin}${target.pathname}${target.search}`, {
        method: options.method,
        headers: options.header,
        body: JSON.stringify(options.data ?? {})
      }).then(async (response) => {
        const contentType = response.headers.get("content-type") ?? "";
        const data = contentType.includes("json")
          ? await response.json()
          : await response.arrayBuffer();
        options.success({ statusCode: response.status, data });
      }).catch((error: unknown) => {
        options.fail({ errMsg: error instanceof Error ? error.message : String(error) });
      });
    },
    login(options: { success(value: { code: string }): void; fail(reason: unknown): void }) {
      loginCalls += 1;
      options.success({ code });
    },
    getStorageSync(key: string) {
      return storage[key] ?? "";
    },
    setStorageSync(key: string, value: unknown) {
      storage[key] = value;
    },
    removeStorageSync(key: string) {
      delete storage[key];
    },
    setNavigationBarTitle(_options: { title: string }) {
      // 页面集成测试只需确认真实请求完成，不需要渲染原生导航栏。
    }
  };
  return { wx, calls, loginCount: () => loginCalls };
}

function loadRequestModule(wx: FormalWxHandle["wx"]): Record<string, unknown> {
  const source = read(resolve(miniprogramRoot, "utils/request.js"));
  const localModule = { exports: {} as Record<string, unknown> };
  const localSource = read(resolve(miniprogramRoot, "utils/local-experience.js"));
  new vm.Script(localSource, { filename: "utils/local-experience.js" }).runInNewContext({
    module: localModule,
    exports: localModule.exports,
    console,
    Date,
    Math,
    Number,
    Object,
    Array,
    String,
    RegExp
  });
  const module = { exports: {} as Record<string, unknown> };
  new vm.Script(source, { filename: "utils/request.js" }).runInNewContext({
    module,
    exports: module.exports,
    wx,
    Promise,
    Date,
    Math,
    Number,
    Object,
    Array,
    String,
    RegExp,
    ArrayBuffer,
    Uint8Array,
    setTimeout,
    clearTimeout,
    console,
    require(name: string) {
      if (name === "../config") return FORMAL_CONFIG;
      if (name === "./local-experience") return localModule.exports;
      throw new Error(`unexpected miniprogram module: ${name}`);
    }
  });
  return module.exports;
}

function formalClient(wx: FormalWxHandle["wx"]): FormalClient {
  const exports = loadRequestModule(wx);
  const createClient = exports.createClient as (
    api: FormalWxHandle["wx"],
    options: typeof FORMAL_CONFIG
  ) => FormalClient;
  return createClient(wx, FORMAL_CONFIG);
}

function read(relativePath: string): string {
  return readFileSync(relativePath, "utf8");
}

function loadMessagesPage(api: FormalClient, wx: FormalWxHandle["wx"]): PageDefinition {
  const source = read(resolve(miniprogramRoot, "pages/messages/index.js"));
  let definition: PageDefinition | null = null;
  vm.runInNewContext(source, {
    Page: (page: PageDefinition) => { definition = page; },
    require(name: string) {
      if (name === "../../utils/request") return api;
      if (name === "../../utils/page") return {
        errorMessage: (error: unknown) => error instanceof Error ? error.message : "加载失败"
      };
      throw new Error(`unexpected page module: ${name}`);
    },
    wx,
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
  }, { filename: "pages/messages/index.js" });
  assert.ok(definition !== null);
  return definition;
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.equal(check(), true, `${description} 未在限定时间内完成`);
}

test("#387 正式小程序请求层经微信会话写入服务端，重登后恢复症状日历趋势", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-miniprogram-record-e2e-"));
  const databasePath = join(directory, "records.sqlite");
  const wechat = createWechatStub();
  let runtime = await startPatientServer(databasePath, wechat);
  const recordDate = localDateOffset(-1);
  const month = recordDate.slice(0, 7);
  try {
    const wxA = createFormalWx(runtime.origin, "mini-code-a");
    const clientA = formalClient(wxA.wx);
    assert.equal(clientA.networkAvailable, true);

    const privacy = dataOf<{ policyVersion: string }>(
      await clientA.command("account privacy", {}, { auth: false })
    );
    await clientA.command("account consent update", {
      consentType: "health_data",
      decision: "granted",
      policyVersion: privacy.policyVersion,
      requestId: "mini-e2e-consent-a"
    }, { auth: true });

    const input = {
      localDate: recordDate,
      nasalCongestion: 2,
      nasalItching: 1,
      sneezing: 3,
      runnyNose: 0,
      notes: "正式链路测试",
      idempotencyKey: "mini-e2e-symptom-a"
    };
    const created = dataOf<{ id: string; revision: number; tnssTotal: number }>(
      await clientA.command("record symptom add", input, { auth: true })
    );
    assert.equal(created.revision, 1);
    assert.equal(created.tnssTotal, 6);
    const replayed = dataOf<{ id: string }>(
      await clientA.command("record symptom add", input, { auth: true })
    );
    assert.equal(replayed.id, created.id, "重复提交应由服务端幂等重放");

    const updated = dataOf<{ revision: number; tnssTotal: number }>(
      await clientA.command("record symptom update", {
        id: created.id,
        expectedRevision: 1,
        runnyNose: 2
      }, { auth: true })
    );
    assert.equal(updated.revision, 2);
    assert.equal(updated.tnssTotal, 8);
    await assert.rejects(
      clientA.command("record symptom update", {
        id: created.id,
        expectedRevision: 1,
        runnyNose: 1
      }, { auth: true }),
      (error: unknown) => (error as { code?: string }).code === "version_conflict"
    );
    await assert.rejects(
      clientA.command("record symptom add", {
        ...input,
        localDate: localDateOffset(1),
        idempotencyKey: "mini-e2e-future"
      }, { auth: true }),
      (error: unknown) => (error as { code?: string }).code === "validation_failed"
    );

    const calendar = dataOf<{ days: Array<{ localDate: string; tnssTotal: number }> }>(
      await clientA.command("record calendar", { month }, { auth: true })
    );
    const trend = dataOf<{ items: Array<{ localDate: string; tnssTotal: number }> }>(
      await clientA.command("record trend", {
        from: `${month}-01`,
        to: monthEnd(month)
      }, { auth: true })
    );
    assert.deepEqual(calendar.days, [{
      localDate: recordDate,
      symptomId: created.id,
      tnssTotal: 8,
      hasExposure: false,
      hasMedication: false
    }]);
    assert.deepEqual(trend.items, [{ localDate: recordDate, symptomId: created.id, tnssTotal: 8 }]);

    // 关闭并重新打开 HTTP 适配器，再以空本地存储重新登录，验证数据库才是正式档案真值。
    await close(runtime.server);
    runtime.application.close();
    runtime = await startPatientServer(databasePath, wechat);
    const wxAAfterReentry = createFormalWx(runtime.origin, "mini-code-a");
    const restored = dataOf<{ items: Array<{ id: string; tnssTotal: number }> }>(
      await formalClient(wxAAfterReentry.wx).command("record symptom list", {}, { auth: true })
    );
    assert.deepEqual(restored.items.map((item) => ({ id: item.id, tnssTotal: item.tnssTotal })), [
      { id: created.id, tnssTotal: 8 }
    ]);
    assert.equal(wxAAfterReentry.loginCount(), 1);
    assert.deepEqual(wechat.calls, ["mini-code-a", "mini-code-a"]);

    const wxB = createFormalWx(runtime.origin, "mini-code-b");
    const clientB = formalClient(wxB.wx);
    const otherPatient = dataOf<{ items: unknown[] }>(
      await clientB.command("record symptom list", {}, { auth: true })
    );
    assert.deepEqual(otherPatient.items, [], "不同微信 OpenID 不得串读健康记录");
    await expectFailure(
      runtime.origin,
      dataOf<{ token: string }>(await fetchWechatToken(runtime.origin, "mini-code-b")).token,
      "record symptom add",
      { ...input, idempotencyKey: "mini-e2e-b-without-consent" },
      403,
      "consent_required"
    );
  } finally {
    await close(runtime.server);
    runtime.application.close();
  }
});

async function fetchWechatToken(origin: string, code: string): Promise<{ token: string }> {
  const response = await fetch(`${origin}/v1/auth/wechat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code })
  });
  const body = await response.json() as { ok: boolean; data: { token: string } };
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  return body.data;
}

test("#388 后台发布到正式小程序浏览、媒体和应用内消息已读闭环", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-miniprogram-content-e2e-"));
  const databasePath = join(directory, "content.sqlite");
  const mediaDirectory = join(directory, "media");
  const wechat = createWechatStub();
  const admin = createAdminApplication(databasePath, { mediaDirectory });
  const adminToken = (await admin.sessions.createDevelopmentSession("content-e2e-owner")).token;
  const adminCommand = async <T>(name: string, input: Record<string, unknown>): Promise<T> => {
    const result = await admin.execute({ command: name, adminToken, input });
    if (!result.ok) assert.fail(`${name}: ${result.error.code}: ${result.error.message}`);
    return result.data as T;
  };

  const videoFile = join(directory, "approved.mp4");
  const videoBytes = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32
  ]);
  writeFileSync(videoFile, videoBytes);
  try {
    const media = await adminCommand<{ id: string }>("content media upload", { file: videoFile });
    const article = await adminCommand<{ id: string }>("content article create", {
      title: "已审核测试文章",
      categoryIds: ["article-general"],
      idempotencyKey: "content-e2e-article"
    });
    await adminCommand("content article update", {
      id: article.id,
      expectedRevision: 1,
      summary: "测试摘要",
      body: "测试正文",
      source: "测试审核来源"
    });
    await adminCommand("content article publish", { id: article.id, expectedRevision: 2, yes: true });

    const video = await adminCommand<{ id: string }>("content video create", {
      title: "已审核测试视频",
      categoryIds: ["video-adult-quick-content"],
      idempotencyKey: "content-e2e-video"
    });
    await adminCommand("content video update", {
      id: video.id,
      expectedRevision: 1,
      summary: "测试视频摘要",
      body: "测试视频说明",
      source: "测试审核来源",
      instructions: "按视频步骤操作",
      precautions: "出现不适立即停止",
      mediaId: media.id
    });
    await adminCommand("content video publish", { id: video.id, expectedRevision: 2, yes: true });

    const message = await adminCommand<{ id: string }>("content message create", {
      title: "已审核测试通知",
      summary: "测试通知摘要",
      body: "测试通知正文"
    });
    await adminCommand("content message publish", { id: message.id, expectedRevision: 1, yes: true });

    let runtime = await startPatientServer(databasePath, wechat, mediaDirectory);
    try {
      const wx = createFormalWx(runtime.origin, "mini-code-a");
      const client = formalClient(wx.wx);
      assert.equal(client.networkAvailable, true);

      const articles = dataOf<{ items: Array<{ id: string; summary: string }> }>(
        await client.command("browse article list", { limit: 100, offset: 0 }, { auth: false })
      );
      const videos = dataOf<{ items: Array<{ id: string; mediaUrl: string }> }>(
        await client.command("browse video list", { limit: 100, offset: 0 }, { auth: false })
      );
      assert.ok(articles.items.some((item) => item.id === article.id));
      assert.ok(videos.items.some((item) => item.id === video.id));

      const articleDetail = dataOf<{ body: string }>(
        await client.command("browse article show", { id: article.id }, { auth: false })
      );
      const videoDetail = dataOf<{
        mediaUrl: string;
        instructions: string;
        precautions: string;
      }>(await client.command("browse video show", { id: video.id }, { auth: false }));
      assert.equal(articleDetail.body, "测试正文");
      assert.equal(videoDetail.instructions, "按视频步骤操作");
      assert.equal(videoDetail.precautions, "出现不适立即停止");
      assert.match(videoDetail.mediaUrl, /^\/v1\/media\/med_[0-9a-f]{12}$/u);
      const mediaResponse = await fetch(`${runtime.origin}${videoDetail.mediaUrl}`);
      assert.equal(mediaResponse.status, 200);
      assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()), videoBytes);

      const messages = dataOf<{ items: Array<{ id: string; readAt: string | null }> }>(
        await client.command("browse message list", {}, { auth: true })
      );
      const beforeRead = dataOf<{ count: number }>(
        await client.command("browse message unread-count", {}, { auth: true })
      );
      assert.deepEqual(messages.items.map((item) => item.id), [message.id]);
      assert.equal(messages.items[0]?.readAt, null);
      assert.equal(beforeRead.count, 1);

      // 用真实小程序消息页接真实 request.js 和 HTTP 服务，确认页面显示并刷新未读数。
      const page = loadMessagesPage(client, wx.wx);
      page.setData = (changes) => { page.data = { ...page.data, ...changes }; };
      page.onLoad?.();
      await waitFor(() => page.data.loading === false && page.data.unreadCountKnown === true, "消息列表和未读数");
      assert.equal(page.data.unreadCount, 1);
      page.openItem?.({ currentTarget: { dataset: { id: message.id } } });
      await waitFor(() => page.data.detailLoading === false && page.data.unreadCount === 0, "消息已读回执和未读数刷新");
      assert.notEqual((page.data.selected as { readAt: string | null }).readAt, null);

      const afterRead = dataOf<{ count: number }>(
        await client.command("browse message unread-count", {}, { auth: true })
      );
      assert.equal(afterRead.count, 0);

      const wxB = createFormalWx(runtime.origin, "mini-code-b");
      const messagesForOtherPatient = dataOf<{ items: Array<{ id: string; readAt: string | null }> }>(
        await formalClient(wxB.wx).command("browse message list", {}, { auth: true })
      );
      assert.equal(messagesForOtherPatient.items[0]?.id, message.id);
      assert.equal(messagesForOtherPatient.items[0]?.readAt, null);

      await adminCommand("content article unpublish", { id: article.id, expectedRevision: 3, yes: true });
      await adminCommand("content video unpublish", { id: video.id, expectedRevision: 3, yes: true });
      await adminCommand("content message unpublish", { id: message.id, expectedRevision: 2, yes: true });

      const articlesAfterUnpublish = dataOf<{ items: Array<{ id: string }> }>(
        await client.command("browse article list", { limit: 100, offset: 0 }, { auth: false })
      );
      const videosAfterUnpublish = dataOf<{ items: Array<{ id: string }> }>(
        await client.command("browse video list", { limit: 100, offset: 0 }, { auth: false })
      );
      const messagesAfterUnpublish = dataOf<{ items: Array<{ id: string }> }>(
        await client.command("browse message list", {}, { auth: true })
      );
      assert.equal(articlesAfterUnpublish.items.some((item) => item.id === article.id), false);
      assert.equal(videosAfterUnpublish.items.some((item) => item.id === video.id), false);
      assert.deepEqual(messagesAfterUnpublish.items, []);
      await expectFailure(
        runtime.origin,
        await getTokenFromClient(wx),
        "browse article show",
        { id: article.id },
        404,
        "resource_not_found"
      );
    } finally {
      await close(runtime.server);
      runtime.application.close();
    }
  } finally {
    admin.close();
  }
});

async function getTokenFromClient(wx: FormalWxHandle): Promise<string> {
  const token = wx.wx.getStorageSync("kangmin.session.token");
  assert.equal(typeof token, "string");
  return token as string;
}
