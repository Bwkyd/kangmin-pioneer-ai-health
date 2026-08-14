import { DomainError } from "../kernel/errors.js";
import { KangminDatabase } from "./database.js";
import type {
  ContentReadRepository,
  PublishedMediaRef
} from "../modules/browse/content-read-repository.js";
import type {
  CarePlanDetail,
  CarePlanSummary,
  PatientMessage,
  PublicContent,
  PublicContentKind
} from "../modules/browse/contracts.js";
import { likePatternOf } from "../modules/browse/domain.js";

const DISCLAIMER = "本内容仅作健康科普和居家管理参考，不代替门诊诊断和专业医疗建议。";

/** 方案列表/搜索的返回条数上限（方案数量少，防御性截断）。 */
const MAX_PLAN_LIST = 100;

/**
 * 方案浏览可见性开关（设计 §17 双门禁的患者侧半边）：
 * planBrowseEnabled = 临床规则包是否 approved，由组合根注入；
 * 未注入时默认 false（candidate 期间方案对患者不可见）。
 */
export interface PlanBrowseVisibility {
  planBrowseEnabled?: boolean;
}

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
  revision: number;
  method: string | null;
  steps_json: string | null;
  precautions: string;
  risks: string;
  contraindications: string;
  video_resource_id: string | null;
}

interface MessageRow {
  id: string;
  title: string;
  body: string;
  summary: string | null;
  published_at: string;
  read_at: string | null;
}

function toPatientMessage(row: MessageRow): PatientMessage {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    summary: row.summary,
    publishedAt: row.published_at,
    readAt: row.read_at
  };
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
    publishedRevision: row.revision
  };
}

function toPlanDetail(row: PlanRow): CarePlanDetail {
  let steps: CarePlanDetail["steps"] = [];
  if (row.steps_json !== null) {
    try {
      const parsed: unknown = JSON.parse(row.steps_json);
      if (Array.isArray(parsed)) {
        // 兼容管理端写回的两种 steps_json 格式（评审 R2 P2 契约兼容）：
        // 1. AgentPlan.steps 为 string[]（历史契约）→ 按数组顺序映射为
        //    {step: i+1, title: 文本}；
        // 2. 对象数组 {step, title, description?}（当前种子/浏览端格式）。
        // 非法条目丢弃、解析失败回退空列表，绝不宽松解析。
        steps = parsed
          .map((entry, index) => {
            if (typeof entry === "string") {
              return { step: index + 1, title: entry };
            }
            if (
              typeof entry === "object" &&
              entry !== null &&
              typeof (entry as { step?: unknown }).step === "number" &&
              typeof (entry as { title?: unknown }).title === "string"
            ) {
              return entry as CarePlanDetail["steps"][number];
            }
            return null;
          })
          .filter(
            (step): step is CarePlanDetail["steps"][number] => step !== null
          );
      }
    } catch {
      steps = [];
    }
  }
  return {
    id: row.id,
    name: row.name,
    publishedRevision: row.revision,
    summary: row.method,
    steps,
    precautions: row.precautions,
    risks: row.risks,
    contraindications: row.contraindications,
    videoResourceId: row.video_resource_id,
    disclaimer: DISCLAIMER
  };
}

/**
 * 患者端 browse 只读仓库（SQLite 实现）。
 *
 * 可见性门禁：content_items 只返回 status='published' 且
 * patient_visible/version_valid/media_available 全部就绪的内容；
 * agent_plans（0009，管理端写入的统一方案表）按设计 §17 双门禁拆分：
 * - 管理端/Agent 匹配门禁：agent_plans.status='enabled'（管理端启用方案）；
 * - 患者浏览可见门禁：planBrowseEnabled（= 临床规则包是否 approved），
 *   由组合根按规则包状态注入，candidate 期间恒 false。
 * 两个门禁相互独立：candidate 期间管理端"启用方案"不再把完整调理方案
 * （含穴位/疗程文本）公开给匿名患者（评审 R2 P1）；approved 后组合根
 * 注入 true 才开放浏览。
 * （agent_care_plans 0007 历史表不再读写，保留在迁移账本中。）
 *
 * 门禁关闭（planBrowseEnabled=false）时方案方法在触达存储前短路返回
 * 空列表/null——这是关闭策略的确定响应，不是"伪装成空列表"；存储读
 * 失败（数据库损坏、连接关闭、锁异常）仍统一映射为 storage_unavailable。
 */
export class SqliteContentReadRepository implements ContentReadRepository {
  private readonly planBrowseEnabled: boolean;

