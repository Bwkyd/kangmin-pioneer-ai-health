import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdminApplication } from "@kangmin/runtime/admin-composition-root";
import { KangminDatabase } from "@kangmin/database/sqlite/database";
import { ContentAdminService } from "@kangmin/core/operations/admin/content-admin-service";
import { SqliteContentAdminRepository } from "@kangmin/database/sqlite/content-admin-repository";
import { SqliteContentAuxRepository } from "@kangmin/database/sqlite/content-aux-repository";
import type { CommandResult } from "@kangmin/core/kernel/result";
import type { ContentMessageRow } from "@kangmin/core/operations/admin/content-aux-repository";

process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  return result.data as T;
}

async function fixture(): Promise<{
  app: ReturnType<typeof createAdminApplication>;
  databasePath: string;
  token: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-admin-content-atomic-"));
  const databasePath = join(directory, "content.sqlite");
  const app = createAdminApplication(databasePath, {
    mediaDirectory: join(directory, "admin-media")
  });
  const session = await app.sessions.createDevelopmentSession("owner-content-atomic");
  return { app, databasePath, token: session.token };
}

test("内容 create/update 写入审计：同一事务全成全败，已发布公告改稿回草稿（#390/#394）", async () => {
  const { app, databasePath, token } = await fixture();
  try {
    const message = dataOf<ContentMessageRow>(await app.execute({
      command: "content message create",
      adminToken: token,
      requestId: "message-create-request",
      input: { title: "可审计通知", body: "第一版正文" }
    }));
    const published = dataOf<ContentMessageRow>(await app.execute({
      command: "content message publish",
      adminToken: token,
      requestId: "message-publish-request",
      input: { id: message.id, expectedRevision: 1, yes: true }
    }));
    assert.equal(published.status, "published");

    const updated = dataOf<ContentMessageRow>(await app.execute({
      command: "content message update",
      adminToken: token,
      requestId: "message-update-request",
      input: { id: message.id, expectedRevision: 2, title: "改稿通知", body: "第二版正文" }
    }));
    assert.equal(updated.status, "draft");
    assert.equal(updated.publishedAt, null);
    assert.equal(updated.revision, 3);

    const database = new KangminDatabase(databasePath);
    try {
      const audits = database.connection.prepare(`
        SELECT actor_id, action, entity_id, entity_revision, request_id, details_json
        FROM audit_events
        WHERE entity_id = ?
        ORDER BY created_at ASC
      `).all(message.id) as unknown as Array<{
        actor_id: string;
        action: string;
        entity_id: string;
        entity_revision: number;
        request_id: string | null;
        details_json: string;
      }>;
      assert.deepEqual(audits.map((audit) => audit.action), [
        "content.message.create",
        "content.message.publish",
        "content.message.update"
      ]);
      assert.equal(audits[0]?.request_id, "message-create-request");
      assert.equal(audits[2]?.request_id, "message-update-request");
      assert.equal(audits[2]?.entity_revision, 3);
      assert.doesNotMatch(audits[2]?.details_json ?? "", /第二版正文/u);
    } finally {
      database.close();
    }
  } finally {
    app.close();
  }
});

test("内容审计失败时 create 和 update 均回滚业务写入", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-content-audit-atomic-"));
  const databasePath = join(directory, "content.sqlite");
  const database = new KangminDatabase(databasePath);
  const repository = new SqliteContentAdminRepository(database);
  const aux = new SqliteContentAuxRepository(database);
  const failingAudit = { record: async () => { throw new Error("audit unavailable"); } };
  const timestamp = new Date().toISOString();
  database.connection.prepare(`
    INSERT INTO admin_accounts(
      id, username, password_hash, role, status, revision, created_at, updated_at
    ) VALUES (?, ?, ?, 'admin', 'active', 1, ?, ?)
  `).run(
    "admin-atomic",
    "atomic-admin",
    "test-password-hash",
    timestamp,
    timestamp
  );
  const createInput = {
    title: "审计失败文章",
    category: "",
    categoryIds: ["article-general"],
    summary: "摘要",
    body: "正文",
    source: "来源",
    coverMediaId: null,
    mediaId: null,
    instructions: "",
    precautions: "",
    disclaimer: "",
    methodTags: [],
    displayOrder: 0,
    idempotencyKey: "audit-atomic-create"
  };
  try {
    const failingService = new ContentAdminService(repository, aux, failingAudit);
    await assert.rejects(() => failingService.create("admin-atomic", createInput), /audit unavailable/u);
    assert.equal((database.connection.prepare("SELECT COUNT(*) AS count FROM content_items").get() as { count: number }).count, 0);
    assert.equal((database.connection.prepare("SELECT COUNT(*) AS count FROM admin_idempotency").get() as { count: number }).count, 0);
    assert.equal((database.connection.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count, 0);

    const workingService = new ContentAdminService(repository, aux, { record: async () => {} });
    const created = await workingService.create("admin-atomic", { ...createInput, idempotencyKey: "audit-atomic-update-create" });
    await assert.rejects(
      () => failingService.update("admin-atomic", created.id, 1, { title: "不应落库" }, "audit-atomic-update"),
      /audit unavailable/u
    );
    const unchanged = await repository.find("article", created.id);
    assert.equal(unchanged?.title, "审计失败文章");
    assert.equal(unchanged?.revision, 1);
  } finally {
    database.close();
  }
});
