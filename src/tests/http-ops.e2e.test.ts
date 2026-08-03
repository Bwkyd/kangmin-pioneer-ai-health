import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { KangminApplication } from "../app/application.js";
import {
  createAdminApplication,
  createAdminApplicationWithOps
} from "../app/admin-composition-root.js";
import {
  createApplication,
  createApplicationWithOps,
  createStructuredRequestLogger,
  type ReadinessProbe
} from "../app/composition-root.js";
import { createKangminHttpServer } from "../http/server.js";
import { DomainError } from "../kernel/errors.js";
import { COMMAND_SCHEMA_VERSION } from "../kernel/protocol.js";
import { success } from "../kernel/result.js";
import type {
  EnvironmentProviderPort,
  EnvironmentSnapshot,
  ForecastDay
} from "../modules/environment/environment-ports.js";

// 与 http.e2e.test.ts 一致：本地开发模式允许明文加密降级；
// 生产 fail-closed 用例在 withProductionEnv 内显式覆盖并恢复原值。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

const TEST_ENCRYPTION_KEYS = `v1:${Buffer.alloc(32, 7).toString("base64")}`;

const PRODUCTION_ENV_KEYS = [
  "KANGMIN_APP_ENV",
  "KANGMIN_ENCRYPTION_KEYS",
  "KANGMIN_DATABASE_URL",
  "KANGMIN_S3_BUCKET",
  "KANGMIN_S3_ACCESS_KEY_ID",
  "KANGMIN_S3_SECRET_ACCESS_KEY",
  "KANGMIN_ALLOW_DEV_SESSION",
  "KANGMIN_ENV_PROVIDER_MODE"
] as const;

/**
 * 在"生产配置齐全"的基线环境上按需打掉单项，结束后恢复原环境。
 * 基线：staging + 加密密钥 + PG 连接串 + S3 桶与凭证，
 * 无开发会话开关、无测试替身故障模式开关。
 */
function withProductionEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => T
): T {
  const saved = new Map<string, string | undefined>();
  for (const key of PRODUCTION_ENV_KEYS) {
    saved.set(key, process.env[key]);
  }
  const effective: Record<string, string | undefined> = {
    KANGMIN_APP_ENV: "staging",
    KANGMIN_ENCRYPTION_KEYS: TEST_ENCRYPTION_KEYS,
    KANGMIN_DATABASE_URL: "postgres://127.0.0.1:1/kangmin_ops",
    KANGMIN_S3_BUCKET: "kangmin-ops",
    KANGMIN_S3_ACCESS_KEY_ID: "ops-test",
    KANGMIN_S3_SECRET_ACCESS_KEY: "ops-test",
    KANGMIN_ALLOW_DEV_SESSION: undefined,
    KANGMIN_ENV_PROVIDER_MODE: undefined,
    ...overrides
  };
  try {
    for (const [key, value] of Object.entries(effective)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return run();
  } finally {
    for (const key of PRODUCTION_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** 非测试替身的环境 Provider：生产 fail-closed 成功路径用。 */
class FakeRealEnvironmentProvider implements EnvironmentProviderPort {
  readonly providerId = "fake-real";

  current(): Promise<EnvironmentSnapshot> {
    return Promise.reject(new Error("测试探针不调用供应商"));
  }

  forecast(): Promise<ForecastDay[]> {
    return Promise.reject(new Error("测试探针不调用供应商"));
  }
}

async function listen(server: ReturnType<typeof createKangminHttpServer>) {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  if (address === null || typeof address === "string") {
    assert.fail("HTTP server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createKangminHttpServer>) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function assertConfigMissing(run: () => unknown): void {
  assert.throws(run, (error: unknown) =>
    error instanceof DomainError && error.code === "config_missing"
  );
}

/** 收集结构化日志行的内存流（断言 JSON 行内容与脱敏）。 */
function createLogCapture() {
  const lines: string[] = [];
  const stream = {
    write(chunk: unknown): boolean {
      lines.push(String(chunk));
      return true;
    }
  } as NodeJS.WritableStream;
  return {
    lines,
    logger: createStructuredRequestLogger(stream),
    entries(): Array<Record<string, unknown>> {
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    }
  };
}

test("生产组合根 fail-closed：缺 PG / 缺对象存储 / 测试替身 Provider / 开发会话开关一律 config_missing", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-ops-prod-"));
  const databasePath = join(directory, "records.sqlite");

  // staging 与 production 同样 fail-closed。
  for (const appEnvironment of ["staging", "production"]) {
    withProductionEnv({ KANGMIN_APP_ENV: appEnvironment, KANGMIN_DATABASE_URL: undefined }, () => {
      assertConfigMissing(() => createApplication(databasePath));
    });
    withProductionEnv({ KANGMIN_APP_ENV: appEnvironment, KANGMIN_S3_BUCKET: undefined }, () => {
      assertConfigMissing(() => createApplication(databasePath));
    });
    withProductionEnv(
      { KANGMIN_APP_ENV: appEnvironment, KANGMIN_ENV_PROVIDER_MODE: "fixed" },
      () => {
        assertConfigMissing(() => createApplication(databasePath));
      }
    );
    // 存储齐全但环境 Provider 仍是测试替身（未接真实供应商的现状）。
    withProductionEnv({ KANGMIN_APP_ENV: appEnvironment }, () => {
      assertConfigMissing(() => createApplication(databasePath));
    });
    // 连开发会话开关都不允许出现（路由层拒绝之外的第二道）。
    withProductionEnv(
      { KANGMIN_APP_ENV: appEnvironment, KANGMIN_ALLOW_DEV_SESSION: "1" },
      () => {
        assertConfigMissing(() => createApplication(databasePath));
      }
    );
  }

  // 全部就绪项满足（含注入非测试替身 Provider）→ 正常装配。
  withProductionEnv({}, () => {
    const application = createApplication(databasePath, {
      environmentProvider: new FakeRealEnvironmentProvider()
    });
    application.close();
  });
});

test("管理端组合根 fail-closed：缺 PG / 缺对象存储 / 开发会话开关一律 config_missing", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-ops-admin-"));
  const databasePath = join(directory, "records.sqlite");
  const mediaDirectory = join(directory, "admin-media");

  withProductionEnv({ KANGMIN_DATABASE_URL: undefined }, () => {
    assertConfigMissing(() =>
      createAdminApplication(databasePath, { mediaDirectory })
    );
  });
  withProductionEnv({ KANGMIN_S3_BUCKET: undefined }, () => {
    assertConfigMissing(() =>
      createAdminApplication(databasePath, { mediaDirectory })
    );
  });
  withProductionEnv({ KANGMIN_ALLOW_DEV_SESSION: "1" }, () => {
    assertConfigMissing(() =>
      createAdminApplication(databasePath, { mediaDirectory })
    );
  });

  // 配置齐全 → 正常装配（S3 客户端构造不发网络请求）。
  withProductionEnv({}, () => {
    const application = createAdminApplication(databasePath, { mediaDirectory });
    application.close();
  });
});

test("local/integration 不受生产 fail-closed 影响", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-ops-local-"));
  withProductionEnv(
    {
      KANGMIN_APP_ENV: "local",
      KANGMIN_ENCRYPTION_KEYS: undefined,
      KANGMIN_DATABASE_URL: undefined,
      KANGMIN_S3_BUCKET: undefined
    },
    () => {
      const application = createApplication(join(directory, "records.sqlite"));
      application.close();
      const admin = createAdminApplication(join(directory, "admin.sqlite"), {
        mediaDirectory: join(directory, "admin-media")
      });
      admin.close();
    }
  );
});

test("组合根探针装配：SQLite 本地环境数据库 ok，其余如实 not_configured", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-ops-probes-"));
  const ops = createApplicationWithOps(join(directory, "records.sqlite"), {
    appEnvironment: "integration"
  });
  try {
    assert.deepEqual(await ops.readinessProbes.database.run(), {
      status: "ok",
      message: "数据库可用"
    });
    assert.equal((await ops.readinessProbes.encryption.run()).status, "not_configured");
    assert.equal(
      (await ops.readinessProbes.environmentProvider.run()).status,
      "not_configured"
    );
    const rulePackage = await ops.readinessProbes.rulePackage.run();
    assert.equal(rulePackage.status, "not_configured");
    assert.match(rulePackage.message, /candidate/u);
  } finally {
    ops.application.close();
  }
});

test("管理端对象存储探针：本地素材目录可读写即 ok", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-ops-storage-"));
  const mediaDirectory = join(directory, "admin-media");
  const ops = createAdminApplicationWithOps(join(directory, "admin.sqlite"), {
    mediaDirectory
  });
  try {
    // 目录尚未创建（本地后端延迟创建）：探针如实报 failed，与 doctor 语义一致。
    assert.equal((await ops.readinessProbes.objectStorage.run()).status, "failed");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(mediaDirectory);
    assert.deepEqual(await ops.readinessProbes.objectStorage.run(), {
      status: "ok",
      message: "素材目录可读写"
    });
  } finally {
    ops.application.close();
  }
});

test("/live 无依赖返回 200 ok 并回写 x-request-id", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-ops-live-"));
  const application = createApplication(join(directory, "records.sqlite"), {
    appEnvironment: "integration"
  });
  const server = createKangminHttpServer(application, {
    appEnvironment: "integration"
  });
  const origin = await listen(server);

  try {
    const response = await fetch(`${origin}/live`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    assert.match(
      response.headers.get("x-request-id") ?? "",
      /^[0-9a-f-]{36}$/u
    );
  } finally {
    await close(server);
    application.close();
  }
});

test("/ready 全 ok 才 200 ready:true；failed 或 not_configured 一律 503", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-ops-ready-"));
  const application = createApplication(join(directory, "records.sqlite"), {
    appEnvironment: "integration"
  });

  const okProbe: ReadinessProbe = {
    name: "database",
    run: () => Promise.resolve({ status: "ok", message: "数据库可用" })
  };
  const failedProbe: ReadinessProbe = {
    name: "object-storage",
    run: () => Promise.resolve({ status: "failed", message: "对象存储不可用" })
  };
  const notConfiguredProbe: ReadinessProbe = {
    name: "rule-package",
    run: () =>
      Promise.resolve({ status: "not_configured", message: "规则包未冻结" })
  };
  const throwingProbe: ReadinessProbe = {
    name: "environment-provider",
    run: () => Promise.reject(new Error("probe boom"))
  };

  const allOk = createKangminHttpServer(application, {
    appEnvironment: "integration",
    readinessProbes: [okProbe]
  });
  const withFailed = createKangminHttpServer(application, {
    appEnvironment: "integration",
    readinessProbes: [okProbe, failedProbe]
  });
  const withNotConfigured = createKangminHttpServer(application, {
    appEnvironment: "integration",
    readinessProbes: [okProbe, notConfiguredProbe]
  });
  const withThrowing = createKangminHttpServer(application, {
    appEnvironment: "integration",
    readinessProbes: [throwingProbe]
  });

  try {
    const okOrigin = await listen(allOk);
    const okResponse = await fetch(`${okOrigin}/ready`);
    assert.equal(okResponse.status, 200);
    const okBody = await okResponse.json() as {
      ready: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    assert.equal(okBody.ready, true);
    assert.deepEqual(okBody.checks, [
      { name: "database", status: "ok", message: "数据库可用" }
    ]);

    const failedOrigin = await listen(withFailed);
    const failedResponse = await fetch(`${failedOrigin}/ready`);
    assert.equal(failedResponse.status, 503);
    const failedBody = await failedResponse.json() as {
      ready: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    assert.equal(failedBody.ready, false);
    assert.deepEqual(
      failedBody.checks.map((check) => [check.name, check.status]),
      [["database", "ok"], ["object-storage", "failed"]]
    );

    const ncOrigin = await listen(withNotConfigured);
    const ncResponse = await fetch(`${ncOrigin}/ready`);
    assert.equal(ncResponse.status, 503);
    const ncBody = await ncResponse.json() as { ready: boolean };
    assert.equal(ncBody.ready, false);

    // 探针自身抛错视同 failed，不就绪必须显式可见。
    const throwOrigin = await listen(withThrowing);
    const throwResponse = await fetch(`${throwOrigin}/ready`);
    assert.equal(throwResponse.status, 503);
    const throwBody = await throwResponse.json() as {
      ready: boolean;
      checks: Array<{ name: string; status: string; message: string }>;
    };
    assert.equal(throwBody.ready, false);
    assert.equal(throwBody.checks[0]?.status, "failed");
    assert.equal(throwBody.checks[0]?.name, "environment-provider");
  } finally {
    await close(allOk);
    await close(withFailed);
    await close(withNotConfigured);
    await close(withThrowing);
    application.close();
  }
});

test("限流：/dev/session strict 档超限返回 429 信封与 retryAfter", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-ops-rl-"));
  const application = createApplication(join(directory, "records.sqlite"), {
    appEnvironment: "integration"
  });
  const server = createKangminHttpServer(application, {
    appEnvironment: "integration",
    allowDevelopmentSession: true,
    rateLimits: { strictPerWindow: 2, windowMs: 60_000 }
  });
  const origin = await listen(server);
  const createSession = () =>
    fetch(`${origin}/dev/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "rate-limited" })
    });

  try {
    assert.equal((await createSession()).status, 201);
    assert.equal((await createSession()).status, 201);
    const limited = await createSession();
    assert.equal(limited.status, 429);
    assert.notEqual(limited.headers.get("retry-after"), null);
    assert.notEqual(limited.headers.get("x-request-id"), null);
    const body = await limited.json() as {
      ok: boolean;
      status: string;
      error: { code: string; retryable: boolean };
      retryAfter: number;
      receipt: { requestId: string };
      meta: { requestId: string };
    };
    assert.equal(body.ok, false);
    assert.equal(body.status, "failed");
    assert.equal(body.error.code, "rate_limited");
    assert.equal(body.error.retryable, true);
    assert.ok(body.retryAfter >= 1);
    assert.equal(body.receipt.requestId, body.meta.requestId);
  } finally {
    await close(server);
    application.close();
  }
});

test("限流：固定窗口过期后恢复放行", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-ops-rlwin-"));
  const application = createApplication(join(directory, "records.sqlite"), {
    appEnvironment: "integration"
  });
  const server = createKangminHttpServer(application, {
    appEnvironment: "integration",
    allowDevelopmentSession: true,
    rateLimits: { strictPerWindow: 1, windowMs: 200 }
  });
  const origin = await listen(server);
  const createSession = () =>
    fetch(`${origin}/dev/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "window-recovery" })
    });

  try {
    assert.equal((await createSession()).status, 201);
    assert.equal((await createSession()).status, 429);
    await sleep(300);
    assert.equal((await createSession()).status, 201);
  } finally {
    await close(server);
    application.close();
  }
});

