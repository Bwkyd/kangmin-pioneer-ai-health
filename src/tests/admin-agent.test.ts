import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// 测试进程以本地开发模式启动：组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为
// PlaintextEncryption（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdminApplication } from "../app/admin-composition-root.js";
import { createApplication } from "../app/composition-root.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { PlaintextEncryption } from "../infrastructure/aes-gcm-encryption.js";
import { LocalFilesystemObjectStorage } from "../infrastructure/local-filesystem-object-storage.js";
import { SqliteAgentAdminRepository } from "../infrastructure/sqlite-agent-admin-repository.js";
import { BuiltinSyndromeRegistry } from "../infrastructure/syndrome-registry.js";
import { DomainError } from "../kernel/errors.js";
import type { CommandResult } from "../kernel/result.js";
import { AgentAdminService } from "../modules/agent-admin/agent-admin-service.js";
import type { AgentAdminRepository } from "../modules/agent-admin/agent-admin-ports.js";
import type { KnowledgeItem, KnowledgeFolder, AgentPlan, ModelConfigView } from "../modules/agent-admin/contracts.js";
import { TestKnowledgeEmbedding } from "./test-knowledge-embedding.js";

function dataOf<T>(result: CommandResult): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

/** 读取审计行（外部评审 P1-3：知识/方案启停必须有审计）。 */
function auditRowsOf(
  databasePath: string,
  action: string
): Array<{ actor_id: string; entity_id: string; entity_revision: number | null }> {
  const database = new KangminDatabase(databasePath);
  try {
    return database.connection
      .prepare(`
        SELECT actor_id, entity_id, entity_revision FROM audit_events
        WHERE action = ? ORDER BY created_at ASC, id ASC
      `)
      .all(action) as unknown as Array<{
      actor_id: string;
      entity_id: string;
      entity_revision: number | null;
    }>;
  } finally {
    database.close();
  }
}

function registerReadyMedia(
  databasePath: string,
  mediaDirectory: string,
  id: string,
  filename: string,
  body: Buffer
): void {
  const objectDirectory = join(mediaDirectory, id);
  mkdirSync(objectDirectory, { recursive: true });
  writeFileSync(join(objectDirectory, filename), body);
  const timestamp = new Date().toISOString();
  const extension = filename.toLowerCase().split(".").pop();
  const kind = extension === "pdf" ? "pdf" : extension === "docx" ? "word" : "markdown";
  const mime = extension === "pdf" ? "application/pdf" : "text/markdown";
  const database = new KangminDatabase(databasePath);
  try {
    database.connection.prepare(`
      INSERT INTO content_resource_media(
        id, kind, filename, stored_path, size_bytes, mime_type, sha256,
        status, failure_reason, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', NULL, NULL, ?, ?)
    `).run(
      id,
      kind,
      filename,
      `${id}/${filename}`,
      body.length,
      mime,
      createHash("sha256").update(body).digest("hex"),
      timestamp,
      timestamp
    );
  } finally {
    database.close();
  }
}

async function fixture(): Promise<{
  app: ReturnType<typeof createAdminApplication>;
  databasePath: string;
  mediaDirectory: string;
  token: string;
  adminId: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-admin-agent-"));
  const databasePath = join(directory, "agent.sqlite");
  const mediaDirectory = join(directory, "admin-media");
  mkdirSync(mediaDirectory, { recursive: true });
  const app = createAdminApplication(databasePath, {
    mediaDirectory,
    knowledgeEmbedding: new TestKnowledgeEmbedding()
  });
  const session = await app.sessions.createDevelopmentSession("owner-agent");
  // 分类统一（评审 A P1-6）：create 校验 category 必须存在于 content_categories。
  const category = await app.execute({
    command: "content category create",
    adminToken: session.token,
    input: { name: "居家护理", kind: "video" }
  });
  if (!category.ok) {
    assert.fail(`${category.error.code}: ${category.error.message}`);
  }
  return { app, databasePath, mediaDirectory, token: session.token, adminId: session.adminId };
}

