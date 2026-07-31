import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdminApplication } from "../app/admin-composition-root.js";
import type { CommandResult } from "../kernel/result.js";
import type { KnowledgeItem, AgentPlan, ModelConfigView } from "../modules/agent-admin/contracts.js";

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

async function fixture(): Promise<{
  app: ReturnType<typeof createAdminApplication>;
  mediaDirectory: string;
  token: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-admin-agent-"));
  const databasePath = join(directory, "agent.sqlite");
  const mediaDirectory = join(directory, "admin-media");
  mkdirSync(mediaDirectory, { recursive: true });
  const app = createAdminApplication(databasePath, { mediaDirectory });
  const session = await app.sessions.createDevelopmentSession("owner-agent");
  return { app, mediaDirectory, token: session.token };
}

test("知识状态机：add→index→enable→search-test→disable", async () => {
  const { app, mediaDirectory, token } = await fixture();
  try {
    const file = join(mediaDirectory, "鼻炎护理知识.md");
    writeFileSync(
      file,
      "# 换季鼻塞护理\n\n换季期间鼻塞常见，可以保持室内湿度并清洗鼻腔。\n\n避免接触尘螨和花粉等过敏原。"
    );

    const added = dataOf<KnowledgeItem>(
      await app.execute({ command: "agent knowledge add", adminToken: token, input: { file } })
    );
    assert.equal(added.status, "processing");
    assert.ok(added.chunkCount >= 1);

    // 未建立索引不能启用
    const enableBeforeIndex = await app.execute({
      command: "agent knowledge enable",
      adminToken: token,
      input: { id: added.id, yes: true }
    });
    assert.equal(enableBeforeIndex.ok, false);
    if (!enableBeforeIndex.ok) assert.equal(enableBeforeIndex.error.code, "validation_failed");

    const indexed = dataOf<KnowledgeItem>(
      await app.execute({ command: "agent knowledge index", adminToken: token, input: { id: added.id } })
    );
    assert.equal(indexed.status, "indexed");

    // 启用需要 --yes
    const noConfirm = await app.execute({
      command: "agent knowledge enable",
      adminToken: token,
      input: { id: added.id }
    });
    assert.equal(noConfirm.ok, false);
    if (!noConfirm.ok) assert.equal(noConfirm.error.code, "confirmation_required");

    const enabled = dataOf<KnowledgeItem>(
      await app.execute({
        command: "agent knowledge enable",
        adminToken: token,
        input: { id: added.id, yes: true }
      })
    );
    assert.equal(enabled.status, "enabled");

    const hits = dataOf<{ items: Array<{ knowledgeId: string; snippet: string }> }>(
      await app.execute({
        command: "agent knowledge search-test",
        adminToken: token,
        input: { query: "鼻塞" }
      })
    );
    assert.equal(hits.items.length, 1);
    assert.equal(hits.items[0]?.knowledgeId, added.id);
    assert.match(hits.items[0]?.snippet ?? "", /鼻塞/u);

    const disabled = dataOf<KnowledgeItem>(
      await app.execute({
        command: "agent knowledge disable",
        adminToken: token,
        input: { id: added.id, yes: true }
      })
    );
    assert.equal(disabled.status, "disabled");

    // 停用后检索不再命中（未启用知识不能被 Agent 检索）
    const noHits = dataOf<{ items: unknown[] }>(
      await app.execute({
        command: "agent knowledge search-test",
        adminToken: token,
        input: { query: "鼻塞" }
      })
    );
    assert.equal(noHits.items.length, 0);
  } finally {
    app.close();
  }
});

test("PDF 知识如实标记解析失败，不伪装成功", async () => {
  const { app, mediaDirectory, token } = await fixture();
  try {
    const file = join(mediaDirectory, "参考文档.pdf");
    writeFileSync(file, "%PDF-1.4 fake");

    const added = dataOf<KnowledgeItem>(
      await app.execute({ command: "agent knowledge add", adminToken: token, input: { file } })
    );
    assert.equal(added.status, "index_failed");
    assert.ok(added.parseError !== null);
    assert.equal(added.chunkCount, 0);

    const indexAttempt = await app.execute({
      command: "agent knowledge index",
      adminToken: token,
      input: { id: added.id }
    });
    assert.equal(indexAttempt.ok, false);
    if (!indexAttempt.ok) assert.equal(indexAttempt.error.code, "validation_failed");
  } finally {
    app.close();
  }
});

