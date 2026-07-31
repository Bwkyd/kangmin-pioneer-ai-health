import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../../kernel/errors.js";
import type { AdminArticle, ContentAdminRepository } from "./content-admin-repository.js";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class ContentAdminService {
  constructor(private readonly repository: ContentAdminRepository) {}

  async create(adminId: string, input: Omit<AdminArticle, "id" | "status" | "revision" | "publishedAt" | "updatedAt"> & { idempotencyKey: string }) {
    const timestamp = new Date().toISOString();
    const request = { title: input.title, category: input.category, summary: input.summary, body: input.body, source: input.source };
    const outcome = await this.repository.create(adminId, {
      id: randomUUID(), ...request, status: "draft", revision: 1,
      publishedAt: null, updatedAt: timestamp
    }, input.idempotencyKey, hash(request));
    if (outcome.kind === "conflict") throw new DomainError("idempotency_conflict", "相同幂等键已用于不同请求");
    return outcome.article;
  }

  list() { return this.repository.list(); }
  async get(id: string) {
    const article = await this.repository.find(id);
    if (article === null) throw new DomainError("resource_not_found", "文章不存在");
    return article;
  }

  async update(id: string, expectedRevision: number, changes: Partial<Pick<AdminArticle, "title" | "category" | "summary" | "body" | "source">>) {
    const current = await this.get(id);
    if (Object.keys(changes).length === 0) throw new DomainError("validation_failed", "至少提供一个需要更新的字段");
    return this.commit({ ...current, ...changes, revision: current.revision + 1, updatedAt: new Date().toISOString() }, expectedRevision);
  }

  async publish(id: string, expectedRevision: number) {
    const current = await this.get(id);
    if (current.status === "published") {
      throw new DomainError("validation_failed", "文章已经发布");
    }
    for (const [field, value] of Object.entries({ title: current.title, category: current.category, summary: current.summary, body: current.body, source: current.source })) {
      if (value.trim() === "") throw new DomainError("validation_failed", `发布前 ${field} 不能为空`);
    }
    const timestamp = new Date().toISOString();
    return this.commit({ ...current, status: "published", revision: current.revision + 1, publishedAt: timestamp, updatedAt: timestamp }, expectedRevision);
  }

  async unpublish(id: string, expectedRevision: number) {
    const current = await this.get(id);
    if (current.status !== "published") {
      throw new DomainError("validation_failed", "只有已发布文章可以下架");
    }
    return this.commit({ ...current, status: "unpublished", revision: current.revision + 1, updatedAt: new Date().toISOString() }, expectedRevision);
  }

  private async commit(article: AdminArticle, expectedRevision: number) {
    const outcome = await this.repository.update(article, expectedRevision);
    if (outcome.kind === "not_found") throw new DomainError("resource_not_found", "文章不存在");
    if (outcome.kind === "version_conflict") throw new DomainError("version_conflict", "文章已更新，请重新读取", { details: { expectedRevision, currentRevision: outcome.currentRevision } });
    return outcome.article;
  }
}
