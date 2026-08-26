import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdminApplication } from "../app/admin-composition-root.js";
import { createApplication } from "../app/composition-root.js";
import { createKangminHttpServer } from "../http/server.js";
import { KangminDatabase } from "../infrastructure/database.js";
import type { CommandResult } from "../kernel/result.js";
import type { ConversationTurnResult } from "../modules/agent/conversation-contracts.js";
import type { PlanDialoguePort } from "../modules/agent/model-ports.js";
import type { ApprovedPlan, PlanRegistryPort } from "../modules/clinical-rules/contracts.js";
import { seedContent } from "./content-fixture.js";
import { writeConsentForTest } from "./consent-fixture.js";

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

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const separate = headers.getSetCookie?.();
  if (separate !== undefined && separate.length > 0) {
    return separate;
  }
  const combined = response.headers.get("set-cookie");
  return combined === null
    ? []
    : combined.split(/,(?=\s*[^;,]+=)/u).map((value) => value.trim());
}

function cookiePair(cookies: string[], name: string): string {
  const value = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  assert.notEqual(value, undefined, `响应应设置 ${name}`);
  return value?.split(";")[0] ?? "";
}

test("HTTP 适配器使用同一应用服务并执行真实身份和持久化", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-http-"));
  const databasePath = join(directory, "records.sqlite");
  const application = createApplication(databasePath);
  const session =
    await application.sessions.createDevelopmentSession("patient-http");
  // record 写入需 health_data 授权（issue-155 fail-closed）。
  await writeConsentForTest(databasePath, session.patientId, "health_data");
  const token = session.token;
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

test("record 写入缺 health_data 授权：HTTP 403 + consent_required", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-http-consent-"));
  const application = createApplication(join(directory, "records.sqlite"));
  const token =
    (await application.sessions.createDevelopmentSession("patient-no-consent"))
      .token;
  const server = createKangminHttpServer(application);
  const origin = await listen(server);

  try {
    // 未授权（fail-closed）：consent_required 映射 403（issue-155）。
    const denied = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        command: "record symptom add",
        input: {
          localDate: "2026-07-30",
          nasalCongestion: 1,
          nasalItching: 1,
          sneezing: 2,
          runnyNose: 0,
          idempotencyKey: "http-consent-1"
        }
      })
    });
    assert.equal(denied.status, 403);
    const deniedBody = await denied.json() as {
      ok: boolean;
      error: { code: string };
    };
    assert.equal(deniedBody.ok, false);
    assert.equal(deniedBody.error.code, "consent_required");
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

test("患者 Agent 流式接口只分片已校验并已持久化的完整结果", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-agent-stream-"));
  const application = createApplication(join(directory, "agent.sqlite"));
  const token =
    (await application.sessions.createDevelopmentSession("agent-stream-http")).token;
  const server = createKangminHttpServer(application);
  const origin = await listen(server);

  try {
    const response = await fetch(`${origin}/v1/patient/agent/stream`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/x-ndjson"
      },
      body: JSON.stringify({
        schemaVersion: "1",
        requestId: "agent-stream-e2e",
        input: { message: "我想了解我的鼻炎情况" }
      })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/u);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        type: string;
        content?: string;
        data?: { conversationId: string; message: { content: string } | null };
      });
    assert.equal(events[0]?.type, "start");
    assert.equal(events.at(-1)?.type, "done");
    const deltas = events.filter((event) => event.type === "delta");
    assert.ok(deltas.length > 1, "患者应在多个分片中看到逐步输出");
    const streamed = deltas.map((event) => event.content ?? "").join("");
    const completed = events.at(-1)?.data;
    assert.equal(streamed, completed?.message?.content);
    assert.ok(completed?.conversationId);

    const detail = await application.execute({
      command: "agent conversations show",
      input: { id: completed?.conversationId },
      sessionToken: token
    });
    assert.equal(detail.ok, true);
    if (detail.ok) {
      const messages = (detail.data as {
        messages: Array<{ role: string; content: string }>;
      }).messages;
      assert.equal(
        messages.filter((message) => message.role === "assistant").at(-1)?.content,
        streamed
      );
    }
  } finally {
    await close(server);
    application.close();
  }
});