test("限流：/v1/*commands 普通档与登录/上传归类", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-ops-rlcmd-"));
  const application = createApplication(join(directory, "records.sqlite"), {
    appEnvironment: "integration"
  });
  const server = createKangminHttpServer(application, {
    appEnvironment: "integration",
    rateLimits: {
      strictPerWindow: 1,
      commandsPerWindow: 2,
      uploadPerWindow: 1,
      windowMs: 60_000
    }
  });
  const origin = await listen(server);
  const command = (body: unknown, path = "/v1/commands") =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

  try {
    // 普通命令档：未登录 401 也计数，第 3 次 429。
    assert.equal((await command({ command: "record symptom list" })).status, 401);
    assert.equal((await command({ command: "record symptom list" })).status, 401);
    const limited = await command({ command: "record symptom list" });
    assert.equal(limited.status, 429);
    const limitedBody = await limited.json() as { error: { code: string } };
    assert.equal(limitedBody.error.code, "rate_limited");

    // 登录类命令归 strict 档（窗口 1）：第 2 次即 429。
    const loginFirst = await command({ command: "account login", input: {} });
    assert.notEqual(loginFirst.status, 429);
    const loginSecond = await command({ command: "account login", input: {} });
    assert.equal(loginSecond.status, 429);

    // 上传类命令归 upload 档（窗口 1）：第 2 次即 429。
    const uploadFirst = await command(
      {
        command: "content media upload-init",
        schemaVersion: COMMAND_SCHEMA_VERSION,
        requestId: "ops-upload-1",
        input: {}
      },
      "/v1/admin/commands"
    );
    // 未配置管理端应用 → capability_unavailable，但不触发限流。
    assert.equal(uploadFirst.status, 503);
    const uploadSecond = await command(
      {
        command: "content media upload-init",
        schemaVersion: COMMAND_SCHEMA_VERSION,
        requestId: "ops-upload-2",
        input: {}
      },
      "/v1/admin/commands"
    );
    assert.equal(uploadSecond.status, 429);
  } finally {
    await close(server);
    application.close();
  }
});

