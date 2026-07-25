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
};

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
    async resolve() {
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

      // No phone provider exists in this repository yet. Production and staging
      // therefore fail closed until a verified-phone resolver replaces this one.
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
  const identity = await resolver.resolve(request);
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
