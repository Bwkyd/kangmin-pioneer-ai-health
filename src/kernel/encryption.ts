/**
 * 健康正文认证加密端口。
 *
 * 数据库设计 §7：健康正文、输入快照、候选、解释和反馈原因使用带密钥版本的
 * 认证加密；密钥只在 Secret，普通日志不得包含密文之外的任何内容。
 *
 * 领域层只依赖本端口，不依赖任何具体加密算法。
 */

/** 一次加密的结果：密文与解密所需的认证元数据。 */
export interface EncryptedPayload {
  /** base64 编码的密文（不含 IV 与认证标签）。 */
  ciphertext: string;
  /** base64 编码的初始化向量。 */
  iv: string;
  /** base64 编码的认证标签（GCM tag）。 */
  authTag: string;
  /** 使用的密钥版本，解密时按版本查找历史密钥。 */
  keyVersion: string;
}

export interface EncryptionPort {
  encrypt(plaintext: string): EncryptedPayload;
  decrypt(payload: EncryptedPayload): string;
}

/** 解密失败：密钥版本缺失或认证失败，均视为不可恢复的数据错误。 */
export class EncryptionError extends Error {
  constructor(
    message: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "EncryptionError";
  }
}
