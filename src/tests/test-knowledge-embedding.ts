import type { KnowledgeEmbeddingPort } from "../modules/agent/knowledge-ports.js";

/** 测试专用、无网络的稳定字符特征；只验证索引生命周期与排序契约。 */
export class TestKnowledgeEmbedding implements KnowledgeEmbeddingPort {
  readonly modelName = "test-knowledge-embedding-v1";

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = Array.from({ length: 64 }, () => 0);
      const compact = text.replace(/\s+/gu, "");
      const features = [
        ...Array.from(compact),
        ...Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) =>
          compact.slice(index, index + 2)
        )
      ];
      for (const feature of features) {
        let hash = 2166136261;
        for (const character of feature) {
          hash ^= character.codePointAt(0) ?? 0;
          hash = Math.imul(hash, 16777619);
        }
        const bucket = (hash >>> 0) % vector.length;
        vector[bucket] = (vector[bucket] ?? 0) + 1;
      }
      return vector;
    });
  }
}