test("知识状态机：add→index→enable→search-test→disable", async () => {
  const { app, databasePath, mediaDirectory, token, adminId } = await fixture();
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

    // 患者知识问答只检索 enabled 分块；回答模型收到启用资料并自然作答。
    const patient = createApplication(databasePath, {
      knowledgeEmbedding: new TestKnowledgeEmbedding(),
      knowledgeAnswer: {
        async answer(_question, sources) {
          assert.equal(sources[0]?.knowledgeId, added.id);
          return "换季鼻塞时，可以先减少接触尘螨、花粉，并保持环境舒适。";
        }
      }
    });
    try {
      dataOf(await patient.execute({ command: "account register", input: { username: "knowledge-patient", password: "knowledge-pass-123" } }));
      const login = dataOf<{ token: string }>(await patient.execute({ command: "account login", input: { username: "knowledge-patient", password: "knowledge-pass-123" } }));
      const answer = dataOf<{ answer: string; sources: Array<{ knowledgeId: string }>; generated: boolean }>(await patient.execute({ command: "agent knowledge ask", sessionToken: login.token, input: { question: "换季鼻塞护理要注意什么" } }));
      assert.match(answer.answer, /鼻塞/u);
      assert.deepEqual(answer.sources, [], "患者侧不把 Top-k 候选冒充已采用来源");
      assert.equal(answer.generated, true);
    } finally {
      patient.close();
    }

    const hits = dataOf<{ items: Array<{
      knowledgeId: string;
      snippet: string;
      category: string | null;
      score: number;
    }> }>(
      await app.execute({
        command: "agent knowledge search-test",
        adminToken: token,
        input: { query: "鼻塞" }
      })
    );
    assert.equal(hits.items.length, 1);
    assert.equal(hits.items[0]?.knowledgeId, added.id);
    assert.match(hits.items[0]?.snippet ?? "", /鼻塞/u);
    assert.equal(hits.items[0]?.category, null);
    assert.equal(typeof hits.items[0]?.score, "number");

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

    // 审计（外部评审 P1-3）：知识启停必须有审计行，actor=操作者。
    const enableAudits = auditRowsOf(databasePath, "agent.knowledge.enable");
    assert.equal(enableAudits.length, 1);
    assert.equal(enableAudits[0]?.actor_id, adminId);
    assert.equal(enableAudits[0]?.entity_id, added.id);
    const disableAudits = auditRowsOf(databasePath, "agent.knowledge.disable");
    assert.equal(disableAudits.length, 1);
    assert.equal(disableAudits[0]?.actor_id, adminId);
    assert.equal(disableAudits[0]?.entity_id, added.id);
  } finally {
    app.close();
  }
});

test("知识资料支持更新和停用后删除", async () => {
  const { app, mediaDirectory, token } = await fixture();
  try {
    const file = join(mediaDirectory, "知识维护.md");
    writeFileSync(file, "# 鼻腔护理\n\n已审核的护理说明。");
    const added = dataOf<KnowledgeItem>(await app.execute({ command: "agent knowledge add", adminToken: token, input: { file } }));
    const updated = dataOf<KnowledgeItem>(await app.execute({
      command: "agent knowledge update",
      adminToken: token,
      input: { id: added.id, name: "鼻腔护理指南", source: "专业审核材料" }
    }));
    assert.equal(updated.name, "鼻腔护理指南");
    assert.equal(updated.category, null);
    assert.equal(updated.source, "专业审核材料");

    const missingConfirm = await app.execute({ command: "agent knowledge delete", adminToken: token, input: { id: added.id } });
    assert.equal(missingConfirm.ok, false);
    if (!missingConfirm.ok) assert.equal(missingConfirm.error.code, "confirmation_required");
    const deleted = dataOf<{ id: string; deleted: true }>(await app.execute({ command: "agent knowledge delete", adminToken: token, input: { id: added.id, yes: true } }));
    assert.equal(deleted.deleted, true);
    const shown = await app.execute({ command: "agent knowledge show", adminToken: token, input: { id: added.id } });
    assert.equal(shown.ok, false);
    if (!shown.ok) assert.equal(shown.error.code, "resource_not_found");
  } finally {
    app.close();
  }
});