test("患者 Agent 流式药量前置分流：危险候选不进入分片、done 或历史", async () => {
  class UnsafeDialogue implements PlanDialoguePort {
    followUpCalls = 0;

    async generatePlan(): Promise<string> {
      return "已根据当前规则结果整理方案。";
    }
    async answerFollowUp(): Promise<string> {
      this.followUpCalls += 1;
      return "您没有怀孕，可以把通鼻喷剂加量使用，每天3次。";
    }
  }
  class Plans implements PlanRegistryPort {
    async findApprovedPlanBundle(): Promise<{ acute: ApprovedPlan; constitution: ApprovedPlan }> {
      const acute: ApprovedPlan = {
        planId: "stream-acute",
        planRevision: 1,
        name: "急性期迎香调理方案",
        method: "指腹擦迎香",
        steps: JSON.stringify(["指腹轻擦迎香"]),
        precautions: "皮肤破损时暂停操作。",
        videoResourceId: null,
        attributes: {}
      };
      return {
        acute,
        constitution: { ...acute, planId: "stream-constitution", name: "体质调理方案" }
      };
    }
  }
  const data = <T>(result: CommandResult): T => {
    assert.equal(result.ok, true);
    if (!result.ok) assert.fail("命令执行失败");
    return result.data as T;
  };

  const directory = mkdtempSync(join(tmpdir(), "kangmin-agent-stream-hard-fact-"));
  const unsafeDialogue = new UnsafeDialogue();
  const application = createApplication(join(directory, "agent.sqlite"), {
    planDialogue: unsafeDialogue,
    planRegistry: new Plans()
  });
  const token =
    (await application.sessions.createDevelopmentSession("agent-stream-hard-fact")).token;
  let turn = data<ConversationTurnResult>(await application.execute({
    command: "agent exec",
    input: { message: "开始评估" },
    sessionToken: token
  }));
  for (const message of [
    "q1=C", "q2=B", "q3=B", "q4=C", "q5=D", "q6=B", "q7=C",
    "q8=C", "q9=A", "q10=B", "q11=D", "q8=B", "q10=A",
    "q12=C", "q13=B", "q14=B"
  ]) {
    turn = data<ConversationTurnResult>(await application.execute({
      command: "agent exec",
      input: { message, conversationId: turn.conversationId },
      sessionToken: token
    }));
  }
  assert.equal(turn.verdict?.outcome, "classified");

  const server = createKangminHttpServer(application);
  const origin = await listen(server);
  try {
    const response = await fetch(`${origin}/v1/patient/agent/stream`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/x-ndjson"
      },
      body: JSON.stringify({
        schemaVersion: "1",
        requestId: "agent-stream-hard-fact",
        input: {
          message: "我有一瓶不知道名字的通鼻喷剂，一天喷几次？",
          conversationId: turn.conversationId
        }
      })
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as {
      type: string;
      content?: string;
      data?: { message: { content: string } | null };
    });
    const streamed = events.filter((event) => event.type === "delta")
      .map((event) => event.content ?? "").join("");
    const final = events.at(-1)?.data?.message?.content ?? "";
    assert.equal(streamed, final);
    assert.match(final, /药品说明书|咨询医生、药师/u);
    assert.equal(unsafeDialogue.followUpCalls, 0);
    for (const forbidden of ["加量", "每天3次", "没有怀孕"]) {
      assert.ok(!streamed.includes(forbidden));
      assert.ok(!final.includes(forbidden));
    }

    const detail = data<{ messages: Array<{ content: string }> }>(await application.execute({
      command: "agent conversations show",
      input: { id: turn.conversationId },
      sessionToken: token
    }));
    const history = detail.messages.map((message) => message.content).join("\n");
    assert.ok(!history.includes("加量"));
    assert.ok(!history.includes("每天3次"));
    assert.ok(!history.includes("没有怀孕"));
  } finally {
    await close(server);
    application.close();
  }
});

