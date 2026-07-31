import { DomainError } from "../kernel/errors.js";
import { KangminDatabase } from "./database.js";
import type { ContentReadRepository } from "../modules/browse/content-read-repository.js";
import type {
  CarePlanDetail,
  CarePlanSummary,
  PublicContent,
  PublicContentKind
} from "../modules/browse/contracts.js";
import { likePatternOf } from "../modules/browse/domain.js";

const DISCLAIMER = "本内容仅作健康科普和居家管理参考，不代替门诊诊断和专业医疗建议。";

/** 方案列表/搜索的返回条数上限（方案数量少，防御性截断）。 */
const MAX_PLAN_LIST = 100;
const PUBLIC_PREDICATE = `
  status = 'published'
  AND patient_visible = 1
  AND version_valid = 1
  AND media_available = 1
  AND published_at IS NOT NULL
`;

interface ContentRow {
  id: string;
  kind: PublicContentKind;
  title: string;
  category: string;
  summary: string;
  body: string | null;
  source: string;
  cover_url: string | null;
  media_url: string | null;
  published_at: string;
  updated_at: string;
}

interface PlanRow {
  id: string;
  name: string;
  published_revision: number;
  summary: string | null;
  steps_json: string | null;
  disclaimer: string | null;
}

function toPublicContent(row: ContentRow): PublicContent {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    category: row.category,
    summary: row.summary,
    body: row.body,
    source: row.source,
    coverUrl: row.cover_url,
    mediaUrl: row.media_url,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    disclaimer: DISCLAIMER
  };
}

function toPlanSummary(row: PlanRow): CarePlanSummary {
  return {
    id: row.id,
    name: row.name,
    publishedRevision: row.published_revision
  };
}

function toPlanDetail(row: PlanRow): CarePlanDetail {
  let steps: CarePlanDetail["steps"] = [];
  if (row.steps_json !== null) {
    try {
      const parsed: unknown = JSON.parse(row.steps_json);
      if (Array.isArray(parsed)) {
        steps = parsed.filter(
          (step): step is CarePlanDetail["steps"][number] =>
            typeof step === "object" &&
            step !== null &&
            typeof (step as { step?: unknown }).step === "number" &&
            typeof (step as { title?: unknown }).title === "string"
        );
      }
    } catch {
      steps = [];
    }
  }
  return {
    id: row.id,
    name: row.name,
    publishedRevision: row.published_revision,
    summary: row.summary,
    steps,
    disclaimer: row.disclaimer
  };
}

/**
 * 患者端 browse 只读仓库（SQLite 实现）。
 *
 * 可见性门禁：content_items 只返回 status='published' 且
 * patient_visible/version_valid/media_available 全部就绪的内容；
 * agent_care_plans 只返回 published_revision 非空的内容。
 *
 * 读失败（数据库损坏、连接关闭、锁异常）统一映射为 storage_unavailable，
 * 绝不伪装成空列表。
 */
export class SqliteContentReadRepository implements ContentReadRepository {
  constructor(private readonly database: KangminDatabase) {}

  async list(kind: PublicContentKind): Promise<PublicContent[]> {
    return this.guard(() => {
      const rows = this.database.connection
        .prepare(`
          SELECT id, kind, title, category, summary, body, source,
                 cover_url, media_url, published_at, updated_at
          FROM content_items
          WHERE kind = ? AND ${PUBLIC_PREDICATE}
          ORDER BY updated_at DESC, id ASC
        `)
        .all(kind) as unknown as ContentRow[];
      return rows.map(toPublicContent);
    });
  }

  async listPage(
    kind: PublicContentKind,
    limit: number,
    offset: number
  ): Promise<PublicContent[]> {
    return this.guard(() => {
      const rows = this.database.connection
        .prepare(`
          SELECT id, kind, title, category, summary, body, source,
                 cover_url, media_url, published_at, updated_at
          FROM content_items
          WHERE kind = ? AND ${PUBLIC_PREDICATE}
          ORDER BY updated_at DESC, id ASC
          LIMIT ? OFFSET ?
        `)
        .all(kind, limit, offset) as unknown as ContentRow[];
      return rows.map(toPublicContent);
    });
  }

