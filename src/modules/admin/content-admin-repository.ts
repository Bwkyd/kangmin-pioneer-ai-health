export interface AdminArticle {
  id: string; title: string; category: string; summary: string;
  body: string; source: string; status: "draft" | "published" | "unpublished";
  revision: number; publishedAt: string | null; updatedAt: string;
}

export interface ContentAdminRepository {
  create(adminId: string, article: AdminArticle, idempotencyKey: string, requestHash: string): Promise<{ kind: "created" | "replayed"; article: AdminArticle } | { kind: "conflict" }>;
  list(): Promise<AdminArticle[]>;
  find(id: string): Promise<AdminArticle | null>;
  update(article: AdminArticle, expectedRevision: number): Promise<{ kind: "updated"; article: AdminArticle } | { kind: "not_found" } | { kind: "version_conflict"; currentRevision: number }>;
}
