/**
 * 远程命令客户端组合根。
 *
 * CLI 入口只依赖该装配边界，不直接创建网络基础设施适配器。
 */
import {
  RemoteCommandClient,
  remoteTimeout,
  type CommandAudience
} from "../infrastructure/remote-command-client.js";
import { DomainError } from "../kernel/errors.js";

export function remoteCommandBaseUrl(
  environment: NodeJS.ProcessEnv
): string | undefined {
  const value = environment.KANGMIN_API_BASE_URL?.trim();
  return value === "" ? undefined : value;
}

/**
 * staging/production 的远程命令通道必须走 HTTPS；明文 HTTP 可能泄露
 * 患者/管理员令牌，这里 fail-closed，不做静默降级。
 */
function assertSecureTransport(environment: NodeJS.ProcessEnv): void {
  const baseUrl = remoteCommandBaseUrl(environment);
  if (baseUrl === undefined) {
    return;
  }
  const appEnvironment = environment.KANGMIN_APP_ENV;
  if (
    (appEnvironment === "staging" || appEnvironment === "production") &&
    !baseUrl.toLowerCase().startsWith("https://")
  ) {
    throw new DomainError(
      "config_missing",
      "staging/production 的 KANGMIN_API_BASE_URL 必须使用 https"
    );
  }
}

export function createRemoteCommandClient(
  environment: NodeJS.ProcessEnv,
  audience: CommandAudience,
  token: string | undefined
): RemoteCommandClient {
  assertSecureTransport(environment);
  return new RemoteCommandClient({
    baseUrl: remoteCommandBaseUrl(environment) ?? "",
    audience,
    token,
    timeoutMs: remoteTimeout(environment)
  });
}
