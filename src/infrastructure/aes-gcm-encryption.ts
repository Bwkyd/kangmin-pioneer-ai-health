import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";

import { DomainError } from "../kernel/errors.js";
import {
  EncryptionError,
  type EncryptedPayload,
  type EncryptionPort
} from "../kernel/encryption.js";

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM 标准 IV
const TAG_BYTES = 16;

export interface KeyEntry {
  version: string;
  /** 32 字节密钥的 base64 编码。 */
  key: Buffer;
}

/**
 * 解析环境变量中的密钥链。
 *
 * 格式：`KANGMIN_ENCRYPTION_KEYS="v1:<base64-32B>,v2:<base64-32B>"`，
 * 第一个条目是当前加密版本，其余条目仅用于历史数据解密（密钥轮换）。
 * 版本标识只允许 [a-zA-Z0-9_-]{1,32}。
 */
export function parseEncryptionKeys(
  value: string | undefined
): KeyEntry[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  const entries: KeyEntry[] = [];
  for (const raw of value.split(",")) {
    const part = raw.trim();
    if (part === "") {
      continue;
    }
    const separator = part.indexOf(":");
    if (separator <= 0) {
      throw new DomainError(
        "config_missing",
        "KANGMIN_ENCRYPTION_KEYS 条目必须使用 <version>:<base64-key> 格式"
      );
    }
    const version = part.slice(0, separator);
    const encoded = part.slice(separator + 1);
    if (!/^[a-zA-Z0-9_-]{1,32}$/u.test(version)) {
      throw new DomainError(
        "config_missing",
        "加密密钥版本只能包含字母、数字、下划线和连字符"
      );
    }
    let key: Buffer;
    try {
      key = Buffer.from(encoded, "base64");
    } catch (error) {
      throw new DomainError(
        "config_missing",
        "加密密钥必须是合法 base64",
        { cause: error }
      );
    }
    if (key.length !== KEY_BYTES) {
      throw new DomainError(
        "config_missing",
        "加密密钥必须是 32 字节（base64 为 44 字符）"
      );
    }
    entries.push({ version, key });
  }

  if (entries.length === 0) {
    return [];
  }
  const versions = new Set(entries.map((entry) => entry.version));
  if (versions.size !== entries.length) {
    throw new DomainError(
      "config_missing",
      "加密密钥版本不允许重复"
    );
  }
  return entries;
}

/**
 * AES-256-GCM 认证加密。
 *
 * - 加密始终使用密钥链的第一个条目（当前版本）；
 * - 解密按 payload.keyVersion 查找，支持历史密钥；
 * - 认证失败（篡改或密钥错误）抛 EncryptionError，绝不宽松解密。
 */
export class AesGcmEncryption implements EncryptionPort {
  constructor(private readonly keys: KeyEntry[]) {}

  encrypt(plaintext: string): EncryptedPayload {
    const current = this.keys[0];
    if (current === undefined) {
      throw new DomainError(
        "config_missing",
        "未配置 KANGMIN_ENCRYPTION_KEYS，无法加密健康正文"
      );
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", current.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final()
    ]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      keyVersion: current.version
    };
  }

  decrypt(payload: EncryptedPayload): string {
    const entry = this.keys.find(
      (candidate) => candidate.version === payload.keyVersion
    );
    if (entry === undefined) {
      throw new EncryptionError(
        `健康正文使用的加密密钥版本不存在：${payload.keyVersion}`
      );
    }

    let ciphertext: Buffer;
    let iv: Buffer;
    let authTag: Buffer;
    try {
      ciphertext = Buffer.from(payload.ciphertext, "base64");
      iv = Buffer.from(payload.iv, "base64");
      authTag = Buffer.from(payload.authTag, "base64");
    } catch (error) {
      throw new EncryptionError("健康正文密文不是合法 base64", {
        cause: error
      });
    }
    if (iv.length !== IV_BYTES || authTag.length !== TAG_BYTES) {
      throw new EncryptionError("健康正文密文元数据长度无效");
    }

    const decipher = createDecipheriv("aes-256-gcm", entry.key, iv);
    decipher.setAuthTag(authTag);
    try {
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]).toString("utf8");
    } catch (error) {
      throw new EncryptionError("健康正文解密认证失败", { cause: error });
    }
  }
}

/** 恒等实现：仅用于本地开发环境（local/integration），生产环境禁止注入。 */
export class PlaintextEncryption implements EncryptionPort {
  readonly keyVersion = "plaintext-dev";

  encrypt(plaintext: string): EncryptedPayload {
    return {
      ciphertext: Buffer.from(plaintext, "utf8").toString("base64"),
      iv: "",
      authTag: "",
      keyVersion: this.keyVersion
    };
  }

  decrypt(payload: EncryptedPayload): string {
    if (payload.keyVersion !== this.keyVersion) {
      throw new EncryptionError(
        `明文开发数据只接受 plaintext-dev 版本，收到：${payload.keyVersion}`
      );
    }
    return Buffer.from(payload.ciphertext, "base64").toString("utf8");
  }
}
