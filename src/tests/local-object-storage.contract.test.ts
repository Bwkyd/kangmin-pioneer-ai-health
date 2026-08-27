/**
 * LocalFilesystemObjectStorage 契约测试：本地文件系统后端的
 * ObjectStoragePort 语义。
 *
 * 覆盖：
 * - put/head/get/delete roundtrip；
 * - key 越界拒绝（../ 与绝对路径 → validation_failed）；
 * - verifyObject：成功、大小不符、校验和不符、对象不存在均返回 false；
 * - deleteObject 幂等（重复删除不报错）；
 * - createUploadTicket 抛 capability_unavailable（本地后端不支持直传）。
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import { DomainError } from "@kangmin/core/kernel/errors";
import { LocalFilesystemObjectStorage } from "@kangmin/integrations/storage/local-filesystem-object-storage";

const roots: string[] = [];

after(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createStorage(): LocalFilesystemObjectStorage {
  const root = mkdtempSync(join(tmpdir(), "kangmin-local-storage-"));
  roots.push(root);
  return new LocalFilesystemObjectStorage(root);
}

function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

test("put/head/get/delete roundtrip", async () => {
  const storage = createStorage();
  const key = "med-1/report.pdf";
  const body = randomBytes(2048);

  await storage.putObject({ key, body, contentType: "application/pdf" });
  assert.deepEqual(await storage.headObject(key), { sizeBytes: body.length });
  assert.deepEqual(await storage.getObject(key), body);

  await storage.deleteObject(key);
  assert.equal(await storage.headObject(key), null);
  await assert.rejects(storage.getObject(key), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "resource_not_found");
    return true;
  });
});

test("key 越界（../ 与绝对路径）一律拒绝 validation_failed", async () => {
  const storage = createStorage();
  const body = randomBytes(16);
  const invalidKeys = ["../evil.bin", "a/../../evil.bin", "/etc/passwd"];

  for (const key of invalidKeys) {
    await assert.rejects(storage.putObject({ key, body }), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "validation_failed");
      return true;
    });
    await assert.rejects(storage.getObject(key), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "validation_failed");
      return true;
    });
    await assert.rejects(storage.headObject(key), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "validation_failed");
      return true;
    });
    await assert.rejects(storage.deleteObject(key), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "validation_failed");
      return true;
    });
    await assert.rejects(
      storage.verifyObject({ key, sha256: sha256Hex(body), sizeBytes: body.length }),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, "validation_failed");
        return true;
      }
    );
  }
});

test("verifyObject：成功、大小不符、校验和不符、对象不存在", async () => {
  const storage = createStorage();
  const key = "med-2/scan.dcm";
  const body = randomBytes(4096);
  const digest = sha256Hex(body);

  await storage.putObject({ key, body });
  assert.equal(
    await storage.verifyObject({ key, sha256: digest, sizeBytes: body.length }),
    true
  );
  assert.equal(
    await storage.verifyObject({ key, sha256: digest, sizeBytes: body.length + 1 }),
    false
  );
  assert.equal(
    await storage.verifyObject({
      key,
      sha256: sha256Hex(randomBytes(4096)),
      sizeBytes: body.length
    }),
    false
  );
  assert.equal(
    await storage.verifyObject({
      key: "med-2/absent.dcm",
      sha256: digest,
      sizeBytes: body.length
    }),
    false
  );
});

test("deleteObject 幂等：重复删除不存在的 key 不报错", async () => {
  const storage = createStorage();
  const key = "med-3/photo.jpg";
  await storage.deleteObject(key);
  await storage.putObject({ key, body: randomBytes(64) });
  await storage.deleteObject(key);
  await storage.deleteObject(key);
  assert.equal(await storage.headObject(key), null);
});

test("本地直传票据一次有效并校验文件指纹", async () => {
  const storage = createStorage();
  const body = Buffer.from("# 本地知识\n");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const ticket = await storage.createUploadTicket({
    key: "med-4/guide.md",
    contentType: "text/markdown",
    sizeBytes: body.length,
    sha256
  });
  assert.equal(ticket.url, "/v1/admin/upload");
  const token = ticket.headers["x-kangmin-upload-ticket"];
  assert.ok(token);
  await storage.acceptUploadTicket({ token, body });
  assert.deepEqual(await storage.getObject("med-4/guide.md"), body);
  await assert.rejects(storage.acceptUploadTicket({ token, body }), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "authentication_required");
    return true;
  });
});
