import { KangminDatabase } from "./database.js";
import { decryptStoredField, encryptStoredField } from "./encrypted-fields.js";
import type { EncryptionPort } from "../kernel/encryption.js";
import type {
  AgentAdminRepository,
  ChunkInput,
  KnowledgeRow,
  ModelConfigRow,
  PlanGuardedUpdateResult,
  PlanRow,
  TestCaseRow,
  UpdatePlanResult
} from "../modules/agent-admin/agent-admin-ports.js";
import type { AgentPlan } from "../modules/agent-admin/contracts.js";
import type { KnowledgeStatus, PlanStatus } from "../modules/agent-admin/domain.js";

interface KnowledgeRowShape {
  id: string;
  name: string;
  source: string | null;
  description: string | null;
  source_media_id: string | null;
  size_bytes: number;
  mime_type: string | null;
  sha256: string | null;
  status: KnowledgeStatus;
  parse_error: string | null;
  chunk_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanRowShape {
  id: string;
  name: string;
  syndrome: string;
  method: string;
  steps_json: string;
  precautions: string;
  risks: string;
  contraindications: string;
  applicable_age: string | null;
  video_resource_id: string | null;
  display_order: number;
  status: PlanStatus;
  revision: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface ModelConfigShape {
  provider: string;
  model_name: string;
  timeout_seconds: number;
  max_output_tokens: number;
  knowledge_retrieval_enabled: number;
  retrieval_count: number;
  explanation_enabled: number;
  api_key: string | null;
  encryption_key_version: string | null;
  updated_by: string | null;
  updated_at: string | null;
  last_test_status: string | null;
  last_test_at: string | null;
}

interface TestCaseShape {
  id: string;
  input_text: string;
  status: "completed" | "failed";
  result_json: string;
  created_by: string | null;
  created_at: string;
}

function toKnowledge(row: KnowledgeRowShape): KnowledgeRow {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    description: row.description,
    sourceMediaId: row.source_media_id,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    sha256: row.sha256,
    status: row.status,
    parseError: row.parse_error,
    chunkCount: row.chunk_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toPlan(row: PlanRowShape): AgentPlan {
  return {
    id: row.id,
    name: row.name,
    syndrome: row.syndrome,
    method: row.method,
    steps: JSON.parse(row.steps_json) as string[],
    precautions: row.precautions,
    risks: row.risks,
    contraindications: row.contraindications,
    applicableAge: row.applicable_age,
    videoResourceId: row.video_resource_id,
    displayOrder: row.display_order,
    status: row.status,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toTestCase(row: TestCaseShape): TestCaseRow {
  return {
    id: row.id,
    inputText: row.input_text,
    status: row.status,
    resultJson: row.result_json,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

export class SqliteAgentAdminRepository implements AgentAdminRepository {
  constructor(
    private readonly database: KangminDatabase,
    private readonly encryption: EncryptionPort
  ) {}

  // ---- 知识 ----

  async createKnowledge(input: KnowledgeRow & { chunks: ChunkInput[] }): Promise<void> {
    this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT INTO agent_knowledge_items(
          id, name, source, description, source_media_id, size_bytes,
          mime_type, sha256, status, parse_error, chunk_count,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.name,
        input.source,
        input.description,
        input.sourceMediaId,
        input.sizeBytes,
        input.mimeType,
        input.sha256,
        input.status,
        input.parseError,
        input.chunkCount,
        input.createdBy,
        input.createdAt,
        input.updatedAt
      );
      const statement = this.database.connection.prepare(`
        INSERT INTO agent_knowledge_chunks(knowledge_id, chunk_index, chunk_text)
        VALUES (?, ?, ?)
      `);
      for (const chunk of input.chunks) {
        statement.run(input.id, chunk.index, chunk.text);
      }
    });
  }

  async listKnowledge(status?: KnowledgeStatus): Promise<KnowledgeRow[]> {
    const rows = this.database.connection.prepare(`
      SELECT id, name, source, description, source_media_id, size_bytes,
             mime_type, sha256, status, parse_error, chunk_count,
             created_by, created_at, updated_at
      FROM agent_knowledge_items
      ${status === undefined ? "" : "WHERE status = ?"}
      ORDER BY updated_at DESC, id ASC
    `).all(...(status === undefined ? [] : [status])) as unknown as KnowledgeRowShape[];
    return rows.map(toKnowledge);
  }

  async findKnowledge(id: string): Promise<KnowledgeRow | null> {
    const row = this.database.connection.prepare(`
      SELECT id, name, source, description, source_media_id, size_bytes,
             mime_type, sha256, status, parse_error, chunk_count,
             created_by, created_at, updated_at
      FROM agent_knowledge_items WHERE id = ?
    `).get(id) as unknown as KnowledgeRowShape | undefined;
    return row === undefined ? null : toKnowledge(row);
  }

  async setKnowledgeStatus(
    id: string,
    status: KnowledgeStatus,
    updatedAt: string,
    parseError: string | null = null
  ): Promise<"updated" | "not_found"> {
    const result = this.database.connection.prepare(`
      UPDATE agent_knowledge_items
      SET status = ?, parse_error = ?, updated_at = ?
      WHERE id = ?
    `).run(status, parseError, updatedAt, id);
    return result.changes === 1 ? "updated" : "not_found";
  }

  async searchChunks(query: string, onlyEnabled: boolean): Promise<
    Array<{
      knowledgeId: string;
      name: string;
      source: string | null;
      chunkIndex: number;
      chunkText: string;
    }>
  > {
    const statusFilter = onlyEnabled ? "AND items.status = 'enabled'" : "";
    const rows = this.database.connection.prepare(`
      SELECT items.id AS knowledge_id, items.name, items.source,
             chunks.chunk_index, chunks.chunk_text
      FROM agent_knowledge_chunks AS chunks
      JOIN agent_knowledge_items AS items ON items.id = chunks.knowledge_id
      WHERE chunks.chunk_text LIKE '%' || ? || '%' ${statusFilter}
      ORDER BY items.updated_at DESC, chunks.chunk_index ASC
    `).all(query) as unknown as Array<{
      knowledge_id: string;
      name: string;
      source: string | null;
      chunk_index: number;
      chunk_text: string;
    }>;
    return rows.map((row) => ({
      knowledgeId: row.knowledge_id,
      name: row.name,
      source: row.source,
      chunkIndex: row.chunk_index,
      chunkText: row.chunk_text
    }));
  }

  // ---- 素材登记 ----

  async registerMedia(input: {
    id: string;
    kind: "image" | "video" | "word" | "pdf" | "markdown";
    filename: string;
    storedPath: string;
    sizeBytes: number;
    mimeType: string | null;
    sha256: string | null;
    status: "processing" | "ready" | "failed" | "disabled";
    failureReason: string | null;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  }): Promise<void> {
    this.database.connection.prepare(`
      INSERT INTO content_resource_media(
        id, kind, filename, stored_path, size_bytes, mime_type, sha256,
        status, failure_reason, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.kind,
      input.filename,
      input.storedPath,
      input.sizeBytes,
      input.mimeType,
      input.sha256,
      input.status,
      input.failureReason,
      input.createdBy,
      input.createdAt,
      input.updatedAt
    );
  }

  // ---- 方案 ----

  async createPlan(input: PlanRow): Promise<void> {
    this.database.connection.prepare(`
      INSERT INTO agent_plans(
        id, name, syndrome, method, steps_json, precautions, risks,
        contraindications, applicable_age, video_resource_id, display_order,
        status, revision, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.name,
      input.syndrome,
      input.method,
      input.stepsJson,
      input.precautions,
      input.risks,
      input.contraindications,
      input.applicableAge,
      input.videoResourceId,
      input.displayOrder,
      input.status,
      input.revision,
      input.createdBy,
      input.createdAt,
      input.updatedAt
    );
  }

  async listPlans(status?: PlanStatus): Promise<AgentPlan[]> {
    const rows = this.database.connection.prepare(`
      SELECT id, name, syndrome, method, steps_json, precautions, risks,
             contraindications, applicable_age, video_resource_id, display_order,
             status, revision, created_by, created_at, updated_at
      FROM agent_plans
      ${status === undefined ? "" : "WHERE status = ?"}
      ORDER BY display_order ASC, updated_at DESC, id ASC
    `).all(...(status === undefined ? [] : [status])) as unknown as PlanRowShape[];
    return rows.map(toPlan);
  }

  async findPlan(id: string): Promise<AgentPlan | null> {
    const row = this.findPlanSync(id);
    return row === undefined ? null : toPlan(row);
  }

  /** 事务内方案读取（与 findPlan 同 SQL）。 */
  private findPlanSync(id: string): PlanRowShape | undefined {
    return this.database.connection.prepare(`
      SELECT id, name, syndrome, method, steps_json, precautions, risks,
             contraindications, applicable_age, video_resource_id, display_order,
             status, revision, created_by, created_at, updated_at
      FROM agent_plans WHERE id = ?
    `).get(id) as unknown as PlanRowShape | undefined;
  }

  async updatePlan(
    plan: AgentPlan,
    expectedRevision: number
  ): Promise<UpdatePlanResult> {
    return this.database.transaction(() => {
      const current = this.database.connection.prepare(
        "SELECT revision FROM agent_plans WHERE id = ?"
      ).get(plan.id) as unknown as { revision: number } | undefined;
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      this.database.connection.prepare(`
        UPDATE agent_plans SET
          name = ?, syndrome = ?, method = ?, steps_json = ?, precautions = ?,
          risks = ?, contraindications = ?, applicable_age = ?,
          video_resource_id = ?, display_order = ?, status = ?,
          updated_at = ?, revision = ?
        WHERE id = ?
      `).run(
        plan.name,
        plan.syndrome,
        plan.method,
        JSON.stringify(plan.steps),
        plan.precautions,
        plan.risks,
        plan.contraindications,
        plan.applicableAge,
        plan.videoResourceId,
        plan.displayOrder,
        plan.status,
        plan.updatedAt,
        plan.revision,
        plan.id
      );
      return { kind: "updated" as const, plan };
    });
  }

  async setPlanStatus(
    id: string,
    expectedRevision: number,
    status: PlanStatus,
    updatedAt: string
  ): Promise<UpdatePlanResult> {
    return this.database.transaction(() => {
      const current = this.database.connection.prepare(
        "SELECT revision FROM agent_plans WHERE id = ?"
      ).get(id) as unknown as { revision: number } | undefined;
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const result = this.database.connection.prepare(`
        UPDATE agent_plans
        SET status = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?
      `).run(status, updatedAt, id);
      if (result.changes !== 1) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const updated = this.database.connection.prepare(`
        SELECT id, name, syndrome, method, steps_json, precautions, risks,
               contraindications, applicable_age, video_resource_id, display_order,
               status, revision, created_by, created_at, updated_at
        FROM agent_plans WHERE id = ?
      `).get(id) as unknown as PlanRowShape;
      return { kind: "updated" as const, plan: toPlan(updated) };
    });
  }

  /**
   * 启用前校验与状态更新同一事务（评审 C 事务变式）：guard 在
   * BEGIN IMMEDIATE 内执行，方案与视频发布状态在事务内重读——
   * 并发进程在另一事务下架视频时，本事务校验拒绝，状态更新不提交；
   * 校验通过才在同一事务内置为 enabled（与 setPlanStatus 共用 CAS）。
   */
  async setPlanStatusGuarded(
    id: string,
    expectedRevision: number,
    status: PlanStatus,
    updatedAt: string,
    guard: (
      plan: AgentPlan,
      video: { id: string; status: string } | null
    ) => string[]
  ): Promise<PlanGuardedUpdateResult> {
    return this.database.transaction(() => {
      const current = this.findPlanSync(id);
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const plan = toPlan(current);
      const video =
        plan.videoResourceId === null
          ? null
          : (this.database.connection.prepare(
              "SELECT id, status FROM content_items WHERE kind = 'video' AND id = ?"
            ).get(plan.videoResourceId) as unknown as
              | { id: string; status: string }
              | undefined) ?? null;
      const missing = guard(plan, video);
      if (missing.length > 0) {
        return { kind: "validation_failed" as const, missing };
      }
      const result = this.database.connection.prepare(`
        UPDATE agent_plans
        SET status = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?
      `).run(status, updatedAt, id);
      if (result.changes !== 1) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const updated = this.database.connection.prepare(`
        SELECT id, name, syndrome, method, steps_json, precautions, risks,
               contraindications, applicable_age, video_resource_id, display_order,
               status, revision, created_by, created_at, updated_at
        FROM agent_plans WHERE id = ?
      `).get(id) as unknown as PlanRowShape;
      return { kind: "updated" as const, plan: toPlan(updated) };
    });
  }

  // ---- 模型设置 ----

  async getModelConfig(): Promise<ModelConfigRow | null> {
    const row = this.database.connection.prepare(`
      SELECT provider, model_name, timeout_seconds, max_output_tokens,
             knowledge_retrieval_enabled, retrieval_count, explanation_enabled,
             api_key, encryption_key_version,
             updated_by, updated_at, last_test_status, last_test_at
      FROM agent_model_config WHERE id = 1
    `).get() as unknown as ModelConfigShape | undefined;
    if (row === undefined) {
      return null;
    }
    // api_key 为密文 JSON + 表级密钥版本（迁移 0013）；解密失败映射为
    // storage_unavailable，绝不宽松降级。
    const apiKey = decryptStoredField(
      this.encryption,
      row.api_key,
      row.encryption_key_version,
      "模型 API Key"
    );
    return {
      provider: row.provider,
      modelName: row.model_name,
      timeoutSeconds: row.timeout_seconds,
      maxOutputTokens: row.max_output_tokens,
      knowledgeRetrievalEnabled: row.knowledge_retrieval_enabled,
      retrievalCount: row.retrieval_count,
      explanationEnabled: row.explanation_enabled,
      apiKey,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
      lastTestStatus: row.last_test_status,
      lastTestAt: row.last_test_at
    };
  }

  async upsertModelConfig(row: ModelConfigRow): Promise<void> {
    const encrypted =
      row.apiKey === null
        ? { stored: null, keyVersion: null }
        : encryptStoredField(this.encryption, row.apiKey);
    this.database.connection.prepare(`
      INSERT INTO agent_model_config(
        id, provider, model_name, timeout_seconds, max_output_tokens,
        knowledge_retrieval_enabled, retrieval_count, explanation_enabled,
        api_key, encryption_key_version,
        updated_by, updated_at, last_test_status, last_test_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        model_name = excluded.model_name,
        timeout_seconds = excluded.timeout_seconds,
        max_output_tokens = excluded.max_output_tokens,
        knowledge_retrieval_enabled = excluded.knowledge_retrieval_enabled,
        retrieval_count = excluded.retrieval_count,
        explanation_enabled = excluded.explanation_enabled,
        api_key = excluded.api_key,
        encryption_key_version = excluded.encryption_key_version,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at,
        last_test_status = excluded.last_test_status,
        last_test_at = excluded.last_test_at
    `).run(
      row.provider,
      row.modelName,
      row.timeoutSeconds,
      row.maxOutputTokens,
      row.knowledgeRetrievalEnabled,
      row.retrievalCount,
      row.explanationEnabled,
      encrypted.stored,
      encrypted.keyVersion,
      row.updatedBy,
      row.updatedAt,
      row.lastTestStatus,
      row.lastTestAt
    );
  }

  // ---- 模拟测试 ----

  async findTestCase(id: string): Promise<TestCaseRow | null> {
    const row = this.database.connection.prepare(`
      SELECT id, input_text, status, result_json, created_by, created_at
      FROM agent_test_cases WHERE id = ?
    `).get(id) as unknown as TestCaseShape | undefined;
    return row === undefined ? null : toTestCase(row);
  }

  async listTestCases(limit: number): Promise<TestCaseRow[]> {
    const rows = this.database.connection.prepare(`
      SELECT id, input_text, status, result_json, created_by, created_at
      FROM agent_test_cases ORDER BY created_at DESC, id ASC LIMIT ?
    `).all(limit) as unknown as TestCaseShape[];
    return rows.map(toTestCase);
  }

  // ---- 内容集成 ----

  async findVideoResource(id: string): Promise<{ id: string; status: string } | null> {
    const row = this.database.connection.prepare(`
      SELECT id, status FROM content_items WHERE kind = 'video' AND id = ?
    `).get(id) as unknown as { id: string; status: string } | undefined;
    return row === undefined ? null : row;
  }
}
