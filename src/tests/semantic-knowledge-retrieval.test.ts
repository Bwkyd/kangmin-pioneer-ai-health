import assert from "node:assert/strict";
import test from "node:test";

import { KangminDatabase } from "@kangmin/database/sqlite/database";
import { SqliteKnowledgeRetrieval } from "@kangmin/database/sqlite/knowledge-retrieval";
import { SqliteAgentAdminRepository } from "@kangmin/database/sqlite/agent-admin-repository";
import { PlaintextEncryption } from "../infrastructure/aes-gcm-encryption.js";
import { DomainError } from "@kangmin/core/kernel/errors";
import {
  encodeNormalizedEmbedding,
  selectKnowledgeHits,
  type KnowledgeSource,
  type KnowledgeEmbeddingPort
} from "@kangmin/core/intelligence/agent/knowledge-ports";

test("Top-K 优先保留来源多样性，语料不足时仍回填同源切块", () => {
  const source = (knowledgeId: string, chunkIndex: number, score: number): KnowledgeSource => ({
    knowledgeId,
    name: knowledgeId,
    category: null,
    source: null,
    chunkIndex,
    text: `${knowledgeId}-${chunkIndex}`,
    score
  });
  const many = [
    source("a", 0, 1), source("a", 1, 0.9), source("a", 2, 0.8),
    source("b", 0, 0.7)
  ];
  assert.deepEqual(
    selectKnowledgeHits(many, 3).map((item) => `${item.knowledgeId}-${item.chunkIndex}`),
    ["a-0", "a-1", "b-0"]
  );
  assert.deepEqual(
    selectKnowledgeHits(many.slice(0, 3), 3).map((item) => item.chunkIndex),
    [0, 1, 2]
  );
});

class ControlledEmbedding implements KnowledgeEmbeddingPort {
  constructor(readonly modelName = "controlled-semantic-v1") {}
  calls = 0;

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map((text) => {
      if (/鼻痒|喷嚏|换种说法/u.test(text)) return [1, 0, 0];
      if (/花粉|过敏原/u.test(text)) return [0, 1, 0];
      return [0, 0, 1];
    });
  }
}

function addKnowledge(
  database: KangminDatabase,
  input: {
    id: string;
    name: string;
    category: string;
    source: string;
    status: "enabled" | "disabled";
    text: string;
  }
): void {
  database.connection.prepare(`
    INSERT INTO agent_knowledge_items(
      id, name, category, source, description, source_media_id, size_bytes,
      mime_type, sha256, status, parse_error, chunk_count,
      created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, 1, 'text/markdown', NULL, ?, NULL, 1, NULL, ?, ?)
  `).run(input.id, input.name, input.category, input.source, input.status, "2026-08-22T00:00:00.000Z", "2026-08-22T00:00:00.000Z");
  database.connection.prepare(`
    INSERT INTO agent_knowledge_chunks(knowledge_id, chunk_index, chunk_text)
    VALUES (?, 0, ?)
  `).run(input.id, input.text);
}

test("语义检索按余弦排序，返回来源与分类，并排除停用知识", async () => {
  const database = new KangminDatabase(":memory:");
  const embeddings = new ControlledEmbedding();
  try {
    addKnowledge(database, {
      id: "kno-sneeze",
      name: "鼻部症状说明",
      category: "症状科普",
      source: "测试来源甲",
      status: "enabled",
      text: "反复喷嚏和鼻痒属于常见鼻部症状。"
    });
    addKnowledge(database, {
      id: "kno-pollen",
      name: "诱因管理",
      category: "日常护理",
      source: "测试来源乙",
      status: "enabled",
      text: "花粉季应注意减少接触过敏原。"
    });
    addKnowledge(database, {
      id: "kno-disabled",
      name: "已停用旧资料",
      category: "历史资料",
      source: "测试来源丙",
      status: "disabled",
      text: "鼻痒和喷嚏的旧说明。"
    });
    const repository = new SqliteAgentAdminRepository(database, new PlaintextEncryption());
    for (const [id, vector] of [
      ["kno-sneeze", [1, 0, 0]],
      ["kno-pollen", [0, 1, 0]],
      ["kno-disabled", [1, 0, 0]]
    ] as const) {
      const encoded = encodeNormalizedEmbedding(vector);
      await repository.replaceKnowledgeEmbeddings(
        id,
        embeddings.modelName,
        3,
        [{ chunkIndex: 0, embedding: encoded }],
        "2026-08-22T01:00:00.000Z"
      );
    }

    const hits = await new SqliteKnowledgeRetrieval(database, embeddings)
      .searchEnabled("换种说法：鼻子发痒还老打喷嚏", 3);
    assert.deepEqual(hits.map((hit) => hit.knowledgeId), ["kno-sneeze", "kno-pollen"]);
    assert.equal(hits[0]?.category, "症状科普");
    assert.equal(hits[0]?.source, "测试来源甲");
    assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));
    assert.ok(!hits.some((hit) => hit.knowledgeId === "kno-disabled"));
  } finally {
    database.close();
  }
});

