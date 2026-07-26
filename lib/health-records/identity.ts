import { HealthRecordError } from "./domain.ts";

export type HealthIdentity = {
  userId: string;
  assurance: "verified_phone" | "synthetic";
};

export interface HealthIdentityResolver {
  resolve(request: Request): Promise<HealthIdentity | null>;
}

type IdentityEnv = {
  APP_ENV?: "local" | "integration" | "staging" | "production";
  HEALTH_IDENTITY_MODE?: string;
  HEALTH_SYNTHETIC_USER_ID?: string;
  HEALTH_IDENTITY_SESSION_SECRET?: string;
};

export const HEALTH_IDENTITY_COOKIE = "kangmin_health_session";

async function signSession(payload: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  let binary = "";
  signature.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

export async function createVerifiedPhoneSession(userId: string, secret: string, expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 30) {
  if (!/^usr_[A-Za-z0-9_-]{3,96}$/.test(userId)) throw new Error("INVALID_INTERNAL_USER_ID");
  const payload = btoa(JSON.stringify({ userId, expiresAt }));
  return `${payload}.${await signSession(payload, secret)}`;
}

function readCookie(request: Request, name: string) {
  return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

async function readVerifiedPhoneSession(request: Request, secret: string) {
  const raw = readCookie(request, HEALTH_IDENTITY_COOKIE);
  if (!raw) return null;
  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = raw.slice(0, separator);
  const expected = await signSession(payload, secret);
  if (raw.slice(separator + 1) !== expected) return null;
  try {
    const parsed = JSON.parse(atob(payload)) as { userId?: unknown; expiresAt?: unknown };
    return typeof parsed.userId === "string" && /^usr_[A-Za-z0-9_-]{3,96}$/.test(parsed.userId) && typeof parsed.expiresAt === "number" && parsed.expiresAt > Date.now()
      ? parsed.userId
      : null;
  } catch {
    return null;
  }
}

export function fixedHealthIdentity(userId: string): HealthIdentityResolver {
  return {
    async resolve() {
      return { userId, assurance: "synthetic" };
    },
  };
}

export function unauthenticatedHealthIdentity(): HealthIdentityResolver {
  return { async resolve() { return null; } };
}

export function createRuntimeHealthIdentityResolver(
  readEnv: () => Promise<IdentityEnv> = async () => {
    const { env } = await import("cloudflare:workers");
    return env as unknown as IdentityEnv;
  },
): HealthIdentityResolver {
  return {
    async resolve(request) {
      const values = await readEnv();
      const syntheticAllowed = values.APP_ENV === "local" || values.APP_ENV === "integration";
      if (
        syntheticAllowed &&
        values.HEALTH_IDENTITY_MODE === "synthetic" &&
        values.HEALTH_SYNTHETIC_USER_ID &&
        /^usr_test_[A-Za-z0-9_-]{3,80}$/.test(values.HEALTH_SYNTHETIC_USER_ID)
      ) {
        return { userId: values.HEALTH_SYNTHETIC_USER_ID, assurance: "synthetic" };
      }

      if (values.HEALTH_IDENTITY_MODE === "verified_phone" && values.HEALTH_IDENTITY_SESSION_SECRET) {
        const userId = await readVerifiedPhoneSession(request, values.HEALTH_IDENTITY_SESSION_SECRET);
        if (userId) return { userId, assurance: "verified_phone" };
      }

      // The phone provider must verify the phone upstream and issue this server-
      // signed session after mapping it to an internal userId. Raw phone numbers
      // never enter health-record requests or database ownership columns.
      return null;
    },
  };
}

export async function requireHealthIdentity(
  request: Request,
  resolver: HealthIdentityResolver,
) {
  if (request.headers.has("x-user-id")) {
    throw new HealthRecordError(
      400,
      "CLIENT_IDENTITY_FORBIDDEN",
      "不得通过 x-user-id 指定健康数据所属用户",
    );
  }
  let identity: HealthIdentity | null;
  try {
    identity = await resolver.resolve(request);
  } catch {
    throw new HealthRecordError(
      401,
      "AUTHENTICATION_REQUIRED",
      "保存或查看健康历史前需要完成服务端身份认证",
    );
  }
  if (!identity) {
    throw new HealthRecordError(
      401,
      "AUTHENTICATION_REQUIRED",
      "保存或查看健康历史前需要完成服务端身份认证",
    );
  }
  if (!/^usr_[A-Za-z0-9_-]{3,96}$/.test(identity.userId)) {
    throw new HealthRecordError(500, "INTERNAL_ERROR", "身份服务返回了无效的内部用户标识");
  }
  return identity;
}