test("方案：固定证型校验、启用前完整性校验、证型映射", async () => {
  const { app, token } = await fixture();
  try {
    // 客户不能创建证型：不存在的证型直接拒绝
    const badSyndrome = await app.execute({
      command: "agent plan create",
      adminToken: token,
      input: { name: "自创证型方案", syndrome: "自创证型" }
    });
    assert.equal(badSyndrome.ok, false);
    if (!badSyndrome.ok) assert.equal(badSyndrome.error.code, "validation_failed");

    const plan = dataOf<AgentPlan>(
      await app.execute({
        command: "agent plan create",
        adminToken: token,
        input: { name: "肺气虚寒调理方案", syndrome: "feiqi-xuhan" }
      })
    );
    assert.equal(plan.status, "draft");

    // 缺步骤/风险/禁忌不能启用
    const incomplete = await app.execute({
      command: "agent plan enable",
      adminToken: token,
      input: { id: plan.id, expectedRevision: 1, yes: true }
    });
    assert.equal(incomplete.ok, false);
    if (!incomplete.ok) assert.equal(incomplete.error.code, "validation_failed");

    const updated = dataOf<AgentPlan>(
      await app.execute({
        command: "agent plan update",
        adminToken: token,
        input: {
          id: plan.id,
          expectedRevision: 1,
          method: "温和艾灸与日常护理",
          steps: ["清洗鼻腔", "按揉迎香穴"],
          risks: "皮肤敏感者慎用艾灸",
          precautions: "孕妇请咨询医生",
          contraindications: "急性发作期禁止自行调理"
        }
      })
    );
    assert.equal(updated.revision, 2);

    const enabled = dataOf<AgentPlan>(
      await app.execute({
        command: "agent plan enable",
        adminToken: token,
        input: { id: plan.id, expectedRevision: 2, yes: true }
      })
    );
    assert.equal(enabled.status, "enabled");

    const mappings = dataOf<{
      items: Array<{ syndromeId: string; syndromeName: string; hasEnabledPlan: boolean }>;
    }>(await app.execute({ command: "agent plan mappings", adminToken: token }));
    const feiqi = mappings.items.find((item) => item.syndromeId === "feiqi-xuhan");
    assert.ok(feiqi !== undefined);
    assert.equal(feiqi.hasEnabledPlan, true);

    const disabled = dataOf<AgentPlan>(
      await app.execute({
        command: "agent plan disable",
        adminToken: token,
        input: { id: plan.id, expectedRevision: 3, yes: true }
      })
    );
    assert.equal(disabled.status, "disabled");
  } finally {
    app.close();
  }
});