test("客户预览从空库授权，刷新可恢复且两个浏览器互不串数据", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-web-http-"));
  const databasePath = join(directory, "records.sqlite");
  const application = createApplication(databasePath);
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
      /id="root"/u
    );
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /default-src 'self'/u
    );

    const session = await fetch(`${origin}/dev/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 即使伪造固定 subject，服务端也必须忽略并自己生成身份。
      body: JSON.stringify({ subject: "shared-attacker-value" })
    });
    assert.equal(session.status, 201);
    const firstCookies = setCookies(session);
    assert.equal(firstCookies.length, 2);
    for (const value of firstCookies) {
      assert.match(value, /HttpOnly/u);
      assert.match(value, /SameSite=Strict/u);
    }
    const sessionCookie = cookiePair(firstCookies, "kangmin_session");
    const previewCookie = cookiePair(
      firstCookies,
      "kangmin_preview_subject"
    );

    const consent = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        command: "account consent update",
        input: {
          consentType: "health_data",
          decision: "granted",
          policyVersion: "2026-08-01.1",
          requestId: "web-http-consent"
        }
      })
    });
    assert.equal(consent.status, 200);

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

    // 另一个浏览器使用同样的请求体也必须获得独立身份。
    const secondSession = await fetch(`${origin}/dev/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "shared-attacker-value" })
    });
    assert.equal(secondSession.status, 201);
    const secondCookies = setCookies(secondSession);
    const secondSessionCookie = cookiePair(secondCookies, "kangmin_session");
    const secondPreviewCookie = cookiePair(
      secondCookies,
      "kangmin_preview_subject"
    );
    assert.notEqual(secondPreviewCookie, previewCookie);

    const isolatedList = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: {
        cookie: secondSessionCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({ command: "record symptom list" })
    });
    assert.equal(isolatedList.status, 200);
    const isolatedBody = await isolatedList.json() as {
      data: { items: unknown[] };
    };
    assert.deepEqual(isolatedBody.data.items, []);

    // 模拟会话 Cookie 丢失/过期：仅凭 24h 预览身份重建会话，
    // 应回到第一个客户的原有记录。
    const restoredSession = await fetch(`${origin}/dev/session`, {
      method: "POST",
      headers: {
        cookie: previewCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    assert.equal(restoredSession.status, 201);
    const restoredCookies = setCookies(restoredSession);
    assert.equal(
      cookiePair(restoredCookies, "kangmin_preview_subject"),
      previewCookie
    );
    const restoredList = await fetch(`${origin}/v1/commands`, {
      method: "POST",
      headers: {
        cookie: cookiePair(restoredCookies, "kangmin_session"),
        "content-type": "application/json"
      },
      body: JSON.stringify({ command: "record symptom list" })
    });
    const restoredBody = await restoredList.json() as {
      data: { items: Array<{ tnssTotal: number }> };
    };
    assert.equal(restoredBody.data.items[0]?.tnssTotal, 6);
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
    categoryIds: ["article-general"],
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
    categoryIds: ["video-adult-quick-content"],
    idempotencyKey: "media-e2e-video"
  });
  await adminCommand("content video update", {
    id: video.id,
    expectedRevision: 1,
    summary: "视频简介",
    body: "视频正文简介。",
    source: "来源",
    instructions: "操作前确认环境安全，并按视频步骤进行。",
    precautions: "出现不适立即停止，并咨询专业人员。",
    mediaId: videoMediaId
  });
  await adminCommand("content video publish", {
    id: video.id,
    expectedRevision: 2,
    yes: true
  });
  const draft = await adminCommand("content article create", {
    title: "草稿文章",
    categoryIds: ["article-general"],
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
    // 库存 mime 是上传白名单通配形式（image/*）：路由层按对象键扩展名
    // （storedPath `<med_id>/cover.png`）映射为具体类型下发（issue-160）。
    assert.equal(cover.headers.get("content-type"), "image/png");
    assert.equal(cover.headers.get("cache-control"), "public, max-age=3600");
    assert.equal(
      Number(cover.headers.get("content-length")),
      pngBytes.length
    );
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()), pngBytes);

    const clip = await fetch(`${origin}/v1/media/${videoMediaId}`);
    assert.equal(clip.status, 200);
    assert.equal(clip.headers.get("content-type"), "video/mp4");
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
