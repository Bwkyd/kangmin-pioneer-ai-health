import { KangminDatabase } from "./database.js";
import type { AdminArticle, ContentAdminRepository } from "../modules/admin/content-admin-repository.js";

interface Row { id: string; title: string; category: string; summary: string; body: string; source: string; status: AdminArticle["status"]; revision: number; published_at: string | null; updated_at: string; }
const map = (row: Row): AdminArticle => ({ ...row, publishedAt: row.published_at, updatedAt: row.updated_at });

export class SqliteContentAdminRepository implements ContentAdminRepository {
  constructor(private readonly database: KangminDatabase) {}
  async create(adminId: string, article: AdminArticle, key: string, requestHash: string) {
    return this.database.transaction(() => {
      const replay = this.database.connection.prepare("SELECT request_hash, result_json FROM admin_idempotency WHERE admin_id=? AND scope='content.article.create' AND idempotency_key=?").get(adminId, key) as unknown as { request_hash: string; result_json: string } | undefined;
      if (replay !== undefined) return replay.request_hash === requestHash ? { kind: "replayed" as const, article: JSON.parse(replay.result_json) as AdminArticle } : { kind: "conflict" as const };
      this.database.connection.prepare(`INSERT INTO content_items(id,kind,title,category,summary,body,source,cover_url,media_url,status,patient_visible,version_valid,media_available,published_at,updated_at,revision,created_by) VALUES (?,'article',?,?,?,?,?,NULL,NULL,'draft',0,1,1,NULL,?,1,?)`).run(article.id, article.title, article.category, article.summary, article.body, article.source, article.updatedAt, adminId);
      this.database.connection.prepare("INSERT INTO admin_idempotency(admin_id,scope,idempotency_key,request_hash,result_json,created_at) VALUES (?,'content.article.create',?,?,?,?)").run(adminId, key, requestHash, JSON.stringify(article), article.updatedAt);
      return { kind: "created" as const, article };
    });
  }
  async list() { return (this.database.connection.prepare("SELECT id,title,category,summary,body,source,status,revision,published_at,updated_at FROM content_items WHERE kind='article' ORDER BY updated_at DESC").all() as unknown as Row[]).map(map); }
  async find(id: string) { const row = this.database.connection.prepare("SELECT id,title,category,summary,body,source,status,revision,published_at,updated_at FROM content_items WHERE kind='article' AND id=?").get(id) as unknown as Row | undefined; return row === undefined ? null : map(row); }
  async update(article: AdminArticle, expectedRevision: number) {
    return this.database.transaction(() => {
      const current = this.database.connection.prepare("SELECT revision FROM content_items WHERE kind='article' AND id=?").get(article.id) as unknown as { revision: number } | undefined;
      if (current === undefined) return { kind: "not_found" as const };
      if (current.revision !== expectedRevision) return { kind: "version_conflict" as const, currentRevision: current.revision };
      const result = this.database.connection.prepare(`UPDATE content_items SET title=?,category=?,summary=?,body=?,source=?,status=?,patient_visible=?,published_at=?,updated_at=?,revision=? WHERE id=? AND kind='article' AND revision=?`).run(article.title,article.category,article.summary,article.body,article.source,article.status,article.status === "published" ? 1 : 0,article.publishedAt,article.updatedAt,article.revision,article.id,expectedRevision);
      if (result.changes !== 1) return { kind: "version_conflict" as const, currentRevision: current.revision };
      return { kind: "updated" as const, article };
    });
  }
}