test("方案关联视频校验：不存在或未发布的视频不能启用", async () => {
  const { app, mediaDirectory, token } = await fixture();
  try {
    // 不存在或未发布的视频引用在创建/更新时即被拒绝
    const missingVideo = await app.execute({
      command: "agent plan create",
      adminToken: token,
      input: {
        name: "关联视频方案",
        syndrome: "pixu-weiruo",
        method: "日常护理",
        steps: ["步骤一"],
        risks: "风险提示",
        precautions: "注意事项",
        contraindications: "禁忌",
        videoResourceId: "vid_not_exist"
      }
    });
    assert.equal(missingVideo.ok, false);
    if (!missingVideo.ok) assert.equal(missingVideo.error.code, "validation_failed");

    // 草稿视频可以关联，但启用被拒绝（未发布）
    const video = dataOf<{ id: string }>(
      await app.execute({
        command: "content video create",
        adminToken: token,
        input: { title: "未发布视频", category: "居家护理", idempotencyKey: "plan-video-1" }
      })
    );
    const plan = dataOf<AgentPlan>(
      await app.execute({
        command: "agent plan create",
        adminToken: token,
        input: {
          name: "关联视频方案",
          syndrome: "pixu-weiruo",
          method: "日常护理",
          steps: ["步骤一"],
          risks: "风险提示",
          precautions: "注意事项",
          contraindications: "禁忌",
          videoResourceId: video.id
        }
      })
    );
    const draftVideo = await app.execute({
      command: "agent plan enable",
      adminToken: token,
      input: { id: plan.id, expectedRevision: 1, yes: true }
    });
    assert.equal(draftVideo.ok, false);
    if (!draftVideo.ok) assert.equal(draftVideo.error.code, "validation_failed");

    // 更新为不存在的视频引用也被拒绝
    const badUpdate = await app.execute({
      command: "agent plan update",
      adminToken: token,
      input: { id: plan.id, expectedRevision: 1, videoResourceId: "vid_still_missing" }
    });
    assert.equal(badUpdate.ok, false);
    if (!badUpdate.ok) assert.equal(badUpdate.error.code, "validation_failed");

    // 已发布视频可通过启用校验
    const mediaFile = join(mediaDirectory, "plan-video.mp4");
    writeFileSync(mediaFile, "video-bytes");
    const media = dataOf<{ id: string }>(
      await app.execute({
        command: "content media upload",
        adminToken: token,
        input: { file: mediaFile }
      })
    );
    dataOf(
      await app.execute({
        command: "content video update",
        adminToken: token,
        input: {
          id: video.id,
          expectedRevision: 1,
          summary: "视频简介",
          body: "视频正文简介。",
          source: "来源",
          mediaId: media.id
        }
      })
    );
    dataOf(
      await app.execute({
        command: "content video publish",
        adminToken: token,
        input: { id: video.id, expectedRevision: 2, yes: true }
      })
    );
    const enabled = dataOf<AgentPlan>(
      await app.execute({
        command: "agent plan enable",
        adminToken: token,
        input: { id: plan.id, expectedRevision: 1, yes: true }
      })
    );
    assert.equal(enabled.status, "enabled");
  } finally {
    app.close();
  }
});

test("模型设置：不显示完整 API Key；未配置时测试如实报错；模拟测试契约", async () => {
  const { app, token } = await fixture();
  try {
    const initial = dataOf<ModelConfigView>(
      await app.execute({ command: "agent model show", adminToken: token })
    );
    assert.equal(initial.apiKeyMasked, null);
    assert.equal(initial.modelName, "");

    const noModel = await app.execute({ command: "agent model test", adminToken: token });
    assert.equal(noModel.ok, false);
    if (!noModel.ok) assert.equal(noModel.error.code, "config_missing");

    const updated = dataOf<ModelConfigView>(
      await app.execute({
        command: "agent model update",
        adminToken: token,
        input: {
          modelName: "gpt-4o-mini",
          provider: "openai-compatible",
          timeout: 60,
          maxOutput: 2048,
          apiKey: "sk-abcdef1234567890"
        }
      })
    );
    assert.equal(updated.modelName, "gpt-4o-mini");
    assert.equal(updated.apiKeyMasked, "sk-a****7890");
    assert.ok(!updated.apiKeyMasked.includes("abcdef1234"));

    // 已配置模型但无提供方适配器 → capability_unavailable（如实）
    const modelTest = await app.execute({ command: "agent model test", adminToken: token });
    assert.equal(modelTest.ok, false);
    if (!modelTest.ok) assert.equal(modelTest.error.code, "capability_unavailable");

    // 模拟测试链路：规则内核未集成 → capability_unavailable
    const testRun = await app.execute({ command: "agent test run", adminToken: token });
    assert.equal(testRun.ok, false);
    if (!testRun.ok) assert.equal(testRun.error.code, "capability_unavailable");

    const missingCase = await app.execute({
      command: "agent test case",
      adminToken: token,
      input: { id: "case_nope" }
    });
    assert.equal(missingCase.ok, false);
    if (!missingCase.ok) assert.equal(missingCase.error.code, "resource_not_found");

    // agent status 聚合字段
    const status = dataOf<{
      model: { configured: boolean };
      enabledKnowledgeCount: number;
      indexFailedCount: number;
      enabledPlanCount: number;
      syndromesWithoutEnabledPlan: Array<{ id: string }>;
      lastTestCaseStatus: unknown;
    }>(await app.execute({ command: "agent status", adminToken: token }));
    assert.equal(status.model.configured, true);
    assert.equal(status.enabledKnowledgeCount, 0);
    assert.ok(status.syndromesWithoutEnabledPlan.length >= 5);
  } finally {
    app.close();
  }
});
