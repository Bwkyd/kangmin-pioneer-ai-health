import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../app/composition-root.js";
import { createKangminHttpServer } from "../http/server.js";
import { seedContent } from "./content-fixture.js";

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

test("HTTP 适配器使用同一应用服务并执行真实身份和持久化", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-http-"));
  const application = createApplication(join(directory, "records.sqlite"));
  const token =
    (await application.sessions.createDevelopmentSession("patient-http")).token;
  const server = createKangminHttpServer(application);
  const origin = await listen(server);

  try {
    const response = await fetch(
      `${origin}/v1/commands`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          command: "record symptom add",
          requestId: "http-e2e",
          input: {
            localDate: "2026-07-30",
            nasalCongestion: 1,
            nasalItching: 1,
            sneezing: 2,
            runnyNose: 0,
            idempotencyKey: "http-20260730"
          }
        })
      }
    );
    assert.equal(response.status, 200);
    const body = await response.json() as {
      ok: boolean;
      data: { tnssTotal: number; revision: number };
      meta: { requestId: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.data.tnssTotal, 4);
    assert.equal(body.data.revision, 1);
    assert.equal(body.meta.requestId, "http-e2e");

    const unauthenticated = await fetch(
      `${origin}/v1/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "record symptom list" })
      }
    );
    assert.equal(unauthenticated.status, 401);
  } finally {
    await close(server);
    application.close();
  }
});

test("Browse 通过无身份 HTTP 命令契约只返回已发布内容", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-browse-http-"));
  const databasePath = join(directory, "content.sqlite");
  seedContent(databasePath);
  const application = createApplication(databasePath);
  const server = createKangminHttpServer(application);
  const origin = await listen(server);

  try {
    const response = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "browse video list" })
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      data: { items: Array<{ id: string; mediaUrl: string }> };
    };
    assert.deepEqual(body.data.items.map((item) => item.id), ["video-public"]);
    assert.equal(body.data.items[0]?.mediaUrl, "/media/video-public.mp4");

    const hiddenResponse = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "browse video show",
        input: { id: "video-broken-media" }
      })
    });
    assert.equal(hiddenResponse.status, 404);
  } finally {
    await close(server);
    application.close();
  }
});

test("患者薄壳通过受保护的 HttpOnly 开发会话调用同一命令端点", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-web-http-"));
  const application = createApplication(join(directory, "records.sqlite"));
  const server = createKangminHttpServer(application, {
    appEnvironment: "integration",
    allowDevelopmentSession: true
  });
  const origin = await listen(server);

  try {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(
      await page.text(),
      /data-testid="symptom-form"/u
    );
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /default-src 'self'/u
    );

    const session = await fetch(`${origin}/dev/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "patient-browser" })
    });
    assert.equal(session.status, 201);
    const setCookie = session.headers.get("set-cookie");
    assert.notEqual(setCookie, null);
    assert.match(setCookie ?? "", /HttpOnly/u);
    assert.match(setCookie ?? "", /SameSite=Strict/u);
    const sessionCookie = setCookie?.split(";")[0] ?? "";

    const created = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        command: "record symptom add",
        input: {
          localDate: "2026-07-31",
          nasalCongestion: 2,
          nasalItching: 1,
          sneezing: 2,
          runnyNose: 1,
          idempotencyKey: "web-http-20260731"
        }
      })
    });
    assert.equal(created.status, 200);

    const listed = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({ command: "record symptom list" })
    });
    const body = await listed.json() as {
      ok: boolean;
      data: { items: Array<{ tnssTotal: number }> };
    };
    assert.equal(body.ok, true);
    assert.equal(body.data.items[0]?.tnssTotal, 6);
  } finally {
    await close(server);
    application.close();
  }
});

test("生产模式不能启用开发会话", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-prod-http-"));
  const application = createApplication(join(directory, "records.sqlite"));
  const server = createKangminHttpServer(application, {
    appEnvironment: "production",
    allowDevelopmentSession: true
  });
  const origin = await listen(server);

  try {
    const response = await fetch(`${origin}/dev/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "patient-browser" })
    });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("set-cookie"), null);
  } finally {
    await close(server);
    application.close();
  }
});

test("HTTP 非法 JSON、超大请求和无效 input 返回稳定错误契约", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-contract-http-"));
  const application = createApplication(join(directory, "records.sqlite"));
  const server = createKangminHttpServer(application);
  const origin = await listen(server);

  try {
    const invalidJson = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    assert.equal(invalidJson.status, 400);
    const invalidBody = await invalidJson.json() as {
      error: { code: string };
    };
    assert.equal(invalidBody.error.code, "invalid_json");

    const tooLarge = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(65 * 1024) })
    });
    assert.equal(tooLarge.status, 413);
    const tooLargeBody = await tooLarge.json() as {
      error: { code: string };
    };
    assert.equal(tooLargeBody.error.code, "payload_too_large");

    const invalidInput = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "record symptom list",
        input: []
      })
    });
    assert.equal(invalidInput.status, 400);
    const invalidInputBody = await invalidInput.json() as {
      error: { code: string };
    };
    assert.equal(invalidInputBody.error.code, "command_invalid");
  } finally {
    await close(server);
    application.close();
  }
});
