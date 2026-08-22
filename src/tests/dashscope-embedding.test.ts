import assert from "node:assert/strict";
import test from "node:test";

import { DashscopeEmbeddingAdapter } from "../infrastructure/dashscope-embedding-adapter.js";
import { DomainError } from "../kernel/errors.js";

test("向量适配器：未配置密钥时 fail-closed 且不发起请求", async () => {
  let calls = 0;
  const adapter = new DashscopeEmbeddingAdapter({
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ data: [] });
    }
  });
  await assert.rejects(
    () => adapter.embed(["鼻痒"]),
    (error: unknown) => error instanceof DomainError && error.code === "provider_unavailable"
  );
  assert.equal(calls, 0);
});

test("向量适配器：每批最多 10 条并按 index 恢复输入顺序", async () => {
  const batchSizes: number[] = [];
  const adapter = new DashscopeEmbeddingAdapter({
    apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      batchSizes.push(body.input.length);
      return Response.json({
        data: body.input.map((text, index) => ({
          index,
          embedding: [Number(text.slice(1)) + 1, 1]
        })).reverse()
      });
    }
  });
  const result = await adapter.embed(
    Array.from({ length: 11 }, (_, index) => `q${index}`)
  );
  assert.deepEqual(batchSizes, [10, 1]);
  assert.deepEqual(result[0], [1, 1]);
  assert.deepEqual(result[9], [10, 1]);
  assert.deepEqual(result[10], [11, 1]);
});

test("向量适配器：重复序号和上游错误不能伪装成成功或泄露响应内容", async () => {
  const duplicate = new DashscopeEmbeddingAdapter({
    apiKey: "test-key",
    fetchImpl: async () => Response.json({
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 0, embedding: [0, 1] }
      ]
    })
  });
  await assert.rejects(
    () => duplicate.embed(["甲", "乙"]),
    (error: unknown) => error instanceof DomainError && error.code === "provider_unavailable"
  );

  const marker = "upstream-private-response";
  const failed = new DashscopeEmbeddingAdapter({
    apiKey: "test-key",
    fetchImpl: async () => new Response(marker, { status: 500 })
  });
  await assert.rejects(
    () => failed.embed(["鼻痒"]),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "provider_unavailable");
      assert.doesNotMatch(String(error), new RegExp(marker, "u"));
      return true;
    }
  );
});

test("向量适配器：超时可区分，非本机 HTTP 端点不得携密钥请求", async () => {
  const timeout = new DashscopeEmbeddingAdapter({
    apiKey: "test-key",
    fetchImpl: async () => {
      const error = new Error("timeout");
      error.name = "TimeoutError";
      throw error;
    }
  });
  await assert.rejects(
    () => timeout.embed(["鼻痒"]),
    (error: unknown) => error instanceof DomainError && error.code === "provider_timeout"
  );
  assert.throws(
    () => new DashscopeEmbeddingAdapter({
      apiKey: "test-key",
      baseUrl: "http://embedding.example.test/v1"
    }),
    (error: unknown) => error instanceof DomainError && error.code === "config_missing"
  );
});

test("向量适配器：非法地址稳定返回配置错误", () => {
  assert.throws(
    () => new DashscopeEmbeddingAdapter({ apiKey: "test-key", baseUrl: "not a url" }),
    (error: unknown) => error instanceof DomainError && error.code === "config_missing"
  );
});
