import { cookies } from "next/headers";

export const ADMIN_COOKIE = "kangmin_admin_session";
const SESSION_SECONDS = 60 * 60 * 8;

type AdminEnv = {
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD_HASH?: string;
  ADMIN_SESSION_SECRET?: string;
};

async function config(): Promise<Required<AdminEnv>> {
  const { env } = await import("cloudflare:workers");
  const values = env as unknown as AdminEnv;
  if (!values.ADMIN_USERNAME || !values.ADMIN_PASSWORD_HASH || !values.ADMIN_SESSION_SECRET) {
    throw new Error("ADMIN_AUTH_NOT_CONFIGURED");
  }
  return values as Required<AdminEnv>;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function safeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function verifyAdminPassword(username: string, password: string) {
  const values = await config();
  if (username !== values.ADMIN_USERNAME) return false;
  const [iterationsText, saltText, expectedText] = values.ADMIN_PASSWORD_HASH.split(".");
  const iterations = Number(iterationsText);
  if (!Number.isSafeInteger(iterations) || iterations < 210_000 || !saltText || !expectedText) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const result = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: base64ToBytes(saltText), iterations }, key, 256);
  return safeEqual(new Uint8Array(result), base64ToBytes(expectedText));
}

async function sign(payload: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
}

export async function createAdminSession(username: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = btoa(JSON.stringify({ username, expiresAt }));
  return `${payload}.${await sign(payload, (await config()).ADMIN_SESSION_SECRET)}`;
}

export async function readAdminSession(raw?: string) {
  if (!raw) return null;
  try {
    const separator = raw.lastIndexOf(".");
    const payload = raw.slice(0, separator);
    const actual = base64ToBytes(raw.slice(separator + 1));
    const values = await config();
    const expected = base64ToBytes(await sign(payload, values.ADMIN_SESSION_SECRET));
    if (!safeEqual(actual, expected)) return null;
    const parsed = JSON.parse(atob(payload)) as { username: string; expiresAt: number };
    return parsed.username === values.ADMIN_USERNAME && parsed.expiresAt > Date.now() / 1000 ? parsed : null;
  } catch {
    return null;
  }
}

export async function requireAdmin() {
  const cookieStore = await cookies();
  const session = await readAdminSession(cookieStore.get(ADMIN_COOKIE)?.value);
  if (!session) throw new Error("ADMIN_UNAUTHORIZED");
  return session;
}

export const adminCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
  maxAge: SESSION_SECONDS,
};
