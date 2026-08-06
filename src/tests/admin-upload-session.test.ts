import assert from "node:assert/strict";

// 测试进程以本地开发模式启动：组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为
// PlaintextEncryption（keyVersion=plaintext-dev）。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdminApplication } from "../app/admin-composition-root.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { DomainError } from "../kernel/errors.js";
import type { CommandResult } from "../kernel/result.js";
import type {
  ObjectHead,
  ObjectStoragePort,
  ObjectUploadTicket
} from "../modules/system/object-storage-ports.js";

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

function sha256Of(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * 内存对象存储（假 S3 后端）：支持预签名票据与完整性校验，
 * 用 putObject 模拟客户端直传（PUT 到票据 url）。
 */
class InMemoryObjectStorage implements ObjectStoragePort {
  readonly objects = new Map<string, Buffer>();
  ticketCount = 0;

  async putObject(input: {
    key: string;
    body: Buffer;
    contentType?: string | undefined;
  }): Promise<void> {
    this.objects.set(input.key, input.body);
  }

  async getObject(key: string): Promise<Buffer> {
    const body = this.objects.get(key);
    if (body === undefined) {
      throw new DomainError("resource_not_found", "对象不存在");
    }
    return body;
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    const body = this.objects.get(key);
    return body === undefined ? null : { sizeBytes: body.length };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async createUploadTicket(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }): Promise<ObjectUploadTicket> {
    this.ticketCount += 1;
    return {
      objectKey: input.key,
      url: `https://upload.example.invalid/${input.key}`,
      method: "PUT",
      headers: {
        "content-type": input.contentType,
        "x-amz-checksum-sha256": input.sha256
      },
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
    };
  }

  async verifyObject(input: {
    key: string;
    sha256: string;
    sizeBytes: number;
  }): Promise<boolean> {
    const body = this.objects.get(input.key);
    if (body === undefined || body.length !== input.sizeBytes) {
      return false;
    }
    return sha256Of(body) === input.sha256;
  }
}

interface InitUploading {
  status: "uploading";
  mediaId: string;
  objectKey: string;
  ticket: ObjectUploadTicket;
}

interface InitCompleted {
  status: "completed";
  media: { id: string; status: string; filename: string };
}

interface ConfirmCompleted {
  status: "completed";
  media: { id: string; status: string; failureReason: string | null };
}

async function fixture(options: { storage?: ObjectStoragePort } = {}): Promise<{
  app: ReturnType<typeof createAdminApplication>;
  databasePath: string;
  token: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-upload-session-"));
  const databasePath = join(directory, "upload.sqlite");
  const mediaDirectory = join(directory, "admin-media");
  mkdirSync(mediaDirectory, { recursive: true });
  const app = createAdminApplication(databasePath, {
    mediaDirectory,
    ...(options.storage === undefined ? {} : { objectStorage: options.storage })
  });
  const session = await app.sessions.createDevelopmentSession("owner-upload");
  return { app, databasePath, token: session.token };
}

const GUIDE = Buffer.from("# 鼻健康指南\n\n换季注意保暖与清洁。\n\n第二条段落。");

test("upload-init → 客户端直传 → upload-confirm 全链路（假 S3 后端）", async () => {
  const storage = new InMemoryObjectStorage();
  const { app, token } = await fixture({ storage });
  try {
    const sha256 = sha256Of(GUIDE);
    const init = dataOf<InitUploading>(
      await app.execute({
        command: "content media upload-init",
        adminToken: token,
        input: { filename: "guide.md", sizeBytes: GUIDE.length, sha256 }
      })
    );
    assert.equal(init.status, "uploading");
    assert.ok(init.mediaId.startsWith("med_"));
    assert.equal(init.objectKey, `${init.mediaId}/guide.md`);
    assert.equal(init.ticket.method, "PUT");
    assert.equal(init.ticket.headers["x-amz-checksum-sha256"], sha256);

    // 草稿行：processing。
    const processing = dataOf<{ items: Array<{ id: string; status: string }> }>(
      await app.execute({ command: "content media list", adminToken: token })
    );
    assert.equal(processing.items.length, 1);
    assert.equal(processing.items[0]?.status, "processing");

    // 客户端按票据直传（测试以 putObject 模拟 PUT）。
    await storage.putObject({ key: init.objectKey, body: GUIDE });

    const confirmed = dataOf<ConfirmCompleted>(
      await app.execute({
        command: "content media upload-confirm",
        adminToken: token,
        input: { mediaId: init.mediaId, sha256 }
      })
    );
    assert.equal(confirmed.status, "completed");
    assert.equal(confirmed.media.status, "ready");
    assert.equal(confirmed.media.failureReason, null);

    // 重复确认：幂等重放 completed。
    const replay = dataOf<ConfirmCompleted>(
      await app.execute({
        command: "content media upload-confirm",
        adminToken: token,
        input: { mediaId: init.mediaId, sha256 }
      })
    );
    assert.equal(replay.media.id, init.mediaId);
    assert.equal(replay.media.status, "ready");
  } finally {
    app.close();
  }
});

test("本地文件系统后端 upload-init 返回同源票据并登记草稿", async () => {
  const { app, token } = await fixture();
  try {
    const init = await app.execute({
      command: "content media upload-init",
      adminToken: token,
      input: { filename: "guide.md", sizeBytes: GUIDE.length, sha256: sha256Of(GUIDE) }
    });
    assert.equal(init.ok, true);
    if (init.ok) {
      const data = init.data as InitUploading;
      assert.equal(data.status, "uploading");
      assert.equal(data.ticket.url, "/v1/admin/upload");
      assert.ok(data.ticket.headers["x-kangmin-upload-ticket"]);
    }

    const listed = dataOf<{ items: Array<{ status: string }> }>(
      await app.execute({ command: "content media list", adminToken: token })
    );
    assert.equal(listed.items[0]?.status, "processing");
  } finally {
    app.close();
  }
});

test("重复上传：ready 行重放 completed 不发新票据；processing 行重发票据", async () => {
  const storage = new InMemoryObjectStorage();
  const { app, token } = await fixture({ storage });
  try {
    const sha256 = sha256Of(GUIDE);
    const first = dataOf<InitUploading>(
      await app.execute({
        command: "content media upload-init",
        adminToken: token,
        input: { filename: "guide.md", sizeBytes: GUIDE.length, sha256 }
      })
    );
    assert.equal(storage.ticketCount, 1);
    await storage.putObject({ key: first.objectKey, body: GUIDE });
    dataOf(
      await app.execute({
        command: "content media upload-confirm",
        adminToken: token,
        input: { mediaId: first.mediaId, sha256 }
      })
    );

    // 同指纹（不同文件名）再 init：重放 completed，不发新票据。
    const replay = dataOf<InitCompleted>(
      await app.execute({
        command: "content media upload-init",
        adminToken: token,
        input: { filename: "renamed.md", sizeBytes: GUIDE.length, sha256 }
      })
    );
    assert.equal(replay.status, "completed");
    assert.equal(replay.media.id, first.mediaId);
    assert.equal(replay.media.status, "ready");
    assert.equal(storage.ticketCount, 1);

    // processing 行（中断重试）：复用同一 mediaId 重发票据，不新建行。
    const other = Buffer.from("# 另一份指南\n\n内容不同。");
    const otherSha = sha256Of(other);
    const draft = dataOf<InitUploading>(
      await app.execute({
        command: "content media upload-init",
        adminToken: token,
        input: { filename: "other.md", sizeBytes: other.length, sha256: otherSha }
      })
    );
    assert.equal(storage.ticketCount, 2);
    const retried = dataOf<InitUploading>(
      await app.execute({
        command: "content media upload-init",
        adminToken: token,
        input: { filename: "other.md", sizeBytes: other.length, sha256: otherSha }
      })
    );
    assert.equal(retried.status, "uploading");
    assert.equal(retried.mediaId, draft.mediaId);
    assert.equal(retried.objectKey, draft.objectKey);
    assert.equal(storage.ticketCount, 3);

    const listed = dataOf<{ items: Array<{ id: string }> }>(
      await app.execute({ command: "content media list", adminToken: token })
    );
    assert.equal(listed.items.length, 2);
  } finally {
    app.close();
  }
});

test("upload-confirm：sha256 形状与不匹配 → validation_failed；不存在 → resource_not_found", async () => {
  const storage = new InMemoryObjectStorage();
  const { app, token } = await fixture({ storage });
  try {
    const sha256 = sha256Of(GUIDE);
    const init = dataOf<InitUploading>(
      await app.execute({
        command: "content media upload-init",
        adminToken: token,
        input: { filename: "guide.md", sizeBytes: GUIDE.length, sha256 }
      })
    );

    const malformed = await app.execute({
      command: "content media upload-confirm",
      adminToken: token,
      input: { mediaId: init.mediaId, sha256: "not-hex" }
    });
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.error.code, "validation_failed");

    const mismatch = await app.execute({
      command: "content media upload-confirm",
      adminToken: token,
      input: { mediaId: init.mediaId, sha256: sha256Of(Buffer.from("别的内容")) }
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.code, "validation_failed");

    const missing = await app.execute({
      command: "content media upload-confirm",
      adminToken: token,
      input: { mediaId: "med_missing0000", sha256 }
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "resource_not_found");

    // 行仍为 processing，可继续完成上传。
    const listed = dataOf<{ items: Array<{ status: string }> }>(
      await app.execute({ command: "content media list", adminToken: token })
    );
    assert.equal(listed.items[0]?.status, "processing");
  } finally {
    app.close();
  }
});

test("confirm 校验失败（字节不符 / 类型伪装）：转 failed + 删除对象 + 固定文案", async () => {
  const storage = new InMemoryObjectStorage();
  const { app, token } = await fixture({ storage });
  try {
    // 场景一：声明的 sha 与实际直传字节不符 → verifyObject false。
    const sha256 = sha256Of(GUIDE);
    const init = dataOf<InitUploading>(
      await app.execute({
        command: "content media upload-init",
        adminToken: token,
        input: { filename: "guide.md", sizeBytes: GUIDE.length, sha256 }
      })
    );
    await storage.putObject({ key: init.objectKey, body: Buffer.from("被篡改的内容") });

    const failed = await app.execute({
      command: "content media upload-confirm",
      adminToken: token,
      input: { mediaId: init.mediaId, sha256 }
    });
    assert.equal(failed.ok, false);
    if (!failed.ok) {
      assert.equal(failed.error.code, "validation_failed");
      assert.equal(failed.error.message, "上传内容校验失败，请重新上传");
    }
    const shown = dataOf<{ status: string; failureReason: string | null }>(
      await app.execute({
        command: "content media show",
        adminToken: token,
        input: { id: init.mediaId }
      })
    );
    assert.equal(shown.status, "failed");
    assert.equal(shown.failureReason, "上传内容校验失败");
    assert.equal(storage.objects.has(init.objectKey), false);

    // 场景二：sha 一致但内容魔数与声明类型不符（txt 改名 .png）。
    const text = Buffer.from("只是文本，不是图片");
    const textSha = sha256Of(text);
    const fakeImage = dataOf<InitUploading>(
      await app.execute({
        command: "content media upload-init",
        adminToken: token,
        input: { filename: "fake.png", sizeBytes: text.length, sha256: textSha }
      })
    );
    await storage.putObject({ key: fakeImage.objectKey, body: text });
    const sniffed = await app.execute({
      command: "content media upload-confirm",
      adminToken: token,
      input: { mediaId: fakeImage.mediaId, sha256: textSha }
    });
    assert.equal(sniffed.ok, false);
    if (!sniffed.ok) {
      assert.equal(sniffed.error.code, "validation_failed");
      assert.equal(sniffed.error.message, "上传内容校验失败，请重新上传");
    }
  } finally {
    app.close();
  }
});

test("cleanup-orphans：默认阈值 60 分钟、--yes 门禁与范围校验", async () => {
  const storage = new InMemoryObjectStorage();
  const { app, databasePath, token } = await fixture({ storage });
  try {
    const freshFile = Buffer.from("# 新草稿\n\n刚发起。");
    const staleFile = Buffer.from("# 旧草稿\n\n两小时前中断。");
    const fresh = dataOf<InitUploading>(
      await app.execute({
        command: "content media upload-init",
        adminToken: token,
        input: {
          filename: "fresh.md",
          sizeBytes: freshFile.length,
          sha256: sha256Of(freshFile)
        }
      })
    );
    const stale = dataOf<InitUploading>(
      await app.execute({
        command: "content media upload-init",
        adminToken: token,
        input: {
          filename: "stale.md",
          sizeBytes: staleFile.length,
          sha256: sha256Of(staleFile)
        }
      })
    );
    await storage.putObject({ key: stale.objectKey, body: staleFile });

    // 把旧草稿的 updated_at 回拨到两小时前（模拟中断残留）。
    const database = new KangminDatabase(databasePath);
    try {
      database.connection.prepare(
        "UPDATE content_resource_media SET updated_at = ? WHERE id = ?"
      ).run(new Date(Date.now() - 2 * 3600_000).toISOString(), stale.mediaId);
    } finally {
      database.close();
    }

    // 缺 --yes → confirmation_required
    const noConfirm = await app.execute({
      command: "content media cleanup-orphans",
      adminToken: token,
      input: {}
    });
    assert.equal(noConfirm.ok, false);
    if (!noConfirm.ok) assert.equal(noConfirm.error.code, "confirmation_required");

    // 阈值越界 → validation_failed
    const outOfRange = await app.execute({
      command: "content media cleanup-orphans",
      adminToken: token,
      input: { olderThanMinutes: 3, yes: true }
    });
    assert.equal(outOfRange.ok, false);
    if (!outOfRange.ok) assert.equal(outOfRange.error.code, "validation_failed");

    // 默认阈值 60 分钟：只清理回拨过的旧草稿。
    const cleaned = dataOf<{ cleaned: number }>(
      await app.execute({
        command: "content media cleanup-orphans",
        adminToken: token,
        input: { yes: true }
      })
    );
    assert.equal(cleaned.cleaned, 1);
    const listed = dataOf<{ items: Array<{ id: string }> }>(
      await app.execute({ command: "content media list", adminToken: token })
    );
    assert.deepEqual(
      listed.items.map((item) => item.id),
      [fresh.mediaId]
    );
    assert.equal(storage.objects.has(stale.objectKey), false);
  } finally {
    app.close();
  }
});

test("agent knowledge add-from-media：ready 素材 → 知识创建 → 幂等重放；非 ready 拒绝", async () => {
  const storage = new InMemoryObjectStorage();
  const { app, token } = await fixture({ storage });
  try {
    const sha256 = sha256Of(GUIDE);
    const init = dataOf<InitUploading>(
      await app.execute({
        command: "content media upload-init",
        adminToken: token,
        input: { filename: "guide.md", sizeBytes: GUIDE.length, sha256 }
      })
    );
    await storage.putObject({ key: init.objectKey, body: GUIDE });
    dataOf(
      await app.execute({
        command: "content media upload-confirm",
        adminToken: token,
        input: { mediaId: init.mediaId, sha256 }
      })
    );

    const knowledge = dataOf<{
      id: string;
      status: string;
      sourceMediaId: string | null;
      chunkCount: number;
      sha256: string | null;
    }>(
      await app.execute({
        command: "agent knowledge add-from-media",
        adminToken: token,
        input: { mediaId: init.mediaId, source: "临床指南", description: "远程上传" }
      })
    );
    assert.equal(knowledge.status, "processing");
    assert.equal(knowledge.sourceMediaId, init.mediaId);
    assert.ok(knowledge.chunkCount > 0);
    assert.equal(knowledge.sha256, sha256);

    // 幂等重放：同素材（同 sha256 键）重复提交返回原知识，不重复创建。
    const replay = dataOf<{ id: string }>(
      await app.execute({
        command: "agent knowledge add-from-media",
        adminToken: token,
        input: { mediaId: init.mediaId }
      })
    );
    assert.equal(replay.id, knowledge.id);
    const listed = dataOf<{ items: Array<{ id: string }> }>(
      await app.execute({ command: "agent knowledge list", adminToken: token })
    );
    assert.equal(listed.items.length, 1);

    // 素材未 confirm（processing）→ validation_failed
    const pendingFile = Buffer.from("# 未完成\n\n还在上传。");
    const pending = dataOf<InitUploading>(
      await app.execute({
        command: "content media upload-init",
        adminToken: token,
        input: {
          filename: "pending.md",
          sizeBytes: pendingFile.length,
          sha256: sha256Of(pendingFile)
        }
      })
    );
    const notReady = await app.execute({
      command: "agent knowledge add-from-media",
      adminToken: token,
      input: { mediaId: pending.mediaId }
    });
    assert.equal(notReady.ok, false);
    if (!notReady.ok) {
      assert.equal(notReady.error.code, "validation_failed");
      assert.equal(notReady.error.message, "素材未完成上传");
    }

    // 素材不存在 → resource_not_found
    const missing = await app.execute({
      command: "agent knowledge add-from-media",
      adminToken: token,
      input: { mediaId: "med_missing0000" }
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "resource_not_found");
  } finally {
    app.close();
  }
});
