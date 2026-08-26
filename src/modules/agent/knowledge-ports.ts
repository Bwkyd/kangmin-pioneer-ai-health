import { DomainError } from "../../kernel/errors.js";

/** 受限的知识向量生成端口：只负责把文本转换为同一模型空间中的向量。 */
export interface KnowledgeEmbeddingPort {
  readonly modelName: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface KnowledgeSource {
  knowledgeId: string;
  name: string;
  category: string | null;
  source: string | null;
  chunkIndex: number;
  text: string;
  score: number;
}

export interface KnowledgeRetrievalPort {
  searchEnabled(query: string, limit: number): Promise<KnowledgeSource[]>;
  /** 运营预检专用：只检索指定资料，不改变或绕过患者全库的 enabled 门禁。 */
  searchOne?(query: string, knowledgeId: string, limit: number): Promise<KnowledgeSource[]>;
}

export interface KnowledgeAnswerPort {
  answer(question: string, sources: readonly KnowledgeSource[]): Promise<string | null>;
}

export interface EncodedKnowledgeEmbeddings {
  modelName: string;
  dimensions: number;
  vectors: Buffer[];
}

const KNOWLEDGE_LEXICAL_WEIGHT = 0.15;
const MAX_PRIMARY_CHUNKS_PER_KNOWLEDGE = 2;

function bigrams(value: string): Set<string> {
  const normalized = value.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
  const values = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    values.add(normalized.slice(index, index + 2));
  }
  return values;
}

/**
 * 语义分数叠加小权重二元字重合率，用于找回精确术语。它只排序已启用
 * 知识，不判断资料可信度、用途或医学授权。
 */
export function hybridKnowledgeScore(
  semanticScore: number,
  query: string,
  text: string
): number {
  const queryTerms = bigrams(query);
  if (queryTerms.size === 0) return semanticScore;
  const textTerms = bigrams(text);
  let matched = 0;
  for (const term of queryTerms) {
    if (textTerms.has(term)) matched += 1;
  }
  return (
    semanticScore + KNOWLEDGE_LEXICAL_WEIGHT * matched / queryTerms.size
  ) / (1 + KNOWLEDGE_LEXICAL_WEIGHT);
}

/**
 * 先按混合分数排序，再优先让单份资料最多占两个位置；语料不足时回填
 * 被延后的同源切块，保证 limit 语义不变。这样避免长文垄断 Top-K。
 */
export function selectKnowledgeHits(
  sources: readonly KnowledgeSource[],
  limit: number
): KnowledgeSource[] {
  const boundedLimit = Math.max(0, limit);
  const sorted = [...sources].sort((left, right) =>
    right.score - left.score ||
    left.knowledgeId.localeCompare(right.knowledgeId) ||
    left.chunkIndex - right.chunkIndex
  );
  const selected: KnowledgeSource[] = [];
  const deferred: KnowledgeSource[] = [];
  const counts = new Map<string, number>();
  for (const source of sorted) {
    const count = counts.get(source.knowledgeId) ?? 0;
    if (count < MAX_PRIMARY_CHUNKS_PER_KNOWLEDGE && selected.length < boundedLimit) {
      selected.push(source);
      counts.set(source.knowledgeId, count + 1);
    } else {
      deferred.push(source);
    }
  }
  if (selected.length < boundedLimit) {
    selected.push(...deferred.slice(0, boundedLimit - selected.length));
  }
  return selected;
}

/** 统一索引与回填的批次校验，避免两条路径产生不同向量语义。 */
export async function embedKnowledgeTexts(
  port: KnowledgeEmbeddingPort,
  texts: readonly string[]
): Promise<EncodedKnowledgeEmbeddings> {
  if (texts.length === 0) {
    throw new DomainError("validation_failed", "知识没有可索引的正文分块");
  }
  const values = await port.embed(texts);
  if (values.length !== texts.length) {
    throw new DomainError("provider_unavailable", "知识向量服务响应数量不一致");
  }
  const vectors = values.map(encodeNormalizedEmbedding);
  const first = vectors[0];
  if (first === undefined) {
    throw new DomainError("provider_unavailable", "知识向量服务没有返回向量");
  }
  const dimensions = normalizedEmbeddingDimensions(first);
  if (vectors.some((vector) => normalizedEmbeddingDimensions(vector) !== dimensions)) {
    throw new DomainError("provider_unavailable", "知识向量服务返回维度不一致");
  }
  return { modelName: port.modelName, dimensions, vectors };
}

/**
 * 向量按单位长度归一化后，以显式 little-endian Float32 编码。
 * SQLite BLOB 与 PostgreSQL BYTEA 共用同一字节语义，检索时只需点积。
 */
export function encodeNormalizedEmbedding(values: readonly number[]): Buffer {
  if (values.length === 0) {
    throw new DomainError("validation_failed", "知识向量不能为空");
  }
  let squaredNorm = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new DomainError("provider_unavailable", "知识向量包含非法数值");
    }
    squaredNorm += value * value;
  }
  if (!Number.isFinite(squaredNorm) || squaredNorm <= 0) {
    throw new DomainError("provider_unavailable", "知识向量无法归一化");
  }
  const norm = Math.sqrt(squaredNorm);
  const encoded = Buffer.allocUnsafe(values.length * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < values.length; index += 1) {
    encoded.writeFloatLE((values[index] ?? 0) / norm, index * Float32Array.BYTES_PER_ELEMENT);
  }
  return encoded;
}

export function normalizedEmbeddingDimensions(bytes: Uint8Array): number {
  if (bytes.byteLength === 0 || bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new DomainError("storage_unavailable", "知识向量存储格式无效");
  }
  return bytes.byteLength / Float32Array.BYTES_PER_ELEMENT;
}

/** 两个已经归一化、维度相同的向量的余弦相似度。 */
export function normalizedEmbeddingScore(
  query: Uint8Array,
  candidate: Uint8Array
): number {
  if (query.byteLength !== candidate.byteLength) {
    throw new DomainError("storage_unavailable", "知识向量维度不一致");
  }
  normalizedEmbeddingDimensions(query);
  const queryBuffer = Buffer.from(query.buffer, query.byteOffset, query.byteLength);
  const candidateBuffer = Buffer.from(
    candidate.buffer,
    candidate.byteOffset,
    candidate.byteLength
  );
  let score = 0;
  for (let offset = 0; offset < queryBuffer.length; offset += Float32Array.BYTES_PER_ELEMENT) {
    const left = queryBuffer.readFloatLE(offset);
    const right = candidateBuffer.readFloatLE(offset);
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      throw new DomainError("storage_unavailable", "知识向量存储包含非法数值");
    }
    score += left * right;
  }
  if (!Number.isFinite(score)) {
    throw new DomainError("storage_unavailable", "知识向量相似度无法计算");
  }
  return score;
}
