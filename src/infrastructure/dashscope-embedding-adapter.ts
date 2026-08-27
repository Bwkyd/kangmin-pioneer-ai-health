import { DomainError } from "@kangmin/core/kernel/errors";
import type { KnowledgeEmbeddingPort } from "@kangmin/core/intelligence/agent/knowledge-ports";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "text-embedding-v4";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BATCH_SIZE = 10;

interface EmbeddingResponse {
  data?: Array<{ index?: number; embedding?: unknown }>;
}

export interface DashscopeEmbeddingOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** DashScope OpenAI-compatible embeddings；不记录请求正文、响应或密钥。 */
export class DashscopeEmbeddingAdapter implements KnowledgeEmbeddingPort {
  readonly modelName: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DashscopeEmbeddingOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.modelName = options.model?.trim() || DEFAULT_MODEL;
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    } catch (error) {
      throw new DomainError("config_missing", "知识向量服务地址无效", { cause: error });
    }
    const loopback = baseUrl.hostname === "127.0.0.1" || baseUrl.hostname === "localhost";
    if ((baseUrl.protocol !== "https:" && !loopback) || baseUrl.username || baseUrl.password) {
      throw new DomainError("config_missing", "知识向量服务地址必须使用 HTTPS");
    }
    this.baseUrl = baseUrl.toString().replace(/\/$/u, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.apiKey === undefined) {
      throw new DomainError("provider_unavailable", "知识语义检索尚未配置向量服务");
    }
    const normalized = texts.map((text) => text.trim());
    if (normalized.some((text) => text === "")) {
      throw new DomainError("validation_failed", "知识向量输入不能为空");
    }
    const vectors: number[][] = [];
    for (let start = 0; start < normalized.length; start += MAX_BATCH_SIZE) {
      const batch = normalized.slice(start, start + MAX_BATCH_SIZE);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ model: this.modelName, input: batch }),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (error) {
        const timeout = error instanceof Error && error.name === "TimeoutError";
        throw new DomainError(timeout ? "provider_timeout" : "provider_unavailable", timeout
          ? "知识向量服务超时"
          : "知识向量服务暂时不可用", {
          retryable: true,
          cause: error
        });
      }
      if (!response.ok) {
        throw new DomainError("provider_unavailable", "知识向量服务返回失败", {
          retryable: response.status >= 500
        });
      }
      let payload: EmbeddingResponse;
      try {
        payload = (await response.json()) as EmbeddingResponse;
      } catch (error) {
        throw new DomainError("provider_unavailable", "知识向量服务响应格式无效", {
          cause: error
        });
      }
      if (!Array.isArray(payload.data) || payload.data.length !== batch.length) {
        throw new DomainError("provider_unavailable", "知识向量服务响应数量不一致");
      }
      const ordered = [...payload.data].sort(
        (left, right) => (left.index ?? 0) - (right.index ?? 0)
      );
      for (const [index, item] of ordered.entries()) {
        if (item.index !== index) {
          throw new DomainError("provider_unavailable", "知识向量服务响应序号无效");
        }
        if (
          !Array.isArray(item.embedding) ||
          item.embedding.length === 0 ||
          !item.embedding.every((value) => typeof value === "number" && Number.isFinite(value))
        ) {
          throw new DomainError("provider_unavailable", "知识向量服务返回非法向量");
        }
        vectors.push(item.embedding as number[]);
      }
    }
    const dimensions = vectors[0]?.length;
    if (dimensions === undefined || vectors.some((vector) => vector.length !== dimensions)) {
      throw new DomainError("provider_unavailable", "知识向量服务返回维度不一致");
    }
    return vectors;
  }
}