test("更新文件原子重置启用状态，单资料测试不进入患者全库", async () => {
  const { app, databasePath, mediaDirectory, token } = await fixture();
  try {
    const originalFile = join(mediaDirectory, "原知识.md");
    writeFileSync(originalFile, "# 旧内容\n\n旧版鼻塞护理说明。");
    const added = dataOf<KnowledgeItem>(await app.execute({
      command: "agent knowledge add",
      adminToken: token,
      input: { file: originalFile, source: "保留来源" }
    }));
    await app.execute({ command: "agent knowledge index", adminToken: token, input: { id: added.id } });
    await app.execute({ command: "agent knowledge enable", adminToken: token, input: { id: added.id, yes: true } });

    const before = new KangminDatabase(databasePath);
    const beforeCounts = before.connection.prepare(`
      SELECT
        (SELECT COUNT(*) FROM agent_knowledge_chunks WHERE knowledge_id = ?) AS chunks,
        (SELECT COUNT(*) FROM agent_knowledge_embeddings WHERE knowledge_id = ?) AS embeddings
    `).get(added.id, added.id) as { chunks: number; embeddings: number };
    before.close();
    assert.ok(beforeCounts.chunks > 0);
    assert.equal(beforeCounts.embeddings, beforeCounts.chunks);

    const missing = await app.execute({
      command: "agent knowledge update-file",
      adminToken: token,
      input: { id: added.id, mediaId: "med_missing" }
    });
    assert.equal(missing.ok, false);
    const unchanged = dataOf<KnowledgeItem>(await app.execute({
      command: "agent knowledge show", adminToken: token, input: { id: added.id }
    }));
    assert.equal(unchanged.status, "enabled");
    assert.equal(unchanged.sourceMediaId, added.sourceMediaId);

    const replacementBody = Buffer.from("# 新内容\n\n更新后的鼻塞护理资料，包含冷空气防护。", "utf8");
    registerReadyMedia(databasePath, mediaDirectory, "med_replacement", "新版知识.md", replacementBody);
    const replaced = dataOf<KnowledgeItem>(await app.execute({
      command: "agent knowledge update-file",
      adminToken: token,
      input: { id: added.id, mediaId: "med_replacement" },
      requestId: "replace-knowledge-file"
    }));
    assert.equal(replaced.id, added.id);
    assert.equal(replaced.name, added.name, "更新文件不覆盖运营填写的知识名称");
    assert.equal(replaced.source, "保留来源");
    assert.equal(replaced.sourceMediaId, "med_replacement");
    assert.equal(replaced.status, "processing");

    const after = new KangminDatabase(databasePath);
    try {
      const counts = after.connection.prepare(`
        SELECT
          (SELECT COUNT(*) FROM agent_knowledge_chunks WHERE knowledge_id = ?) AS chunks,
          (SELECT COUNT(*) FROM agent_knowledge_embeddings WHERE knowledge_id = ?) AS embeddings
      `).get(added.id, added.id) as { chunks: number; embeddings: number };
      assert.ok(counts.chunks > 0);
      assert.equal(counts.embeddings, 0, "替换内容后旧向量必须清空");
      assert.equal(
        (after.connection.prepare("SELECT chunk_text FROM agent_knowledge_chunks WHERE knowledge_id = ? LIMIT 1").get(added.id) as { chunk_text: string }).chunk_text.includes("更新后"),
        true
      );
    } finally {
      after.close();
    }

    const fullBeforeIndex = dataOf<{ items: unknown[] }>(await app.execute({
      command: "agent knowledge search-test", adminToken: token, input: { query: "冷空气" }
    }));
    assert.equal(fullBeforeIndex.items.length, 0);
    await app.execute({ command: "agent knowledge index", adminToken: token, input: { id: added.id } });
    const scoped = dataOf<{ items: Array<{ knowledgeId: string; enabled: boolean }> }>(await app.execute({
      command: "agent knowledge search-test",
      adminToken: token,
      input: { id: added.id, query: "冷空气" }
    }));
    assert.equal(scoped.items[0]?.knowledgeId, added.id);
    assert.equal(scoped.items[0]?.enabled, false);
    const fullWhileIndexed = dataOf<{ items: unknown[] }>(await app.execute({
      command: "agent knowledge search-test", adminToken: token, input: { query: "冷空气" }
    }));
    assert.equal(fullWhileIndexed.items.length, 0, "单资料测试不得让未启用资料进入全库");
    await app.execute({ command: "agent knowledge enable", adminToken: token, input: { id: added.id, yes: true } });
    const fullAfterEnable = dataOf<{ items: Array<{ knowledgeId: string }> }>(await app.execute({
      command: "agent knowledge search-test", adminToken: token, input: { query: "冷空气" }
    }));
    assert.equal(fullAfterEnable.items[0]?.knowledgeId, added.id);
    assert.equal(auditRowsOf(databasePath, "agent.knowledge.update-file").length, 1);
  } finally {
    app.close();
  }
});

test("更新为不可解析文件时保持同一记录并安全停用", async () => {
  const { app, databasePath, mediaDirectory, token } = await fixture();
  try {
    const originalFile = join(mediaDirectory, "可用知识.md");
    writeFileSync(originalFile, "# 可用内容\n\n鼻敏感日常护理。");
    const added = dataOf<KnowledgeItem>(await app.execute({ command: "agent knowledge add", adminToken: token, input: { file: originalFile } }));
    await app.execute({ command: "agent knowledge index", adminToken: token, input: { id: added.id } });
    await app.execute({ command: "agent knowledge enable", adminToken: token, input: { id: added.id, yes: true } });
    registerReadyMedia(databasePath, mediaDirectory, "med_bad_pdf", "替换资料.pdf", Buffer.from("%PDF fake"));
    const replaced = dataOf<KnowledgeItem>(await app.execute({
      command: "agent knowledge update-file",
      adminToken: token,
      input: { id: added.id, mediaId: "med_bad_pdf" }
    }));
    assert.equal(replaced.id, added.id);
    assert.equal(replaced.status, "index_failed");
    assert.ok(replaced.parseError);
    const full = dataOf<{ items: unknown[] }>(await app.execute({
      command: "agent knowledge search-test", adminToken: token, input: { query: "鼻敏感" }
    }));
    assert.equal(full.items.length, 0);
  } finally {
    app.close();
  }
});

