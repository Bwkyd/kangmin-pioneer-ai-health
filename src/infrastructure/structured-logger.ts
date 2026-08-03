/**
 * 结构化请求日志小工具：每个请求完成时向 stderr 写单行 JSON。
 *
 * 脱敏红线：只写固定字段（ts/level/requestId/method/path/status/
 * durationMs），绝不记录请求体、令牌、手机号、健康内容等敏感数据；
 * path 仅取 URL pathname，不含查询串。
 *
 * 限流超限等 429 以 warn 级别落一行（替代审计表写入，避免放大写入），
 * 5xx 记 error，其余记 info。
 */

export type StructuredLogLevel = "info" | "warn" | "error";

/** 请求完成时落日志的固定字段集（除此之外一律不记）。 */
export interface RequestLogEntry {
  ts: string;
  level: StructuredLogLevel;
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export type RequestLogger = (entry: RequestLogEntry) => void;

/** 状态码分级：5xx → error，429 → warn，其余 → info。 */
export function logLevelForStatus(status: number): StructuredLogLevel {
  if (status >= 500) {
    return "error";
  }
  if (status === 429) {
    return "warn";
  }
  return "info";
}

/** 默认写 stderr；测试可注入内存流捕获日志行。 */
export function createStructuredRequestLogger(
  stream: NodeJS.WritableStream = process.stderr
): RequestLogger {
  return (entry) => {
    stream.write(`${JSON.stringify(entry)}\n`);
  };
}