test("任一启用切块缺少当前模型向量时明确失败，且不浪费查询向量调用", async () => {
  const database = new KangminDatabase(":memory:");
  const embeddings = new ControlledEmbedding();
  try {
    addKnowledge(database, {
      id: "kno-missing",
      name: "待回填资料",
      category: "症状科普",
      source: "测试来源",
      status: "enabled",
      text: "鼻痒和喷嚏。"
    });
    await assert.rejects(
      () => new SqliteKnowledgeRetrieval(database, embeddings).searchEnabled("鼻痒", 3),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, "capability_unavailable");
        assert.match(error.message, /重新建立索引/u);
        return true;
      }
    );
    assert.equal(embeddings.calls, 0);
  } finally {
    database.close();
  }
});

test("模型名称变化后旧向量不会被静默复用", async () => {
  const database = new KangminDatabase(":memory:");
  const oldEmbedding = new ControlledEmbedding();
  try {
    addKnowledge(database, {
      id: "kno-model",
      name: "模型版本测试",
      category: "测试",
      source: "测试来源",
      status: "enabled",
      text: "鼻痒和喷嚏。"
    });
    const repository = new SqliteAgentAdminRepository(database, new PlaintextEncryption());
    await repository.replaceKnowledgeEmbeddings(
      "kno-model",
      oldEmbedding.modelName,
      3,
      [{ chunkIndex: 0, embedding: encodeNormalizedEmbedding([1, 0, 0]) }],
      "2026-08-22T01:00:00.000Z"
    );
    const changedEmbedding = new ControlledEmbedding("controlled-semantic-v2");
    await assert.rejects(
      () => new SqliteKnowledgeRetrieval(database, changedEmbedding).searchEnabled("鼻痒", 3),
      (error: unknown) => error instanceof DomainError && error.code === "capability_unavailable"
    );
  } finally {
    database.close();
  }
});

test("向量替换中途失败时回滚，旧索引仍可检索", async () => {
  const database = new KangminDatabase(":memory:");
  const embeddings = new ControlledEmbedding();
  try {
    addKnowledge(database, {
      id: "kno-atomic",
      name: "原子替换测试",
      category: "测试",
      source: "测试来源",
      status: "enabled",
      text: "鼻痒和喷嚏。"
    });
    const repository = new SqliteAgentAdminRepository(database, new PlaintextEncryption());
    await repository.replaceKnowledgeEmbeddings(
      "kno-atomic",
      embeddings.modelName,
      3,
      [{ chunkIndex: 0, embedding: encodeNormalizedEmbedding([1, 0, 0]) }],
      "2026-08-22T01:00:00.000Z"
    );
    await assert.rejects(() => repository.replaceKnowledgeEmbeddings(
      "kno-atomic",
      embeddings.modelName,
      3,
      [{ chunkIndex: 99, embedding: encodeNormalizedEmbedding([0, 1, 0]) }],
      "2026-08-22T02:00:00.000Z"
    ));
    const hits = await new SqliteKnowledgeRetrieval(database, embeddings)
      .searchEnabled("鼻痒", 1);
    assert.equal(hits[0]?.knowledgeId, "kno-atomic");
    assert.ok((hits[0]?.score ?? 0) > 0.99);
  } finally {
    database.close();
  }
});

test("小权重字面重合能找回精确医学术语，不以字面匹配替代语义向量", async () => {
  const database = new KangminDatabase(":memory:");
  const embeddings: KnowledgeEmbeddingPort = {
    modelName: "hybrid-test-v1",
    async embed(): Promise<number[][]> { return [[1, 0]]; }
  };
  try {
    addKnowledge(database, {
      id: "kno-semantic",
      name: "相邻治疗章节",
      category: "测试",
      source: "测试来源",
      status: "enabled",
      text: "治疗方案包括多种中医适宜技术。"
    });
    addKnowledge(database, {
      id: "kno-exact",
      name: "西医药物章节",
      category: "测试",
      source: "测试来源",
      status: "enabled",
      text: "鼻用糖皮质激素属于一线药物治疗。"
    });
    const repository = new SqliteAgentAdminRepository(database, new PlaintextEncryption());
    await repository.replaceKnowledgeEmbeddings(
      "kno-semantic", embeddings.modelName, 2,
      [{ chunkIndex: 0, embedding: encodeNormalizedEmbedding([1, 0]) }],
      "2026-08-22T01:00:00.000Z"
    );
    await repository.replaceKnowledgeEmbeddings(
      "kno-exact", embeddings.modelName, 2,
      [{ chunkIndex: 0, embedding: encodeNormalizedEmbedding([0.995, 0.1]) }],
      "2026-08-22T01:00:00.000Z"
    );
    const hits = await new SqliteKnowledgeRetrieval(database, embeddings)
      .searchEnabled("鼻用糖皮质激素属于什么治疗", 2);
    assert.equal(hits[0]?.knowledgeId, "kno-exact");
    assert.ok((hits[0]?.score ?? 0) < 1.2);
  } finally {
    database.close();
  }
});
