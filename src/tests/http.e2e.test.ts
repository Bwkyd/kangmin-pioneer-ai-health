import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdminApplication } from "../app/admin-composition-root.js";
import { createApplication } from "../app/composition-root.js";
import { createKangminHttpServer } from "../http/server.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { seedContent } from "./content-fixture.js";

// 测试进程以本地开发模式启动：未配置 KANGMIN_ENCRYPTION_KEYS 时，
// 组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为 PlaintextEncryption
//（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";


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

test("Agent 通过 HTTP 命令契约执行同一安全状态机", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-agent-http-"));
  const application = createApplication(join(directory, "agent.sqlite"));
  const token =
    (await application.sessions.createDevelopmentSession("agent-http")).token;
  const server = createKangminHttpServer(application);
  const origin = await listen(server);
  const command = async (body: unknown) => fetch(`${origin}/v1/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  try {
    const startResponse = await command({ command: "agent start" });
    assert.equal(startResponse.status, 200);
    const started = await startResponse.json() as {
      data: { id: string };
    };
    const continueResponse = await command({
      command: "agent continue",
      input: {
        id: started.data.id,
        expectedRevision: 1,
        question: "urgentHelp",
        answer: "unknown"
      }
    });
    assert.equal(continueResponse.status, 200);
    const continued = await continueResponse.json() as {
      data: { status: string; outcome: string };
    };
    assert.equal(continued.data.status, "safety_blocked");
    assert.equal(continued.data.outcome, "cannot_confirm_safety");
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

/**
 * 公开媒体路由（媒体交付链 issue-151）：管理端上传 → 发布 → 匿名下载；
 * 未发布引用/不存在/非法 id 一律 404（不泄露存在性）。
 */
test("GET /v1/media/:id：已发布引用发字节流，未发布/不存在/非法 id 404", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-media-http-"));
  const databasePath = join(directory, "content.sqlite");
  const mediaDirectory = join(directory, "admin-media");
  mkdirSync(mediaDirectory, { recursive: true });

  const admin = createAdminApplication(databasePath, { mediaDirectory });
  const adminToken =
    (await admin.sessions.createDevelopmentSession("owner-media")).token;
  const adminCommand = async (command: string, input: Record<string, unknown>) => {
    const result = await admin.execute({ command, adminToken, input });
    if (!result.ok) {
      assert.fail(`${command}: ${result.error.code}: ${result.error.message}`);
    }
    return result.data as Record<string, unknown>;
  };

  // 上传封面图（PNG 魔数）与视频（ISO BMFF ftyp 魔数）各一，外加一张
  // 只被草稿引用的图片（内容须不同：上传幂等键是文件内容指纹）。
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const draftPngBytes = Buffer.concat([pngBytes, Buffer.from([0xde, 0xad])]);
  const mp4Bytes = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32
  ]);
  const coverFile = join(mediaDirectory, "cover.png");
  const videoFile = join(mediaDirectory, "clip.mp4");
  const draftFile = join(mediaDirectory, "draft.png");
  writeFileSync(coverFile, pngBytes);
  writeFileSync(videoFile, mp4Bytes);
  writeFileSync(draftFile, draftPngBytes);
  const coverId = (await adminCommand("content media upload", { file: coverFile })).id as string;
  const videoMediaId = (await adminCommand("content media upload", { file: videoFile })).id as string;
  const draftMediaId = (await adminCommand("content media upload", { file: draftFile })).id as string;

  await adminCommand("content category create", { name: "日常防护", kind: "article" });
  await adminCommand("content category create", { name: "居家护理", kind: "video" });

  // 发布带封面的文章与带素材的视频；另一篇引用第三张图的文章保持草稿。
  const article = await adminCommand("content article create", {
    title: "封面文章",
    category: "日常防护",
    idempotencyKey: "media-e2e-article"
  });
  await adminCommand("content article update", {
    id: article.id,
    expectedRevision: 1,
    summary: "摘要",
    body: "正文",
    source: "来源",
    coverMediaId: coverId
  });
  await adminCommand("content article publish", {
    id: article.id,
    expectedRevision: 2,
    yes: true
  });
  const video = await adminCommand("content video create", {
    title: "护理视频",
    category: "居家护理",
    idempotencyKey: "media-e2e-video"
  });
  await adminCommand("content video update", {
    id: video.id,
    expectedRevision: 1,
    summary: "视频简介",
    body: "视频正文简介。",
    source: "来源",
    mediaId: videoMediaId
  });
  await adminCommand("content video publish", {
    id: video.id,
    expectedRevision: 2,
    yes: true
  });
  const draft = await adminCommand("content article create", {
    title: "草稿文章",
    category: "日常防护",
    idempotencyKey: "media-e2e-draft"
  });
  await adminCommand("content article update", {
    id: draft.id,
    expectedRevision: 1,
    coverMediaId: draftMediaId
  });

  // 患者侧应用与 HTTP 服务（本地对象存储默认指向同一 admin-media 目录）。
  const application = createApplication(databasePath);
  const server = createKangminHttpServer(application);
  const origin = await listen(server);
  try {
    // 患者侧引用已改写为公开路由（与路由自洽）。
    const shown = await application.execute({
      command: "browse video show",
      input: { id: video.id as string }
    });
    assert.equal(shown.ok, true);
    if (shown.ok) {
      assert.equal(
        (shown.data as { mediaUrl: string }).mediaUrl,
        `/v1/media/${videoMediaId}`
      );
    }

    const cover = await fetch(`${origin}/v1/media/${coverId}`);
    assert.equal(cover.status, 200);
    assert.equal(cover.headers.get("content-type"), "image/*");
    assert.equal(cover.headers.get("cache-control"), "public, max-age=3600");
    assert.equal(
      Number(cover.headers.get("content-length")),
      pngBytes.length
    );
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()), pngBytes);

    const clip = await fetch(`${origin}/v1/media/${videoMediaId}`);
    assert.equal(clip.status, 200);
    assert.equal(clip.headers.get("content-type"), "video/*");
    assert.deepEqual(Buffer.from(await clip.arrayBuffer()), mp4Bytes);

    // 素材被停用（直接改库模拟）→ 非 ready 不服务。
    const database = new KangminDatabase(databasePath);
    try {
      database.connection
        .prepare("UPDATE content_resource_media SET status = 'disabled' WHERE id = ?")
        .run(coverId);
    } finally {
      database.close();
    }
    const disabled = await fetch(`${origin}/v1/media/${coverId}`);
    assert.equal(disabled.status, 404);

    for (const path of [
      `/v1/media/${draftMediaId}`, // 仅草稿（未发布）引用
      "/v1/media/med_000000000000", // 形状合法但不存在
      "/v1/media/..%2F..%2Fetc", // 百分号编码路径穿越
      "/v1/media/not-a-valid-id", // 非法字符
      "/v1/media/med_000000000000/extra" // 斜杠附加段
    ]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 404, path);
      // 404 与不存在路由同形（命令信封），不泄露资源存在性。
      const body = await response.json() as { error: { code: string } };
      assert.equal(body.error.code, "resource_not_found", path);
    }
  } finally {
    await close(server);
    application.close();
    admin.close();
  }
});