  constructor(
    private readonly database: KangminDatabase,
    options: PlanBrowseVisibility = {}
  ) {
    // 默认 false（fail-closed）：组合根未注入可见性判断时，方案不
    // 对患者开放；规则包 approved 后由组合根传 { planBrowseEnabled: true }。
    this.planBrowseEnabled = options.planBrowseEnabled ?? false;
  }

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
      // 分类统一（评审 A P1-6）：browse 分类清单以管理端维护的
      // content_categories 为准（启用分类），不再对 content_items 的
      // 自由文本 category 做 SELECT DISTINCT；general 分类对文章/视频通用。
      const rows = this.database.connection
        .prepare(`
          SELECT name
          FROM content_categories
          WHERE status = 'active' AND kind IN (?, 'general')
          ORDER BY display_order ASC, name ASC
        `)
        .all(kind) as unknown as Array<{ name: string }>;
      return rows.map((row) => row.name);
    });
  }

  async listPlans(): Promise<CarePlanSummary[]> {
    if (!this.planBrowseEnabled) {
      return [];
    }
    return this.guard(() => this.queryPlans(null, MAX_PLAN_LIST));
  }

  async findPlan(id: string): Promise<CarePlanDetail | null> {
    if (!this.planBrowseEnabled) {
      return null;
    }
    return this.guard(() => {
      const row = this.database.connection
        .prepare(`
          SELECT id, name, revision, method, steps_json,
                 precautions, risks, contraindications, video_resource_id
          FROM agent_plans
          WHERE id = ? AND status = 'enabled'
        `)
        .get(id) as unknown as PlanRow | undefined;
      return row === undefined ? null : toPlanDetail(row);
    });
  }

  async searchPlans(query: string, limit: number): Promise<CarePlanSummary[]> {
    if (!this.planBrowseEnabled) {
      return [];
    }
    return this.guard(() => this.queryPlans(likePatternOf(query), limit));
  }

  async listMessages(patientId: string): Promise<PatientMessage[]> {
    return this.guard(() => {
      const rows = this.database.connection.prepare(`
        SELECT m.id, m.title, m.body, m.summary, m.published_at, r.read_at
        FROM content_messages m
        LEFT JOIN patient_message_reads r
          ON r.message_id = m.id AND r.patient_id = ?
        WHERE m.status = 'published' AND m.published_at IS NOT NULL
        ORDER BY m.published_at DESC, m.id ASC
      `).all(patientId) as unknown as MessageRow[];
      return rows.map(toPatientMessage);
    });
  }

  async findMessage(patientId: string, id: string): Promise<PatientMessage | null> {
    return this.guard(() => {
      const row = this.database.connection.prepare(`
        SELECT m.id, m.title, m.body, m.summary, m.published_at, r.read_at
        FROM content_messages m
        LEFT JOIN patient_message_reads r
          ON r.message_id = m.id AND r.patient_id = ?
        WHERE m.id = ? AND m.status = 'published' AND m.published_at IS NOT NULL
      `).get(patientId, id) as unknown as MessageRow | undefined;
      return row === undefined ? null : toPatientMessage(row);
    });
  }

  async markMessageRead(patientId: string, id: string): Promise<PatientMessage | null> {
    return this.guard(() => this.database.transaction(() => {
      const visible = this.database.connection.prepare(`
        SELECT id FROM content_messages
        WHERE id = ? AND status = 'published' AND published_at IS NOT NULL
      `).get(id);
      if (visible === undefined) {
        return null;
      }
      const readAt = new Date().toISOString();
      this.database.connection.prepare(`
        INSERT INTO patient_message_reads(message_id, patient_id, read_at)
        VALUES (?, ?, ?)
        ON CONFLICT(message_id, patient_id) DO NOTHING
      `).run(id, patientId, readAt);
      const row = this.database.connection.prepare(`
        SELECT m.id, m.title, m.body, m.summary, m.published_at, r.read_at
        FROM content_messages m
        JOIN patient_message_reads r
          ON r.message_id = m.id AND r.patient_id = ?
        WHERE m.id = ?
      `).get(patientId, id) as unknown as MessageRow;
      return toPatientMessage(row);
    }));
  }

  async unreadMessageCount(patientId: string): Promise<number> {
    return this.guard(() => {
      const row = this.database.connection.prepare(`
        SELECT COUNT(*) AS count
        FROM content_messages m
        WHERE m.status = 'published' AND m.published_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM patient_message_reads r
            WHERE r.message_id = m.id AND r.patient_id = ?
          )
      `).get(patientId) as unknown as { count: number };
      return row.count;
    });
  }

  private queryPlans(pattern: string | null, limit: number): CarePlanSummary[] {
    const where =
      pattern === null
        ? "status = 'enabled'"
        : `status = 'enabled' AND name LIKE ? ESCAPE '\\'`;
    const statement = this.database.connection.prepare(`
      SELECT id, name, revision, method, steps_json,
             precautions, risks, contraindications, video_resource_id
      FROM agent_plans
      WHERE ${where}
      ORDER BY display_order ASC, id ASC
      LIMIT ?
    `);
    const rows = (
      pattern === null
        ? statement.all(limit)
        : statement.all(pattern, limit)
    ) as unknown as PlanRow[];
    return rows.map(toPlanSummary);
  }

  /**
   * 公开媒体行（HTTP 媒体路由）：仅当素材被某个 status='published' 的
   * content_item 以 media_id 或 cover_media_id 引用时返回；无引用或
   * 素材不存在一律 null（不泄露存在性）。素材自身可用性（ready）由
   * 服务层判定。媒体公开门禁与方案浏览门禁（planBrowseEnabled）无关，
   * 不受 candidate 短路影响。
   */
  async findPublishedMedia(mediaId: string): Promise<PublishedMediaRef | null> {
    return this.guard(() => {
      const row = this.database.connection
        .prepare(`
          SELECT m.stored_path, m.mime_type, m.status
          FROM content_resource_media m
          WHERE m.id = ?
            AND EXISTS (
              SELECT 1 FROM content_items c
              WHERE c.status = 'published'
                AND (c.media_id = m.id OR c.cover_media_id = m.id)
            )
        `)
        .get(mediaId) as unknown as
        | { stored_path: string; mime_type: string | null; status: string }
        | undefined;
      return row === undefined
        ? null
        : {
            storedPath: row.stored_path,
            mimeType: row.mime_type,
            status: row.status
          };
    });
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