test("知识目录支持三级创建、本层归档、移动与安全删除", async () => {
  const { app, databasePath, mediaDirectory, token } = await fixture();
  try {
    const root = dataOf<KnowledgeFolder>(await app.execute({
      command: "agent knowledge folder create",
      adminToken: token,
      input: { name: "鼻炎基础" }
    }));
    const child = dataOf<KnowledgeFolder>(await app.execute({
      command: "agent knowledge folder create",
      adminToken: token,
      input: { name: "症状机制", parentId: root.id }
    }));
    const grandchild = dataOf<KnowledgeFolder>(await app.execute({
      command: "agent knowledge folder create",
      adminToken: token,
      input: { name: "换季诱因", parentId: child.id }
    }));
    assert.deepEqual([root.depth, child.depth, grandchild.depth], [1, 2, 3]);

    const fourthLevel = await app.execute({
      command: "agent knowledge folder create",
      adminToken: token,
      input: { name: "禁止第四级", parentId: grandchild.id }
    });
    assert.equal(fourthLevel.ok, false);
    if (!fourthLevel.ok) assert.equal(fourthLevel.error.code, "validation_failed");

    const duplicate = await app.execute({
      command: "agent knowledge folder create",
      adminToken: token,
      input: { name: "鼻炎基础" }
    });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.error.code, "validation_failed");

    const file = join(mediaDirectory, "目录知识.md");
    writeFileSync(file, "# 换季诱因\n\n花粉和冷空气可能诱发症状。");
    const added = dataOf<KnowledgeItem>(await app.execute({
      command: "agent knowledge add",
      adminToken: token,
      input: { file, folderId: grandchild.id }
    }));
    assert.equal(added.folderId, grandchild.id);
    const listed = dataOf<{ items: KnowledgeItem[] }>(await app.execute({
      command: "agent knowledge list",
      adminToken: token
    }));
    const listedItem = listed.items.find((item) => item.id === added.id);
    assert.equal(listedItem?.category, "鼻炎基础 / 症状机制 / 换季诱因");

    const renamed = dataOf<KnowledgeFolder>(await app.execute({
      command: "agent knowledge folder update",
      adminToken: token,
      input: { id: root.id, name: "鼻敏感基础", parentId: null }
    }));
    assert.equal(renamed.name, "鼻敏感基础");
    const afterRename = dataOf<KnowledgeItem>(await app.execute({
      command: "agent knowledge show",
      adminToken: token,
      input: { id: added.id }
    }));
    assert.equal(afterRename.category, "鼻敏感基础 / 症状机制 / 换季诱因");

    const editedInFolder = dataOf<KnowledgeItem>(await app.execute({
      command: "agent knowledge update",
      adminToken: token,
      input: { id: added.id, source: "目录内更新来源" }
    }));
    assert.equal(editedInFolder.source, "目录内更新来源");

    const cycle = await app.execute({
      command: "agent knowledge folder update",
      adminToken: token,
      input: { id: root.id, parentId: grandchild.id }
    });
    assert.equal(cycle.ok, false);
    if (!cycle.ok) assert.equal(cycle.error.code, "validation_failed");

    const nonEmptyDelete = await app.execute({
      command: "agent knowledge folder delete",
      adminToken: token,
      input: { id: grandchild.id, yes: true }
    });
    assert.equal(nonEmptyDelete.ok, false);
    if (!nonEmptyDelete.ok) assert.equal(nonEmptyDelete.error.code, "validation_failed");

    const moved = dataOf<KnowledgeItem>(await app.execute({
      command: "agent knowledge move",
      adminToken: token,
      input: { id: added.id, folderId: null }
    }));
    assert.equal(moved.folderId, null);
    assert.equal(moved.category, null);

    for (const id of [grandchild.id, child.id, root.id]) {
      const deleted = dataOf<{ id: string; deleted: true }>(await app.execute({
        command: "agent knowledge folder delete",
        adminToken: token,
        input: { id, yes: true }
      }));
      assert.equal(deleted.deleted, true);
    }
    assert.equal(auditRowsOf(databasePath, "agent.knowledge-folder.create").length, 3);
    assert.equal(auditRowsOf(databasePath, "agent.knowledge-folder.update").length, 1);
    assert.equal(auditRowsOf(databasePath, "agent.knowledge-folder.delete").length, 3);
    assert.equal(auditRowsOf(databasePath, "agent.knowledge.move").length, 1);
  } finally {
    app.close();
  }
});