  async find(
    kind: PublicContentKind,
    id: string
  ): Promise<PublicContent | null> {
    return this.guard(() => {
      const row = this.database.connection
        .prepare(`
          SELECT id, kind, title, category, summary, body, source,
                 cover_url, media_url, published_at, updated_at
          FROM content_items
          WHERE kind = ? AND id = ? AND ${PUBLIC_PREDICATE}
        `)
        .get(kind, id) as unknown as ContentRow | undefined;
      return row === undefined ? null : toPublicContent(row);
    });
  }

  async search(
    kind: PublicContentKind,
    query: string
  ): Promise<PublicContent[]> {
    return this.guard(() => {
      const pattern = likePatternOf(query);
      const rows = this.database.connection
        .prepare(`
          SELECT id, kind, title, category, summary, body, source,
                 cover_url, media_url, published_at, updated_at
          FROM content_items
          WHERE kind = ? AND ${PUBLIC_PREDICATE}
            AND (title LIKE ? ESCAPE '\\'
              OR category LIKE ? ESCAPE '\\'
              OR summary LIKE ? ESCAPE '\\')
          ORDER BY updated_at DESC, id ASC
        `)
        .all(kind, pattern, pattern, pattern) as unknown as ContentRow[];
      return rows.map(toPublicContent);
    });
  }

  async categories(kind: PublicContentKind): Promise<string[]> {
    return this.guard(() => {
      const rows = this.database.connection
        .prepare(`
          SELECT DISTINCT category
          FROM content_items
          WHERE kind = ? AND ${PUBLIC_PREDICATE}
          ORDER BY category ASC
        `)
        .all(kind) as unknown as Array<{ category: string }>;
      return rows.map((row) => row.category);
    });
  }

  async listPlans(): Promise<CarePlanSummary[]> {
    return this.guard(() => this.queryPlans(null, MAX_PLAN_LIST));
  }

  async findPlan(id: string): Promise<CarePlanDetail | null> {
    return this.guard(() => {
      const row = this.database.connection
        .prepare(`
          SELECT p.id, p.name, p.published_revision,
                 rev.summary, rev.steps_json, rev.disclaimer
          FROM agent_care_plans p
          JOIN agent_care_plan_revisions rev
            ON rev.plan_id = p.id AND rev.revision = p.published_revision
          WHERE p.id = ? AND p.published_revision IS NOT NULL
        `)
        .get(id) as unknown as PlanRow | undefined;
      return row === undefined ? null : toPlanDetail(row);
    });
  }

  async searchPlans(query: string, limit: number): Promise<CarePlanSummary[]> {
    return this.guard(() => this.queryPlans(likePatternOf(query), limit));
  }

  private queryPlans(pattern: string | null, limit: number): CarePlanSummary[] {
    const where =
      pattern === null
        ? "p.published_revision IS NOT NULL"
        : `p.published_revision IS NOT NULL
           AND (p.name LIKE ? ESCAPE '\\' OR rev.summary LIKE ? ESCAPE '\\')`;
    const statement = this.database.connection.prepare(`
      SELECT p.id, p.name, p.published_revision,
             rev.summary, rev.steps_json, rev.disclaimer
      FROM agent_care_plans p
      JOIN agent_care_plan_revisions rev
        ON rev.plan_id = p.id AND rev.revision = p.published_revision
      WHERE ${where}
      ORDER BY p.id ASC
      LIMIT ?
    `);
    const rows = (
      pattern === null
        ? statement.all(limit)
        : statement.all(pattern, pattern, limit)
    ) as unknown as PlanRow[];
    return rows.map(toPlanSummary);
  }

  /** 读失败统一映射：storage_unavailable（retryable），绝不伪装成空列表。 */
  private guard<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        "storage_unavailable",
        "内容浏览存储不可用",
        { retryable: true, cause: error }
      );
    }
  }
}
