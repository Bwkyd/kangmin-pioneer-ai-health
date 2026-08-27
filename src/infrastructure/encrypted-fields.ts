import { DomainError } from "@kangmin/core/kernel/errors";
import {
  EncryptionError,
  type EncryptionPort
} from "@kangmin/core/kernel/encryption";

/**
 * 密文字段的库内表示与加解密映射。
 *
 * 每个健康正文字段在表中存为一个自包含的 JSON 载荷
 * `{"ciphertext","iv","authTag"}`（AES-GCM 解密需要随机 IV 与认证标签），
 * 表级 `encryption_key_version` 列单独记录密钥版本，同一行内所有
 * 加密字段共享该版本。
 *
 * 解密失败（密钥版本缺失、认证失败、密文格式损坏）一律映射为
 * `storage_unavailable`（retryable: false），绝不宽松降级为 null。
 */

export interface StoredEncryptedField {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function isStoredEncryptedField(
  value: unknown
): value is StoredEncryptedField {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.ciphertext === "string" &&
    typeof candidate.iv === "string" &&
    typeof candidate.authTag === "string"
  );
}

/** 加密单个非空字符串，返回自包含密文 JSON 与密钥版本。 */
export function encryptStoredField(
  encryption: EncryptionPort,
  plaintext: string
): { stored: string; keyVersion: string } {
  const payload = encryption.encrypt(plaintext);
  return {
    stored: JSON.stringify({
      ciphertext: payload.ciphertext,
      iv: payload.iv,
      authTag: payload.authTag
    }),
    keyVersion: payload.keyVersion
  };
}

/**
 * 加密一行中的若干可空字段：null 字段保持 NULL 不加密，
 * 所有非空字段使用同一密钥版本（同一行共享 encryption_key_version）。
 * 返回值保留元组形状，调用方按位置取 stored[0..n] 与输入一一对应。
 */
export function encryptOptionalFields<
  const T extends readonly (string | null)[]
>(
  encryption: EncryptionPort,
  values: T
): { stored: { [K in keyof T]: string | null }; keyVersion: string | null } {
  let keyVersion: string | null = null;
  const stored = values.map((value) => {
    if (value === null) {
      return null;
    }
    const result = encryptStoredField(encryption, value);
    keyVersion = result.keyVersion;
    return result.stored;
  }) as { [K in keyof T]: string | null };
  return { stored, keyVersion };
}

/**
 * 解密可空密文字段。stored 为 NULL 时返回 NULL；
 * 其余任何失败形态（缺密钥版本、JSON 损坏、认证失败、未知密钥版本）
 * 都抛 storage_unavailable（retryable: false）。
 */
export function decryptStoredField(
  encryption: EncryptionPort,
  stored: string | null,
  keyVersion: string | null,
  fieldLabel: string
): string | null {
  if (stored === null) {
    return null;
  }
  if (keyVersion === null) {
    throw new DomainError(
      "storage_unavailable",
      `${fieldLabel}密文缺少密钥版本，无法安全读取`,
      { retryable: false }
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(stored);
  } catch (error) {
    throw new DomainError(
      "storage_unavailable",
      `${fieldLabel}密文格式损坏，无法安全读取`,
      { retryable: false, cause: error }
    );
  }
  if (!isStoredEncryptedField(payload)) {
    throw new DomainError(
      "storage_unavailable",
      `${fieldLabel}密文格式损坏，无法安全读取`,
      { retryable: false }
    );
  }
  try {
    return encryption.decrypt({ ...payload, keyVersion });
  } catch (error) {
    if (error instanceof EncryptionError) {
      throw new DomainError(
        "storage_unavailable",
        `${fieldLabel}解密失败，无法安全读取`,
        { retryable: false, cause: error }
      );
    }
    throw error;
  }
}
