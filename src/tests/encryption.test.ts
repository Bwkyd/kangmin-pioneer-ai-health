import assert from "node:assert/strict";
import test from "node:test";

import {
  AesGcmEncryption,
  parseEncryptionKeys,
  PlaintextEncryption
} from "../infrastructure/aes-gcm-encryption.js";
import { EncryptionError } from "../kernel/encryption.js";
import { DomainError } from "../kernel/errors.js";

/** 固定的 32 字节测试密钥（base64），只用于测试，不进入任何生产数据。 */
const KEY_V1 = Buffer.alloc(32, 1).toString("base64");
const KEY_V2 = Buffer.alloc(32, 2).toString("base64");

test("parseEncryptionKeys 解析密钥链并保持顺序（首个为当前版本）", () => {
  const keys = parseEncryptionKeys(`v1:${KEY_V1},v2:${KEY_V2}`);
  assert.equal(keys.length, 2);
  assert.equal(keys[0]?.version, "v1");
  assert.equal(keys[1]?.version, "v2");
});

test("parseEncryptionKeys 拒绝空值、坏格式、错误长度和重复版本", () => {
  assert.deepEqual(parseEncryptionKeys(undefined), []);
  assert.deepEqual(parseEncryptionKeys(""), []);
  assert.deepEqual(parseEncryptionKeys(","), []);

  for (const invalid of [
    "v1", // 缺少冒号
    ":YQ==", // 缺少版本
    "bad version:YQ==", // 版本含非法字符
    `v1:${Buffer.alloc(16, 1).toString("base64")}`, // 长度不是 32 字节
    `v1:@@@` // 非法 base64
  ]) {
    assert.throws(() => parseEncryptionKeys(invalid), DomainError);
  }

  assert.throws(
    () => parseEncryptionKeys(`v1:${KEY_V1},v1:${KEY_V2}`),
    (error: unknown) =>
      error instanceof DomainError && error.code === "config_missing"
  );
});

test("加密解密往返：使用当前版本，结果可解密且携带密钥版本", () => {
  const encryption = new AesGcmEncryption(parseEncryptionKeys(`v1:${KEY_V1}`));
  const payload = encryption.encrypt("换季后加重，夜间鼻塞明显");
  assert.equal(payload.keyVersion, "v1");
  assert.notEqual(payload.ciphertext, "");

  const plaintext = encryption.decrypt(payload);
  assert.equal(plaintext, "换季后加重，夜间鼻塞明显");
});

test("同一明文每次加密得到不同密文（随机 IV）", () => {
  const encryption = new AesGcmEncryption(parseEncryptionKeys(`v1:${KEY_V1}`));
  const first = encryption.encrypt("相同内容");
  const second = encryption.encrypt("相同内容");
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.iv, second.iv);
});

test("历史密钥可以解密旧版本数据，未知版本被拒绝", () => {
  const current = new AesGcmEncryption(
    parseEncryptionKeys(`v2:${KEY_V2},v1:${KEY_V1}`)
  );
  const legacy = new AesGcmEncryption(parseEncryptionKeys(`v1:${KEY_V1}`));
  const legacyPayload = legacy.encrypt("历史数据");

  assert.equal(current.decrypt(legacyPayload), "历史数据");

  const unknown = new AesGcmEncryption(parseEncryptionKeys(`v2:${KEY_V2}`));
  assert.throws(
    () => unknown.decrypt(legacyPayload),
    (error: unknown) => error instanceof EncryptionError
  );
});

/** 把 base64 字符串的首字符确定性地改成另一个合法 base64 字符。 */
function flipFirstChar(value: string): string {
  const first = value[0] ?? "A";
  return `${first === "A" ? "B" : "A"}${value.slice(1)}`;
}

test("篡改密文、IV 或认证标签都会导致认证失败", () => {
  const encryption = new AesGcmEncryption(parseEncryptionKeys(`v1:${KEY_V1}`));
  const payload = encryption.encrypt("不可篡改");

  const tamperedCipher = {
    ...payload,
    ciphertext: flipFirstChar(payload.ciphertext)
  };
  assert.throws(() => encryption.decrypt(tamperedCipher), EncryptionError);

  const tamperedIv = { ...payload, iv: flipFirstChar(payload.iv) };
  assert.throws(() => encryption.decrypt(tamperedIv), EncryptionError);

  const tamperedTag = { ...payload, authTag: flipFirstChar(payload.authTag) };
  assert.throws(() => encryption.decrypt(tamperedTag), EncryptionError);
});

test("未配置密钥时加密抛 config_missing", () => {
  const encryption = new AesGcmEncryption([]);
  assert.throws(
    () => encryption.encrypt("任何内容"),
    (error: unknown) =>
      error instanceof DomainError && error.code === "config_missing"
  );
});

test("明文开发实现只接受自身版本，且生产语义上不可用于正式数据", () => {
  const dev = new PlaintextEncryption();
  const payload = dev.encrypt("本地开发");
  assert.equal(payload.keyVersion, "plaintext-dev");
  assert.equal(dev.decrypt(payload), "本地开发");

  assert.throws(() => dev.decrypt({ ...payload, keyVersion: "v1" }), EncryptionError);
});
