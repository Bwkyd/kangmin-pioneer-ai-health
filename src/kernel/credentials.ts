import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";

/**
 * 密码凭据共享原语（评审 A P1-1：患者端与管理端曾各写一份不兼容实现）。
 *
 * 哈希格式：`scrypt:<N>:<r>:<p>:<salt-hex>:<key-hex>`——参数存于值内，
 * 便于未来升级参数后校验旧哈希。管理端旧格式 `scrypt$salt$hash` 不在
 * 本格式内，verifyPassword 返回 false（开发会话占位密码同理）。
 */

const scryptAsync = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
) => Promise<Buffer>;

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_LENGTH = 16;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const key = (await scryptAsync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  })) as Buffer;
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("hex"),
    key.toString("hex")
  ].join(":");
}

/** 校验密码；非本格式（旧格式/占位符）一律不通过，防枚举统一由调用方处理。 */
export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  const salt = Buffer.from(parts[4] ?? "", "hex");
  const expected = Buffer.from(parts[5] ?? "", "hex");
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }
  const derived = (await scryptAsync(password, salt, expected.length, {
    N: n,
    r,
    p
  })) as Buffer;
  return (
    derived.length === expected.length &&
    timingSafeEqual(derived, expected)
  );
}
