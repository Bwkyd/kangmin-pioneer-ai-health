/**
 * S3ObjectStorage 契约测试：以真实 S3 兼容端点（本地 MinIO）验证
 * ObjectStoragePort 语义。
 *
 * 覆盖：
 * - put/head/get/delete roundtrip（含 getObject 缺失 key →
 *   resource_not_found）；
 * - 大文件（50MB 随机 buffer）roundtrip；
 * - verifyObject：成功（签名头校验路径与 GET 重算兜底路径）、大小不符、
 *   校验和不符、对象不存在，均返回 false 不抛错；
 * - 预签名票据直传全流程（createUploadTicket → HTTP PUT → verifyObject
 *   → getObject 内容一致）；
 * - 票据直传后 verifyObject 用其他 sha256 → false；
 * - deleteObject 幂等（重复删除不报错）。
 *
 * 运行前需设置 KANGMIN_TEST_S3_ENDPOINT 与 KANGMIN_TEST_S3_BUCKET
 * （如 http://127.0.0.1:9900 与 kangmin-test），bucket 不存在时由实现
 * 自动创建。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { DomainError } from "@kangmin/core/kernel/errors";
import { S3ObjectStorage } from "@kangmin/integrations/storage/s3-object-storage";

const ENDPOINT = process.env.KANGMIN_TEST_S3_ENDPOINT;
const BUCKET = process.env.KANGMIN_TEST_S3_BUCKET;
const SKIP_REASON =
  "未配置 KANGMIN_TEST_S3_ENDPOINT / KANGMIN_TEST_S3_BUCKET";
const SKIP =
  ENDPOINT === undefined || BUCKET === undefined ? SKIP_REASON : false;

function createStorage(): S3ObjectStorage {
  assert.ok(ENDPOINT !== undefined && BUCKET !== undefined, SKIP_REASON);
  return new S3ObjectStorage({
    bucket: BUCKET,
    endpoint: ENDPOINT,
    region: "us-east-1",
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin"
  });
}

function testKey(name: string): string {
  return `contract-${randomUUID()}/${name}`;
}

function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

test("put/head/get/delete roundtrip，删除后 getObject 映射 resource_not_found", { skip: SKIP }, async () => {
  const storage = createStorage();
  const key = testKey("roundtrip.bin");
  const body = randomBytes(4096);

  await storage.putObject({ key, body, contentType: "application/octet-stream" });

  const head = await storage.headObject(key);
  assert.deepEqual(head, { sizeBytes: body.length });

  const readBack = await storage.getObject(key);
  assert.deepEqual(readBack, body);

  await storage.deleteObject(key);
  assert.equal(await storage.headObject(key), null);
  await assert.rejects(storage.getObject(key), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "resource_not_found");
    return true;
  });
});

test("headObject 对不存在的对象返回 null", { skip: SKIP }, async () => {
  const storage = createStorage();
  assert.equal(await storage.headObject(testKey("missing.bin")), null);
});

test("大文件（50MB 随机 buffer）roundtrip", { skip: SKIP }, async () => {
  const storage = createStorage();
  const key = testKey("large.bin");
  const body = randomBytes(50 * 1024 * 1024);

  await storage.putObject({ key, body });
  const head = await storage.headObject(key);
  assert.deepEqual(head, { sizeBytes: body.length });

  const readBack = await storage.getObject(key);
  assert.equal(readBack.length, body.length);
  assert.equal(sha256Hex(readBack), sha256Hex(body));

  await storage.deleteObject(key);
});

test("verifyObject：成功（GET 重算兜底）与大小/校验和不符、对象不存在均返回 false", { skip: SKIP }, async () => {
  const storage = createStorage();
  const key = testKey("verify.bin");
  const body = randomBytes(8192);
  const digest = sha256Hex(body);

  // putObject 不绑定校验和：verifyObject 走 GET 下载重算兜底路径。
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
      sha256: sha256Hex(randomBytes(8192)),
      sizeBytes: body.length
    }),
    false
  );
  assert.equal(
    await storage.verifyObject({
      key: testKey("absent.bin"),
      sha256: digest,
      sizeBytes: body.length
    }),
    false
  );

  await storage.deleteObject(key);
});

test("预签名票据直传全流程：PUT → verifyObject true → getObject 内容一致", { skip: SKIP }, async () => {
  const storage = createStorage();
  const key = testKey("ticket.bin");
  const body = randomBytes(16 * 1024);
  const digest = sha256Hex(body);

  const ticket = await storage.createUploadTicket({
    key,
    contentType: "application/octet-stream",
    sizeBytes: body.length,
    sha256: digest
  });
  assert.equal(ticket.objectKey, key);
  assert.equal(ticket.method, "PUT");
  assert.equal(ticket.headers["content-type"], "application/octet-stream");
  assert.equal(
    ticket.headers["x-amz-checksum-sha256"],
    Buffer.from(digest, "hex").toString("base64")
  );
  assert.ok(Date.parse(ticket.expiresAt) > Date.now());

  const response = await fetch(ticket.url, {
    method: ticket.method,
    headers: ticket.headers,
    body: new Uint8Array(body)
  });
  assert.ok(response.ok, `直传失败：HTTP ${response.status}`);

  // 签名头路径：HeadObject 直接比对 ChecksumSHA256。
  assert.equal(
    await storage.verifyObject({ key, sha256: digest, sizeBytes: body.length }),
    true
  );

  const readBack = await storage.getObject(key);
  assert.deepEqual(readBack, body);

  await storage.deleteObject(key);
});

test("预签名票据在桶不存在时自动建桶（直传不依赖外部建桶顺序）", { skip: SKIP }, async () => {
  assert.ok(ENDPOINT !== undefined, SKIP_REASON);
  // 唯一桶名：MinIO/CI 环境保证不存在，直接守卫
  // "createUploadTicket 先建桶再签名"（issue-155 CI 404 回归）。
  const storage = new S3ObjectStorage({
    bucket: `kangmin-fresh-${randomUUID().slice(0, 8)}`,
    endpoint: ENDPOINT,
    region: "us-east-1",
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin"
  });
  const body = randomBytes(256);
  const ticket = await storage.createUploadTicket({
    key: "fresh/probe.bin",
    contentType: "application/octet-stream",
    sizeBytes: body.length,
    sha256: sha256Hex(body)
  });
  const response = await fetch(ticket.url, {
    method: ticket.method,
    headers: ticket.headers,
    body: new Uint8Array(body)
  });
  assert.ok(response.ok, `直传失败：HTTP ${String(response.status)}`);
});

test("票据直传后 verifyObject 使用其他 sha256 返回 false", { skip: SKIP }, async () => {
  const storage = createStorage();
  const key = testKey("ticket-mismatch.bin");
  const body = randomBytes(4096);

  const ticket = await storage.createUploadTicket({
    key,
    contentType: "application/octet-stream",
    sizeBytes: body.length,
    sha256: sha256Hex(body)
  });
  const response = await fetch(ticket.url, {
    method: ticket.method,
    headers: ticket.headers,
    body: new Uint8Array(body)
  });
  assert.ok(response.ok, `直传失败：HTTP ${response.status}`);

  assert.equal(
    await storage.verifyObject({
      key,
      sha256: sha256Hex(randomBytes(4096)),
      sizeBytes: body.length
    }),
    false
  );

  await storage.deleteObject(key);
});

test("deleteObject 幂等：重复删除不存在的 key 不报错", { skip: SKIP }, async () => {
  const storage = createStorage();
  const key = testKey("idempotent.bin");
  await storage.deleteObject(key);
  await storage.putObject({ key, body: randomBytes(128) });
  await storage.deleteObject(key);
  await storage.deleteObject(key);
  assert.equal(await storage.headObject(key), null);
});
