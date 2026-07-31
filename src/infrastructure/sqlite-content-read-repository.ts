import { KangminDatabase } from "./database.js";
import type { ContentReadRepository } from "../modules/browse/content-read-repository.js";
import type {
  PublicContent,
  PublicContentKind
} from "../modules/browse/contracts.js";

const DISCLAIMER = "本内容仅作健康科普和居家管理参考，不代替门诊诊断和专业医疗建议。";
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

export class SqliteContentReadRepository implements ContentReadRepository {
  constructor(private readonly database: KangminDatabase) {}

  async list(kind: PublicContentKind): Promise<PublicContent[]> {
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
  }

  async find(
    kind: PublicContentKind,
    id: string
  ): Promise<PublicContent | null> {
    const row = this.database.connection
      .prepare(`
        SELECT id, kind, title, category, summary, body, source,
               cover_url, media_url, published_at, updated_at
        FROM content_items
        WHERE kind = ? AND id = ? AND ${PUBLIC_PREDICATE}
      `)
      .get(kind, id) as unknown as ContentRow | undefined;
    return row === undefined ? null : toPublicContent(row);
  }

  async search(
    kind: PublicContentKind,
    query: string
  ): Promise<PublicContent[]> {
    const escaped = query.replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const pattern = `%${escaped}%`;
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
  }

  async categories(kind: PublicContentKind): Promise<string[]> {
    const rows = this.database.connection
      .prepare(`
        SELECT DISTINCT category
        FROM content_items
        WHERE kind = ? AND ${PUBLIC_PREDICATE}
        ORDER BY category ASC
      `)
      .all(kind) as unknown as Array<{ category: string }>;
    return rows.map((row) => row.category);
  }
}
