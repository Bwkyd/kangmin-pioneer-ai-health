import type { PoolClient } from "pg";

import { decryptStoredField, encryptStoredField } from "../encrypted-fields.js";
import type { EncryptionPort } from "../../kernel/encryption.js";
import type {
  AgentAdminRepository,
  ChunkInput,
  IdempotentCreateResult,
  KnowledgeGuardedUpdateResult,
  KnowledgeRow,
  KnowledgeSourceMediaRow,
  ModelConfigRow,
  PlanGuardedUpdateResult,
  PlanRow,
  TestCaseRow,
  UpdatePlanResult
} from "../../modules/agent-admin/agent-admin-ports.js";
import type { AgentPlan } from "../../modules/agent-admin/contracts.js";
import type { KnowledgeStatus, PlanStatus } from "../../modules/agent-admin/domain.js";
import { KangminPgDatabase } from "./pg-database.js";
import { runPgIdempotentCreate } from "./pg-idempotency.js";

interface MediaRowShape {
  id: string;
  kind: KnowledgeSourceMediaRow["kind"];
  filename: string;
  stored_path: string;
  size_bytes: number;
  mime_type: string | null;
  sha256: string | null;
  status: KnowledgeSourceMediaRow["status"];
  failure_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const MEDIA_COLUMNS = `
  id, kind, filename, stored_path, size_bytes, mime_type, sha256,
  status, failure_reason, created_by, created_at, updated_at
`;

function toMediaRow(row: MediaRowShape): KnowledgeSourceMediaRow {
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    storedPath: row.stored_path,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    sha256: row.sha256,
    status: row.status,
    failureReason: row.failure_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

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
  phase_code: "acute" | null;
  audience: "adult" | "child" | null;
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
    phaseCode: row.phase_code,
    audience: row.audience,
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

export class PgAgentAdminRepository implements AgentAdminRepository {
  constructor(
    private readonly database: KangminPgDatabase,
    private readonly encryption: EncryptionPort
  ) {}

  // ---- 知识 ----

  async createKnowledge(input: KnowledgeRow & { chunks: ChunkInput[] }): Promise<void> {
    await this.database.transaction(async (client) => {
      await this.insertKnowledge(client, input);
    });
  }

  /**
   * 素材登记 + 知识创建 + 幂等行同一事务（事务与卫生残留批 P1-4）：
   * runPgIdempotentCreate 在事务内查重 → 同 hash 重放 /
   * 异 hash 冲突 → 插入素材 + 知识 + 分块 + 幂等行，任一失败整体回滚，
   * 不留孤儿素材行。幂等键为文件 sha256（内容指纹）：同文件重试 → 重放
   * 返回原知识，绝不重复创建；重放前校验原知识仍存在（stale_replay）。
   */
  async createKnowledgeSource(input: {
    adminId: string;
    media: {
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
    };
    knowledge: KnowledgeRow & { chunks: ChunkInput[] };
    idempotencyKey: string;
    requestHash: string;
  }): Promise<IdempotentCreateResult<KnowledgeRow>> {
    return this.database.transaction(async (client) => {
      const outcome = await runPgIdempotentCreate(this.database, client, {
        table: "admin_idempotency",
        actorColumn: "admin_id",
        scopeColumn: "scope",
        keyColumn: "idempotency_key",
        actorId: input.adminId,
        scope: "agent.knowledge.add",
        key: input.idempotencyKey,
        requestHash: input.requestHash,
        resultJson: JSON.stringify(input.knowledge),
        createdAt: input.knowledge.createdAt,
        verifyExists: async (json) => {
          const knowledgeId = (JSON.parse(json) as KnowledgeRow).id;
          const result = await this.database.queryIn(
            client,
            "SELECT id FROM agent_knowledge_items WHERE id = $1",
            [knowledgeId]
          );
          return result.rows[0] !== undefined;
        },
        insert: async () => {
          await this.database.queryIn(
            client,
            `INSERT INTO content_resource_media(
              id, kind, filename, stored_path, size_bytes, mime_type, sha256,
              status, failure_reason, created_by, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              input.media.id,
              input.media.kind,
              input.media.filename,
              input.media.storedPath,
              input.media.sizeBytes,
              input.media.mimeType,
              input.media.sha256,
              input.media.status,
              input.media.failureReason,
              input.media.createdBy,
              input.media.createdAt,
              input.media.updatedAt
            ]
          );
          await this.insertKnowledge(client, input.knowledge);
        }
      });
      switch (outcome.kind) {
        case "created":
          return { kind: "created" as const, item: input.knowledge };
        case "replayed":
          return {
            kind: "replayed" as const,
            item: JSON.parse(outcome.resultJson) as KnowledgeRow
          };
        case "stale_replay":
          return { kind: "stale_replay" as const };
        case "idempotency_conflict":
          return { kind: "conflict" as const };
        case "date_conflict":
          // 管理端未启用 date_conflict 语义，结构上不可达；归入冲突。
          return { kind: "conflict" as const };
      }
    });
  }

  /** 事务内共用：插入知识行与分块（调用方已持有事务）。 */
  private async insertKnowledge(
    client: PoolClient,
    input: KnowledgeRow & { chunks: ChunkInput[] }
  ): Promise<void> {
    await this.database.queryIn(
      client,
      `INSERT INTO agent_knowledge_items(
        id, name, source, description, source_media_id, size_bytes,
        mime_type, sha256, status, parse_error, chunk_count,
        created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
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
      ]
    );
    for (const chunk of input.chunks) {
      await this.database.queryIn(
        client,
        `INSERT INTO agent_knowledge_chunks(knowledge_id, chunk_index, chunk_text)
         VALUES ($1, $2, $3)`,
        [input.id, chunk.index, chunk.text]
      );
    }
  }

  async listKnowledge(status?: KnowledgeStatus): Promise<KnowledgeRow[]> {
    const { rows } = await this.database.query<KnowledgeRowShape>(
      `SELECT id, name, source, description, source_media_id, size_bytes,
             mime_type, sha256, status, parse_error, chunk_count,
             created_by, created_at, updated_at
      FROM agent_knowledge_items
      ${status === undefined ? "" : "WHERE status = $1"}
      ORDER BY updated_at DESC, id ASC`,
      status === undefined ? [] : [status]
    );
    return rows.map(toKnowledge);
  }

  async findKnowledge(id: string): Promise<KnowledgeRow | null> {
    const row = await this.findKnowledgeById(id);
    return row === undefined ? null : toKnowledge(row);
  }

  /** 事务外知识读取（与 findKnowledge 同 SQL）。 */
  private async findKnowledgeById(id: string): Promise<KnowledgeRowShape | undefined> {
    const { rows } = await this.database.query<KnowledgeRowShape>(
      `SELECT id, name, source, description, source_media_id, size_bytes,
             mime_type, sha256, status, parse_error, chunk_count,
             created_by, created_at, updated_at
      FROM agent_knowledge_items WHERE id = $1`,
      [id]
    );
    return rows[0];
  }

  /** 事务内知识读取（与 findKnowledge 同 SQL）。 */
  private async findKnowledgeIn(
    client: PoolClient,
    id: string
  ): Promise<KnowledgeRowShape | undefined> {
    const { rows } = await this.database.queryIn<KnowledgeRowShape>(
      client,
      `SELECT id, name, source, description, source_media_id, size_bytes,
             mime_type, sha256, status, parse_error, chunk_count,
             created_by, created_at, updated_at
      FROM agent_knowledge_items WHERE id = $1`,
      [id]
    );
    return rows[0];
  }

  /** 素材读取（add-from-media）：与 content-aux findMedia 同 SQL。 */
  async findMedia(id: string): Promise<KnowledgeSourceMediaRow | null> {
    const { rows } = await this.database.query<MediaRowShape>(
      `SELECT ${MEDIA_COLUMNS}
       FROM content_resource_media WHERE id = $1`,
      [id]
    );
    const row = rows[0];
    return row === undefined ? null : toMediaRow(row);
  }

  /**
   * 从已就绪素材创建知识（远程上传路径）：知识行 + 分块 + 幂等行同一
   * 事务；媒体行已在库不重复插入（source_media_id 以 mediaId 为准）。
   * 幂等 scope/key 与 createKnowledgeSource 一致：同文件重复提交重放
   * 原知识；verifyExists 保证已删除知识同键重放返回 stale_replay。
   */
  async createKnowledgeFromMedia(
    adminId: string,
    mediaId: string,
    knowledge: KnowledgeRow & { chunks: ChunkInput[] },
    idempotencyKey: string,
    requestHash: string
  ): Promise<IdempotentCreateResult<KnowledgeRow>> {
    return this.database.transaction(async (client) => {
      const outcome = await runPgIdempotentCreate(this.database, client, {
        table: "admin_idempotency",
        actorColumn: "admin_id",
        scopeColumn: "scope",
        keyColumn: "idempotency_key",
        actorId: adminId,
        scope: "agent.knowledge.add",
        key: idempotencyKey,
        requestHash,
        resultJson: JSON.stringify(knowledge),
        createdAt: knowledge.createdAt,
        verifyExists: async (json) => {
          const knowledgeId = (JSON.parse(json) as KnowledgeRow).id;
          const result = await this.database.queryIn(
            client,
            "SELECT id FROM agent_knowledge_items WHERE id = $1",
            [knowledgeId]
          );
          return result.rows[0] !== undefined;
        },
        insert: async () => {
          await this.insertKnowledge(client, {
            ...knowledge,
            sourceMediaId: mediaId
          });
        }
      });
      switch (outcome.kind) {
        case "created":
          return { kind: "created" as const, item: knowledge };
        case "replayed":
          return {
            kind: "replayed" as const,
            item: JSON.parse(outcome.resultJson) as KnowledgeRow
          };
        case "stale_replay":
          return { kind: "stale_replay" as const };
        case "idempotency_conflict":
          return { kind: "conflict" as const };
        case "date_conflict":
          // 管理端未启用 date_conflict 语义，结构上不可达；归入冲突。
          return { kind: "conflict" as const };
      }
    });
  }

  async setKnowledgeStatus(
    id: string,
    status: KnowledgeStatus,
    updatedAt: string,
    parseError: string | null = null
  ): Promise<"updated" | "not_found"> {
    const { rowCount } = await this.database.query(
      `UPDATE agent_knowledge_items
      SET status = $1, parse_error = $2, updated_at = $3
      WHERE id = $4`,
      [status, parseError, updatedAt, id]
    );
    return rowCount === 1 ? "updated" : "not_found";
  }

  /**
   * 启用/停用守卫（事务与卫生残留批 P1-3）：事务内重读知识
   * 行与来源素材状态 → guard 校验 → 通过才更新状态。并发停用素材、
   * 并发改状态的窗口被关闭（素材状态是另一表的行，重读在事务内完成；
   * 状态谓词 WHERE status = <事务内重读值> 对并发状态变化作 CAS）。
   */
  async setKnowledgeStatusGuarded(
    id: string,
    status: KnowledgeStatus,
    updatedAt: string,
    guard: (
      knowledge: KnowledgeRow,
      media: { id: string; status: string } | null
    ) => string[]
  ): Promise<KnowledgeGuardedUpdateResult> {
    return this.database.transaction(async (client) => {
      const current = await this.findKnowledgeIn(client, id);
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      let media: { id: string; status: string } | null = null;
      if (current.source_media_id !== null) {
        const mediaResult = await this.database.queryIn<{
          id: string;
          status: string;
        }>(
          client,
          "SELECT id, status FROM content_resource_media WHERE id = $1",
          [current.source_media_id]
        );
        media = mediaResult.rows[0] ?? null;
      }
      const missing = guard(toKnowledge(current), media);
      if (missing.length > 0) {
        return { kind: "validation_failed" as const, missing };
      }
      const { rowCount } = await this.database.queryIn(
        client,
        `UPDATE agent_knowledge_items
        SET status = $1, parse_error = $2, updated_at = $3
        WHERE id = $4 AND status = $5`,
        [status, null, updatedAt, id, current.status]
      );
      if (rowCount !== 1) {
        // 事务内重读与更新之间状态被并发修改时的防御性兜底
        // （PG 默认隔离级别下同事务内不可达，仅在其他会话并发
        // 提交且谓词不命中时落入）。
        return {
          kind: "validation_failed" as const,
          missing: ["知识状态已变化，请重新读取"]
        };
      }
      const updated = await this.findKnowledgeIn(client, id);
      if (updated === undefined) {
        return { kind: "not_found" as const };
      }
      return { kind: "updated" as const, knowledge: toKnowledge(updated) };
    });
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
    const { rows } = await this.database.query<{
      knowledge_id: string;
      name: string;
      source: string | null;
      chunk_index: number;
      chunk_text: string;
    }>(
      `SELECT items.id AS knowledge_id, items.name, items.source,
             chunks.chunk_index, chunks.chunk_text
      FROM agent_knowledge_chunks AS chunks
      JOIN agent_knowledge_items AS items ON items.id = chunks.knowledge_id
      WHERE chunks.chunk_text LIKE '%' || $1 || '%' ${statusFilter}
      ORDER BY items.updated_at DESC, chunks.chunk_index ASC`,
      [query]
    );
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
    await this.database.query(
      `INSERT INTO content_resource_media(
        id, kind, filename, stored_path, size_bytes, mime_type, sha256,
        status, failure_reason, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
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
      ]
    );
  }

  // ---- 方案 ----

  async createPlan(input: PlanRow): Promise<void> {
    await this.database.query(
      `INSERT INTO agent_plans(
        id, name, syndrome, phase_code, audience, method, steps_json,
        precautions, risks, contraindications, applicable_age,
        video_resource_id, display_order, status, revision, created_by,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        input.id,
        input.name,
        input.syndrome,
        input.phaseCode,
        input.audience,
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
      ]
    );
  }

  /**
   * 幂等创建方案（事务与卫生残留批 P2-7）：确定性幂等键 + 重放语义
   * 与内容/公告创建共用 runPgIdempotentCreate（scope=agent.plan.create）。
   */
  async createPlanIdempotent(
    adminId: string,
    plan: PlanRow,
    idempotencyKey: string,
    requestHash: string
  ): Promise<IdempotentCreateResult<AgentPlan>> {
    return this.database.transaction(async (client) => {
      const outcome = await runPgIdempotentCreate(this.database, client, {
        table: "admin_idempotency",
        actorColumn: "admin_id",
        scopeColumn: "scope",
        keyColumn: "idempotency_key",
        actorId: adminId,
        scope: "agent.plan.create",
        key: idempotencyKey,
        requestHash,
        resultJson: JSON.stringify(plan),
        createdAt: plan.createdAt,
        verifyExists: async (json) => {
          const planId = (JSON.parse(json) as PlanRow).id;
          const result = await this.database.queryIn(
            client,
            "SELECT id FROM agent_plans WHERE id = $1",
            [planId]
          );
          return result.rows[0] !== undefined;
        },
        insert: async () => {
          await this.database.queryIn(
            client,
            `INSERT INTO agent_plans(
              id, name, syndrome, phase_code, audience, method, steps_json,
              precautions, risks, contraindications, applicable_age,
              video_resource_id, display_order, status, revision, created_by,
              created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
            [
              plan.id,
              plan.name,
              plan.syndrome,
              plan.phaseCode,
              plan.audience,
              plan.method,
              plan.stepsJson,
              plan.precautions,
              plan.risks,
              plan.contraindications,
              plan.applicableAge,
              plan.videoResourceId,
              plan.displayOrder,
              plan.status,
              plan.revision,
              plan.createdBy,
              plan.createdAt,
              plan.updatedAt
            ]
          );
        }
      });
      switch (outcome.kind) {
        case "created":
          return { kind: "created" as const, item: toPlan(this.toPlanShape(plan)) };
        case "replayed":
          return {
            kind: "replayed" as const,
            item: toPlan(this.toPlanShape(JSON.parse(outcome.resultJson) as PlanRow))
          };
        case "stale_replay":
          return { kind: "stale_replay" as const };
        case "idempotency_conflict":
          return { kind: "conflict" as const };
        case "date_conflict":
          // 管理端未启用 date_conflict 语义，结构上不可达；归入冲突。
          return { kind: "conflict" as const };
      }
    });
  }

  /** PlanRow（camelCase 端口形态）→ 库行形态（snake_case）。 */
  private toPlanShape(plan: PlanRow): PlanRowShape {
    return {
      id: plan.id,
      name: plan.name,
      syndrome: plan.syndrome,
      phase_code: plan.phaseCode,
      audience: plan.audience,
      method: plan.method,
      steps_json: plan.stepsJson,
      precautions: plan.precautions,
      risks: plan.risks,
      contraindications: plan.contraindications,
      applicable_age: plan.applicableAge,
      video_resource_id: plan.videoResourceId,
      display_order: plan.displayOrder,
      status: plan.status,
      revision: plan.revision,
      created_by: plan.createdBy,
      created_at: plan.createdAt,
      updated_at: plan.updatedAt
    };
  }

  async listPlans(status?: PlanStatus): Promise<AgentPlan[]> {
    const { rows } = await this.database.query<PlanRowShape>(
      `SELECT id, name, syndrome, phase_code, audience, method, steps_json,
             precautions, risks, contraindications, applicable_age,
             video_resource_id, display_order, status, revision, created_by,
             created_at, updated_at
      FROM agent_plans
      ${status === undefined ? "" : "WHERE status = $1"}
      ORDER BY display_order ASC, updated_at DESC, id ASC`,
      status === undefined ? [] : [status]
    );
    return rows.map(toPlan);
  }

  async findPlan(id: string): Promise<AgentPlan | null> {
    const row = await this.findPlanById(id);
    return row === undefined ? null : toPlan(row);
  }

  /** 事务外方案读取（与 findPlan 同 SQL）。 */
  private async findPlanById(id: string): Promise<PlanRowShape | undefined> {
    const { rows } = await this.database.query<PlanRowShape>(
      `SELECT id, name, syndrome, phase_code, audience, method, steps_json,
             precautions, risks, contraindications, applicable_age,
             video_resource_id, display_order, status, revision, created_by,
             created_at, updated_at
      FROM agent_plans WHERE id = $1`,
      [id]
    );
    return rows[0];
  }

  /** 事务内方案读取（与 findPlan 同 SQL）。 */
  private async findPlanIn(
    client: PoolClient,
    id: string
  ): Promise<PlanRowShape | undefined> {
    const { rows } = await this.database.queryIn<PlanRowShape>(
      client,
      `SELECT id, name, syndrome, phase_code, audience, method, steps_json,
             precautions, risks, contraindications, applicable_age,
             video_resource_id, display_order, status, revision, created_by,
             created_at, updated_at
      FROM agent_plans WHERE id = $1`,
      [id]
    );
    return rows[0];
  }

  async updatePlan(
    plan: AgentPlan,
    expectedRevision: number
  ): Promise<UpdatePlanResult> {
    return this.database.transaction(async (client) => {
      const currentResult = await this.database.queryIn<{ revision: number }>(
        client,
        "SELECT revision FROM agent_plans WHERE id = $1",
        [plan.id]
      );
      const current = currentResult.rows[0];
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      await this.database.queryIn(
        client,
        `UPDATE agent_plans SET
          name = $1, syndrome = $2, phase_code = $3, audience = $4, method = $5,
          steps_json = $6, precautions = $7, risks = $8, contraindications = $9,
          applicable_age = $10, video_resource_id = $11, display_order = $12,
          status = $13, updated_at = $14, revision = $15
        WHERE id = $16`,
        [
          plan.name,
          plan.syndrome,
          plan.phaseCode,
          plan.audience,
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
        ]
      );
      return { kind: "updated" as const, plan };
    });
  }

  /**
   * 内容更新与启用等价校验同一事务（与 setPlanStatusGuarded 同类事务
   * 变式）：guard 在事务内执行，视频发布状态按新内容的
   * videoResourceId 在事务内重读——并发进程在另一事务下架视频时，本
   * 事务校验拒绝，内容更新不提交（与 updatePlan 共用 CAS）。
   */
  async updatePlanGuarded(
    plan: AgentPlan,
    expectedRevision: number,
    guard: (
      plan: AgentPlan,
      video: { id: string; status: string } | null
    ) => string[]
  ): Promise<PlanGuardedUpdateResult> {
    return this.database.transaction(async (client) => {
      const currentResult = await this.database.queryIn<{ revision: number }>(
        client,
        "SELECT revision FROM agent_plans WHERE id = $1",
        [plan.id]
      );
      const current = currentResult.rows[0];
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      let video: { id: string; status: string } | null = null;
      if (plan.videoResourceId !== null) {
        const videoResult = await this.database.queryIn<{
          id: string;
          status: string;
        }>(
          client,
          "SELECT id, status FROM content_items WHERE kind = 'video' AND id = $1",
          [plan.videoResourceId]
        );
        video = videoResult.rows[0] ?? null;
      }
      const missing = guard(plan, video);
      if (missing.length > 0) {
        return { kind: "validation_failed" as const, missing };
      }
      await this.database.queryIn(
        client,
        `UPDATE agent_plans SET
          name = $1, syndrome = $2, phase_code = $3, audience = $4, method = $5,
          steps_json = $6, precautions = $7, risks = $8, contraindications = $9,
          applicable_age = $10, video_resource_id = $11, display_order = $12,
          status = $13, updated_at = $14, revision = $15
        WHERE id = $16`,
        [
          plan.name,
          plan.syndrome,
          plan.phaseCode,
          plan.audience,
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
        ]
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
    return this.database.transaction(async (client) => {
      const currentResult = await this.database.queryIn<{ revision: number }>(
        client,
        "SELECT revision FROM agent_plans WHERE id = $1",
        [id]
      );
      const current = currentResult.rows[0];
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const { rowCount } = await this.database.queryIn(
        client,
        `UPDATE agent_plans
        SET status = $1, updated_at = $2, revision = revision + 1
        WHERE id = $3`,
        [status, updatedAt, id]
      );
      if (rowCount !== 1) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const updated = await this.findPlanIn(client, id);
      if (updated === undefined) {
        return { kind: "not_found" as const };
      }
      return { kind: "updated" as const, plan: toPlan(updated) };
    });
  }

  /**
   * 启用前校验与状态更新同一事务（评审 C 事务变式）：guard 在
   * 事务内执行，方案与视频发布状态在事务内重读——
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
    return this.database.transaction(async (client) => {
      const current = await this.findPlanIn(client, id);
      if (current === undefined) {
        return { kind: "not_found" as const };
      }
      if (current.revision !== expectedRevision) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const plan = toPlan(current);
      let video: { id: string; status: string } | null = null;
      if (plan.videoResourceId !== null) {
        const videoResult = await this.database.queryIn<{
          id: string;
          status: string;
        }>(
          client,
          "SELECT id, status FROM content_items WHERE kind = 'video' AND id = $1",
          [plan.videoResourceId]
        );
        video = videoResult.rows[0] ?? null;
      }
      const missing = guard(plan, video);
      if (missing.length > 0) {
        return { kind: "validation_failed" as const, missing };
      }
      const { rowCount } = await this.database.queryIn(
        client,
        `UPDATE agent_plans
        SET status = $1, updated_at = $2, revision = revision + 1
        WHERE id = $3`,
        [status, updatedAt, id]
      );
      if (rowCount !== 1) {
        return { kind: "version_conflict" as const, currentRevision: current.revision };
      }
      const updated = await this.findPlanIn(client, id);
      if (updated === undefined) {
        return { kind: "not_found" as const };
      }
      return { kind: "updated" as const, plan: toPlan(updated) };
    });
  }

  // ---- 模型设置 ----

  async getModelConfig(): Promise<ModelConfigRow | null> {
    const { rows } = await this.database.query<ModelConfigShape>(
      `SELECT provider, model_name, timeout_seconds, max_output_tokens,
             knowledge_retrieval_enabled, retrieval_count, explanation_enabled,
             api_key, encryption_key_version,
             updated_by, updated_at, last_test_status, last_test_at
      FROM agent_model_config WHERE id = 1`
    );
    const row = rows[0];
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

  /**
   * 单行 CAS（事务与卫生残留批 P2-8）：行不存在 → INSERT；行存在 →
   * UPDATE 带 updated_at 谓词（expectedUpdatedAt 由调用方从最近一次
   * getModelConfig 快照取），谓词不命中（并发覆盖）→ "conflict"。
   * updated_at 可能为 NULL（理论旧行）：谓词用 IS NULL 感知比较。
   */
  async upsertModelConfig(
    row: ModelConfigRow,
    expectedUpdatedAt: string | null
  ): Promise<"updated" | "conflict"> {
    const encrypted =
      row.apiKey === null
        ? { stored: null, keyVersion: null }
        : encryptStoredField(this.encryption, row.apiKey);
    return this.database.transaction(async (client) => {
      const currentResult = await this.database.queryIn<{
        updated_at: string | null;
      }>(
        client,
        "SELECT updated_at FROM agent_model_config WHERE id = 1"
      );
      const current = currentResult.rows[0];
      if (current === undefined) {
        await this.database.queryIn(
          client,
          `INSERT INTO agent_model_config(
            id, provider, model_name, timeout_seconds, max_output_tokens,
            knowledge_retrieval_enabled, retrieval_count, explanation_enabled,
            api_key, encryption_key_version,
            updated_by, updated_at, last_test_status, last_test_at
          ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
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
          ]
        );
        return "updated";
      }
      const { rowCount } = await this.database.queryIn(
        client,
        `UPDATE agent_model_config SET
          provider = $1, model_name = $2, timeout_seconds = $3,
          max_output_tokens = $4, knowledge_retrieval_enabled = $5,
          retrieval_count = $6, explanation_enabled = $7,
          api_key = $8, encryption_key_version = $9,
          updated_by = $10, updated_at = $11, last_test_status = $12, last_test_at = $13
        WHERE id = 1 AND (updated_at = $14 OR (updated_at IS NULL AND $15::text IS NULL))`,
        [
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
          row.lastTestAt,
          expectedUpdatedAt,
          expectedUpdatedAt
        ]
      );
      return rowCount === 1 ? "updated" : "conflict";
    });
  }

  // ---- 模拟测试 ----

  async findTestCase(id: string): Promise<TestCaseRow | null> {
    const { rows } = await this.database.query<TestCaseShape>(
      `SELECT id, input_text, status, result_json, created_by, created_at
      FROM agent_test_cases WHERE id = $1`,
      [id]
    );
    const row = rows[0];
    return row === undefined ? null : toTestCase(row);
  }

  async listTestCases(limit: number): Promise<TestCaseRow[]> {
    const { rows } = await this.database.query<TestCaseShape>(
      `SELECT id, input_text, status, result_json, created_by, created_at
      FROM agent_test_cases ORDER BY created_at DESC, id ASC LIMIT $1`,
      [limit]
    );
    return rows.map(toTestCase);
  }

  // ---- 内容集成 ----

  async findVideoResource(id: string): Promise<{ id: string; status: string } | null> {
    const { rows } = await this.database.query<{ id: string; status: string }>(
      `SELECT id, status FROM content_items WHERE kind = 'video' AND id = $1`,
      [id]
    );
    const row = rows[0];
    return row === undefined ? null : row;
  }
}