test("知识目录拒绝重复改名、无效目标和移动后超深", async () => {
  const { app, mediaDirectory, token } = await fixture();
  try {
    const createFolder = async (name: string, parentId: string | null = null) =>
      dataOf<KnowledgeFolder>(await app.execute({
        command: "agent knowledge folder create",
        adminToken: token,
        input: { name, parentId }
      }));
    const rootA = await createFolder("树甲");
    const childA = await createFolder("树甲二级", rootA.id);
    await createFolder("树甲三级", childA.id);
    const rootB = await createFolder("树乙");
    const childB = await createFolder("树乙二级", rootB.id);
    await createFolder("同级占位", rootB.id);

    const duplicateRename = await app.execute({
      command: "agent knowledge folder update",
      adminToken: token,
      input: { id: childB.id, name: "同级占位" }
    });
    assert.equal(duplicateRename.ok, false);
    if (!duplicateRename.ok) assert.equal(duplicateRename.error.code, "validation_failed");

    const tooDeep = await app.execute({
      command: "agent knowledge folder update",
      adminToken: token,
      input: { id: rootA.id, parentId: childB.id }
    });
    assert.equal(tooDeep.ok, false);
    if (!tooDeep.ok) assert.equal(tooDeep.error.code, "validation_failed");

    const missingParent = await app.execute({
      command: "agent knowledge folder create",
      adminToken: token,
      input: { name: "无效目录", parentId: "kfd_missing" }
    });
    assert.equal(missingParent.ok, false);
    if (!missingParent.ok) assert.equal(missingParent.error.code, "resource_not_found");

    const file = join(mediaDirectory, "移动目标校验.md");
    writeFileSync(file, "# 移动目标校验\n\n用于验证不存在目录不能接收知识。");
    const knowledge = dataOf<KnowledgeItem>(await app.execute({
      command: "agent knowledge add",
      adminToken: token,
      input: { file }
    }));
    const missingMoveTarget = await app.execute({
      command: "agent knowledge move",
      adminToken: token,
      input: { id: knowledge.id, folderId: "kfd_missing" }
    });
    assert.equal(missingMoveTarget.ok, false);
    if (!missingMoveTarget.ok) assert.equal(missingMoveTarget.error.code, "resource_not_found");
    assert.equal((dataOf<KnowledgeItem>(await app.execute({
      command: "agent knowledge show",
      adminToken: token,
      input: { id: knowledge.id }
    }))).folderId, null);
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
  const { app, databasePath, token, adminId } = await fixture();
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
        input: { name: "肺气虚寒调理方案", syndrome: "LUNG_QI_COLD" }
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
    const feiqi = mappings.items.find((item) => item.syndromeId === "LUNG_QI_COLD");
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

    // 审计（外部评审 P1-3）：方案启停必须有审计行，actor=操作者，
    // entity=目标方案，并携带目标 revision。
    const enableAudits = auditRowsOf(databasePath, "agent.plan.enable");
    assert.equal(enableAudits.length, 1);
    assert.equal(enableAudits[0]?.actor_id, adminId);
    assert.equal(enableAudits[0]?.entity_id, plan.id);
    assert.equal(enableAudits[0]?.entity_revision, 3);
    const disableAudits = auditRowsOf(databasePath, "agent.plan.disable");
    assert.equal(disableAudits.length, 1);
    assert.equal(disableAudits[0]?.actor_id, adminId);
    assert.equal(disableAudits[0]?.entity_id, plan.id);
    assert.equal(disableAudits[0]?.entity_revision, 4);
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
        syndrome: "SPLEEN_QI_DEF",
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
        input: { title: "未发布视频", categoryIds: ["video-adult-quick-content"], idempotencyKey: "plan-video-1" }
      })
    );
    const plan = dataOf<AgentPlan>(
      await app.execute({
        command: "agent plan create",
        adminToken: token,
        input: {
          name: "关联视频方案",
          syndrome: "SPLEEN_QI_DEF",
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
    // ISO BMFF（ftyp 盒）魔数：内容魔数嗅探（类型伪装防线）识别为 video。
    writeFileSync(
      mediaFile,
      Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32
      ])
    );
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
          instructions: "操作前确认环境安全，并按视频步骤进行。",
          precautions: "出现不适立即停止，并咨询专业人员。",
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

test("方案启用走事务路径：启用前视频被下架 → enablePlan 拒绝（评审 C 事务变式）", async () => {
  const { app, mediaDirectory, token } = await fixture();
  try {
    const mediaFile = join(mediaDirectory, "unpublish-video.mp4");
    // ISO BMFF（ftyp 盒）魔数：内容魔数嗅探（类型伪装防线）识别为 video。
    writeFileSync(
      mediaFile,
      Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32
      ])
    );
    const media = dataOf<{ id: string }>(
      await app.execute({
        command: "content media upload",
        adminToken: token,
        input: { file: mediaFile }
      })
    );
    const video = dataOf<{ id: string }>(
      await app.execute({
        command: "content video create",
        adminToken: token,
        input: {
          title: "将被下架的视频",
          categoryIds: ["video-adult-quick-content"],
          idempotencyKey: "plan-video-unpublish"
        }
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
          instructions: "操作前确认环境安全，并按视频步骤进行。",
          precautions: "出现不适立即停止，并咨询专业人员。",
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

    // 视频发布时创建方案（创建仅校验视频存在，不校验发布状态）。
    const plan = dataOf<AgentPlan>(
      await app.execute({
        command: "agent plan create",
        adminToken: token,
        input: {
          name: "引用下架视频的方案",
          syndrome: "LUNG_HEAT",
          method: "日常护理",
          steps: ["步骤一"],
          risks: "风险提示",
          precautions: "注意事项",
          contraindications: "禁忌",
          videoResourceId: video.id
        }
      })
    );

    // 另一进程先下架视频（并发窗口的确定性模拟）：enablePlan 的校验与
    // 状态更新同一事务（setPlanStatusGuarded），视频发布状态在事务内
    // 重读并拒绝，不产生"已启用但依赖已下架"的中间状态。
    dataOf(
      await app.execute({
        command: "content video unpublish",
        adminToken: token,
        input: { id: video.id, expectedRevision: 3, yes: true }
      })
    );
    const rejected = await app.execute({
      command: "agent plan enable",
      adminToken: token,
      input: { id: plan.id, expectedRevision: 1, yes: true }
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "validation_failed");

    // 无部分写入：方案仍为 draft（revision 未推进）。
    const after = dataOf<AgentPlan>(
      await app.execute({
        command: "agent plan show",
        adminToken: token,
        input: { id: plan.id }
      })
    );
    assert.equal(after.status, "draft");
    assert.equal(after.revision, 1);
  } finally {
    app.close();
  }
});

test("启用状态方案的更新重跑启用校验：清空步骤/换未发布视频拒绝，合法更新放行，草稿不变", async () => {
  const { app, databasePath, mediaDirectory, token } = await fixture();
  try {
    const created = dataOf<AgentPlan>(
      await app.execute({
        command: "agent plan create",
        adminToken: token,
        input: {
          name: "启用后更新方案",
          syndrome: "LUNG_HEAT",
          method: "日常护理",
          steps: ["生理盐水洗鼻"],
          risks: "风险提示",
          precautions: "注意事项",
          contraindications: "禁忌"
        }
      })
    );
    const enabled = dataOf<AgentPlan>(
      await app.execute({
        command: "agent plan enable",
        adminToken: token,
        input: { id: created.id, expectedRevision: 1, yes: true }
      })
    );
    assert.equal(enabled.status, "enabled");

    // 清空步骤 → validation_failed（命令输入层对空 steps 数组即拒绝；
    // 服务层守卫的第二道拒绝见下方服务层直测）。两次拒绝均不落库。
    const emptySteps = await app.execute({
      command: "agent plan update",
      adminToken: token,
      input: { id: created.id, expectedRevision: 2, steps: [] }
    });
    assert.equal(emptySteps.ok, false);
    if (!emptySteps.ok) assert.equal(emptySteps.error.code, "validation_failed");

    // 换成未发布视频 → validation_failed（草稿视频存在但未发布）。
    const draftVideo = dataOf<{ id: string }>(
      await app.execute({
        command: "content video create",
        adminToken: token,
        input: {
          title: "未发布视频",
          categoryIds: ["video-adult-quick-content"],
          idempotencyKey: "enabled-update-video-1"
        }
      })
    );
    const unpublishedVideo = await app.execute({
      command: "agent plan update",
      adminToken: token,
      input: {
        id: created.id,
        expectedRevision: 2,
        videoResourceId: draftVideo.id
      }
    });
    assert.equal(unpublishedVideo.ok, false);
    if (!unpublishedVideo.ok) {
      assert.equal(unpublishedVideo.error.code, "validation_failed");
    }

    // 两次拒绝均未落库：内容、状态、revision 原样。
    const unchanged = dataOf<AgentPlan>(
      await app.execute({
        command: "agent plan show",
        adminToken: token,
        input: { id: created.id }
      })
    );
    assert.equal(unchanged.status, "enabled");
    assert.equal(unchanged.revision, 2);
    assert.deepEqual(unchanged.steps, ["生理盐水洗鼻"]);
    assert.equal(unchanged.videoResourceId, null);

    // 合法更新（改名称）→ 成功且状态仍 enabled。
    const renamed = dataOf<AgentPlan>(
      await app.execute({
        command: "agent plan update",
        adminToken: token,
        input: { id: created.id, expectedRevision: 2, name: "启用后更新方案v2" }
      })
    );
    assert.equal(renamed.status, "enabled");
    assert.equal(renamed.name, "启用后更新方案v2");
    assert.equal(renamed.revision, 3);

    // 服务层直测（命令输入层对空 steps 数组/空文本另有一层校验，清空
    // 语义只能直达服务层验证）：enabled 方案清空步骤被守卫拒绝；draft
    // 方案清空步骤仍允许（行为不变）。
    const serviceDatabase = new KangminDatabase(databasePath);
    try {
      const service = new AgentAdminService(
        new SqliteAgentAdminRepository(serviceDatabase, new PlaintextEncryption()),
        new BuiltinSyndromeRegistry(),
        new LocalFilesystemObjectStorage(mediaDirectory),
        { record: async () => {} }
      );
      await assert.rejects(
        () => service.updatePlan(created.id, 3, { steps: [] }),
        (error: unknown) => {
          assert.ok(error instanceof DomainError);
          assert.equal(error.code, "validation_failed");
          return true;
        }
      );
      const guardKept = await service.getPlan(created.id);
      assert.equal(guardKept.status, "enabled");
      assert.equal(guardKept.revision, 3);
      assert.deepEqual(guardKept.steps, ["生理盐水洗鼻"]);

      const draft = dataOf<AgentPlan>(
        await app.execute({
          command: "agent plan create",
          adminToken: token,
          input: { name: "草稿方案", syndrome: "LUNG_QI_COLD" }
        })
      );
      const draftCleared = await service.updatePlan(draft.id, 1, { steps: [] });
      assert.equal(draftCleared.status, "draft");
      assert.deepEqual(draftCleared.steps, []);
    } finally {
      serviceDatabase.close();
    }
  } finally {
    app.close();
  }
});

test("模型设置：不显示完整 API Key；未配置时测试如实报错；模拟测试契约", async () => {
  const { app, databasePath, token } = await fixture();
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

    // 加密存储（外部评审 P1-1）：库内不存明文 api_key，且带密钥版本。
    const stored = new KangminDatabase(databasePath);
    try {
      const row = stored.connection
        .prepare(`
          SELECT api_key, encryption_key_version FROM agent_model_config WHERE id = 1
        `)
        .get() as unknown as { api_key: string; encryption_key_version: string | null };
      assert.ok(
        !row.api_key.includes("sk-abcdef1234567890"),
        "api_key 必须加密存储，库内不得出现明文"
      );
      assert.equal(row.encryption_key_version, "plaintext-dev");
    } finally {
      stored.close();
    }

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

test("知识源素材被停用后 enableKnowledge 失败（事务内守卫，P1-3）", async () => {
  const { app, mediaDirectory, token } = await fixture();
  try {
    const file = join(mediaDirectory, "素材停用知识.md");
    writeFileSync(
      file,
      "# 停用素材知识\n\n停用后启用必须被拒绝。"
    );
    const added = dataOf<KnowledgeItem>(
      await app.execute({ command: "agent knowledge add", adminToken: token, input: { file } })
    );
    await app.execute({
      command: "agent knowledge index",
      adminToken: token,
      input: { id: added.id }
    });

    // 停用来源素材（此时知识未启用，引用计数为 0，允许停用）
    dataOf(
      await app.execute({
        command: "content media disable",
        adminToken: token,
        input: { id: added.sourceMediaId as string, yes: true }
      })
    );

    // 启用被拒绝：事务内重读素材状态 → 已停用 → validation_failed
    const enable = await app.execute({
      command: "agent knowledge enable",
      adminToken: token,
      input: { id: added.id, yes: true }
    });
    assert.equal(enable.ok, false);
    if (!enable.ok) assert.equal(enable.error.code, "validation_failed");
    assert.ok(!enable.ok && enable.error.message.includes("素材"));

    // 状态未被部分写入：仍为 indexed
    const after = dataOf<KnowledgeItem>(
      await app.execute({ command: "agent knowledge show", adminToken: token, input: { id: added.id } })
    );
    assert.equal(after.status, "indexed");
  } finally {
    app.close();
  }
});

test("addKnowledge 同文件重试 → 文件指纹幂等重放；不留重复知识（P1-4）", async () => {
  const { app, databasePath, mediaDirectory, token } = await fixture();
  try {
    const file = join(mediaDirectory, "幂等知识.md");
    writeFileSync(file, "# 幂等知识\n\n同文件内容只创建一条。");

    const first = dataOf<KnowledgeItem>(
      await app.execute({ command: "agent knowledge add", adminToken: token, input: { file } })
    );
    // 同内容重试：确定性键（文件 sha256）相同 → 重放返回原知识
    const second = dataOf<KnowledgeItem>(
      await app.execute({ command: "agent knowledge add", adminToken: token, input: { file } })
    );
    assert.equal(second.id, first.id);

    const listed = dataOf<{ items: KnowledgeItem[] }>(
      await app.execute({ command: "agent knowledge list", adminToken: token })
    );
    assert.equal(listed.items.length, 1);

    // 幂等行只落一条；素材也只登记一条（事务同源）
    const database = new KangminDatabase(databasePath);
    try {
      const keys = database.connection.prepare(`
        SELECT idempotency_key FROM admin_idempotency
        WHERE scope = 'agent.knowledge.add'
      `).all() as unknown as Array<{ idempotency_key: string }>;
      assert.equal(keys.length, 1);
      const mediaCount = database.connection.prepare(`
        SELECT COUNT(*) AS count FROM content_resource_media
        WHERE id = ?
      `).get(first.sourceMediaId as string) as unknown as { count: number };
      assert.equal(mediaCount.count, 1);
    } finally {
      database.close();
    }
  } finally {
    app.close();
  }
});

test("createKnowledgeSource 失败整体回滚：不留孤儿素材行与幂等行（P1-4）", async () => {
  const { app, databasePath } = await fixture();
  try {
    const database = new KangminDatabase(databasePath);
    try {
      const repository = new SqliteAgentAdminRepository(database, new PlaintextEncryption());
      // 制造事务内失败：素材 status 非法（CHECK 违约）→ 整个事务回滚。
      //（类型上 status 联合类型不含 "bogus"，用一次结构化类型断言表示
      // 非法输入，正是要验证的失败路径。）
      const invalidMediaInput = {
        adminId: "admin_x",
        media: {
          id: "med_orphan",
          kind: "markdown",
          filename: "x.md",
          storedPath: "/tmp/x.md",
          sizeBytes: 1,
          mimeType: "text/markdown",
          sha256: "deadbeef",
          status: "bogus",
          failureReason: null,
          createdBy: "admin_x",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        },
        knowledge: {
          id: "kno_orphan",
          name: "x.md",
          source: null,
          description: null,
          sourceMediaId: "med_orphan",
          sizeBytes: 1,
          mimeType: "text/markdown",
          sha256: "deadbeef",
          status: "processing",
          parseError: null,
          chunkCount: 0,
          createdBy: "admin_x",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          chunks: []
        },
        idempotencyKey: "deadbeef",
        requestHash: "deadbeef"
      };
      await assert.rejects(
        () => repository.createKnowledgeSource(
          invalidMediaInput as unknown as Parameters<
            typeof repository.createKnowledgeSource
          >[0]
        )
      );
      // 回滚后：无素材行、无知识行、无幂等行（无孤儿）
      const mediaRow = database.connection.prepare(
        "SELECT id FROM content_resource_media WHERE id = 'med_orphan'"
      ).get();
      assert.equal(mediaRow, undefined);
      const knowledgeRow = database.connection.prepare(
        "SELECT id FROM agent_knowledge_items WHERE id = 'kno_orphan'"
      ).get();
      assert.equal(knowledgeRow, undefined);
      const idemRow = database.connection.prepare(`
        SELECT idempotency_key FROM admin_idempotency
        WHERE scope = 'agent.knowledge.add' AND idempotency_key = 'deadbeef'
      `).get();
      assert.equal(idemRow, undefined);
    } finally {
      database.close();
    }
  } finally {
    app.close();
  }
});

test("agent plan create 同内容重试 → 确定性幂等键重放，不重复创建（P2-7）", async () => {
  const { app, databasePath, token } = await fixture();
  try {
    const input = {
      name: "幂等方案",
      syndrome: "LUNG_QI_COLD",
      method: "日常护理",
      steps: ["步骤一"],
      risks: "风险提示",
      precautions: "注意事项",
      contraindications: "禁忌"
    };
    const first = dataOf<AgentPlan>(
      await app.execute({ command: "agent plan create", adminToken: token, input })
    );
    const second = dataOf<AgentPlan>(
      await app.execute({ command: "agent plan create", adminToken: token, input })
    );
    assert.equal(second.id, first.id);
    const listed = dataOf<{ items: AgentPlan[] }>(
      await app.execute({ command: "agent plan list", adminToken: token })
    );
    assert.equal(listed.items.length, 1);

    const database = new KangminDatabase(databasePath);
    try {
      const rows = database.connection.prepare(`
        SELECT idempotency_key FROM admin_idempotency
        WHERE scope = 'agent.plan.create'
      `).all() as unknown as Array<{ idempotency_key: string }>;
      assert.equal(rows.length, 1);
    } finally {
      database.close();
    }
  } finally {
    app.close();
  }
});

test("模型配置单行 CAS：过期 updated_at 快照更新被拒绝（P2-8）", async () => {
  const { app, databasePath } = await fixture();
  try {
    const database = new KangminDatabase(databasePath);
    try {
      const repository = new SqliteAgentAdminRepository(database, new PlaintextEncryption());
      const row = {
        provider: "openai-compatible",
        modelName: "gpt-4o-mini",
        timeoutSeconds: 30,
        maxOutputTokens: 1024,
        knowledgeRetrievalEnabled: 0,
        retrievalCount: 3,
        explanationEnabled: 1,
        apiKey: null,
        updatedBy: "admin_a",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastTestStatus: null,
        lastTestAt: null
      };
      // 首次写入（行不存在 → INSERT）
      assert.equal(await repository.upsertModelConfig(row, null), "updated");
      // 用过期快照更新 → conflict（并发覆盖被拒绝）
      assert.equal(
        await repository.upsertModelConfig(
          { ...row, modelName: "stale-write", updatedAt: "2026-01-02T00:00:00.000Z" },
          "2020-01-01T00:00:00.000Z"
        ),
        "conflict"
      );
      // 用最新快照更新 → 成功
      assert.equal(
        await repository.upsertModelConfig(
          { ...row, modelName: "fresh-write", updatedAt: "2026-01-03T00:00:00.000Z" },
          "2026-01-01T00:00:00.000Z"
        ),
        "updated"
      );
      const stored = await repository.getModelConfig();
      assert.equal(stored?.modelName, "fresh-write");
    } finally {
      database.close();
    }
  } finally {
    app.close();
  }
});

test("addKnowledge 事务失败时清理已复制的知识文件（不留孤儿副本，P1-4）", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-knowledge-cleanup-"));
  const mediaDirectory = join(directory, "admin-media");
  const file = join(directory, "source.md");
  writeFileSync(file, "# 源文件\n\n正文。");
  const failingRepository = {
    createKnowledgeSource: async (): Promise<never> => {
      throw new Error("boom");
    }
  } as unknown as AgentAdminRepository;
  const service = new AgentAdminService(
    failingRepository,
    new BuiltinSyndromeRegistry(),
    new LocalFilesystemObjectStorage(mediaDirectory),
    { record: async () => {} }
  );
  await assert.rejects(
    () => service.addKnowledge("admin-1", file),
    /boom/u
  );
  // 复制发生在登记之前；登记失败后副本目录必须被清理（目录为空）。
  assert.equal(readdirSync(mediaDirectory).length, 0);
});