test("请求体超过 bodyLimitBytes 返回 413 payload_too_large", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-ops-413-"));
  const application = createApplication(join(directory, "records.sqlite"), {
    appEnvironment: "integration"
  });
  const server = createKangminHttpServer(application, {
    appEnvironment: "integration",
    bodyLimitBytes: 128
  });
  const origin = await listen(server);

  try {
    const response = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "record symptom list", pad: "x".repeat(256) })
    });
    assert.equal(response.status, 413);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, "payload_too_large");
  } finally {
    await close(server);
    application.close();
  }
});

test("请求整体超时返回 408 request_timeout", async () => {
  const slowApplication = {
    execute: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(success("slow command", { ok: true })), 200);
      })
  } as unknown as KangminApplication;
  const server = createKangminHttpServer(slowApplication, {
    appEnvironment: "integration",
    requestTimeoutMs: 50
  });
  const origin = await listen(server);

  try {
    const response = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "slow command" })
    });
    assert.equal(response.status, 408);
    const body = await response.json() as {
      error: { code: string; retryable: boolean };
    };
    assert.equal(body.error.code, "request_timeout");
    assert.equal(body.error.retryable, true);
    // 等慢处理器收尾：迟到写入被 writableEnded 守卫丢弃，不影响进程。
    await sleep(300);
  } finally {
    await close(server);
  }
});

test("结构化请求日志：字段固定、脱敏、按状态分级，requestId 回写响应头", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-ops-log-"));
  const application = createApplication(join(directory, "records.sqlite"), {
    appEnvironment: "integration"
  });
  const capture = createLogCapture();
  const server = createKangminHttpServer(application, {
    appEnvironment: "integration",
    allowDevelopmentSession: true,
    requestLogger: capture.logger,
    rateLimits: { strictPerWindow: 2, windowMs: 60_000 },
    readinessProbes: [
      {
        name: "database",
        run: () => Promise.resolve({ status: "failed", message: "数据库不可用" })
      }
    ]
  });
  const origin = await listen(server);

  try {
    // 携带令牌与手机号样式内容的请求：日志绝不含这些敏感字段。
    const sensitive = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: {
        authorization: "Bearer ops-secret-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        command: "account login",
        requestId: "ops-req-1",
        input: { phoneNumber: "13800138000" }
      })
    });
    assert.equal(sensitive.headers.get("x-request-id"), "ops-req-1");

    // 429 → warn（限流审计行，不落审计表）。
    await fetch(`${origin}/dev/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "log-subject" })
    });
    const limited = await fetch(`${origin}/dev/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "log-subject" })
    });
    assert.equal(limited.status, 429);

    // 5xx → error。
    const notReady = await fetch(`${origin}/ready`);
    assert.equal(notReady.status, 503);

    // 等 finish 事件的日志全部落流。
    await sleep(50);

    assert.ok(capture.lines.length >= 4);
    const raw = capture.lines.join("");
    assert.ok(!raw.includes("ops-secret-token"), "日志不得包含令牌");
    assert.ok(!raw.includes("13800138000"), "日志不得包含手机号");
    assert.ok(!raw.includes("log-subject"), "日志不得包含请求体内容");

    for (const entry of capture.entries()) {
      assert.deepEqual(Object.keys(entry).sort(), [
        "durationMs",
        "level",
        "method",
        "path",
        "requestId",
        "status",
        "ts"
      ]);
    }

    const byPath = (path: string, status: number) =>
      capture.entries().find(
        (entry) => entry.path === path && entry.status === status
      );

    const sensitiveLog = byPath("/v1/commands", sensitive.status);
    assert.notEqual(sensitiveLog, undefined);
    assert.equal(sensitiveLog?.requestId, "ops-req-1");
    assert.equal(sensitiveLog?.level, "info");
    assert.equal(sensitiveLog?.method, "POST");

    const limitedLog = byPath("/dev/session", 429);
    assert.equal(limitedLog?.level, "warn");

    const readyLog = byPath("/ready", 503);
    assert.equal(readyLog?.level, "error");
    assert.equal(readyLog?.method, "GET");

    // 无请求体 requestId 的请求回写生成的 uuid。
    const generated = capture.entries().find(
      (entry) => entry.path === "/dev/session" && entry.status === 201
    );
    assert.match(String(generated?.requestId), /^[0-9a-f-]{36}$/u);
  } finally {
    await close(server);
    application.close();
  }
});
