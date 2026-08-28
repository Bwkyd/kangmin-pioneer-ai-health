import { createHash, randomUUID } from "node:crypto";

import { DomainError } from "../../kernel/errors.js";
import type { AuditPort } from "../system/audit-ports.js";
import type {
  ContentAuxRepository,
  ContentMessageRow,
  MessageStatus
} from "./content-aux-repository.js";

type OptionalOf<T> = { [K in keyof T]?: T[K] | undefined };

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function now(): string {
  return new Date().toISOString();
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireChange(changes: Record<string, unknown>): void {
  if (Object.keys(changes).length === 0) {
    throw new DomainError("validation_failed", "至少提供一个需要更新的字段");
  }
}

/** 站内公告的状态、审计和事务边界，独立于素材上传流程。 */
export class ContentMessageService {
  constructor(
    private readonly repository: ContentAuxRepository,
    private readonly audit: AuditPort
  ) {}

  async createMessage(
    adminId: string,
    input: {
      title: string;
      body: string;
      summary?: string | undefined;
      categoryId?: string | undefined;
    },
    idempotencyKey: string,
    requestId?: string
  ): Promise<ContentMessageRow> {
    const title = input.title.trim();
    const body = input.body.trim();
    if (title === "") throw new DomainError("validation_failed", "公告标题不能为空");
    if (body === "") throw new DomainError("validation_failed", "公告正文不能为空");
    return this.repository.transaction(async () => {
      const timestamp = now();
      const message: ContentMessageRow = {
        id: newId("msg"),
        title,
        body,
        summary: input.summary?.trim() || null,
        categoryId: input.categoryId ?? null,
        status: "draft",
        revision: 1,
        publishedAt: null,
        createdBy: adminId,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const outcome = await this.repository.createMessageIdempotent(
        adminId,
        message,
        idempotencyKey,
        hash({
          title,
          body,
          summary: input.summary?.trim() || null,
          categoryId: input.categoryId ?? null
        })
      );
      if (outcome.kind === "conflict") {
        throw new DomainError("idempotency_conflict", "相同幂等键已用于不同请求");
      }
      if (outcome.kind === "stale_replay") {
        throw new DomainError("stale_replay", "相同幂等键对应的公告已不存在");
      }
      if (outcome.kind === "created") {
        await this.audit.record({
          actorKind: "admin",
          actorId: adminId,
          action: "content.message.create",
          entityType: "content_message",
          entityId: message.id,
          entityRevision: message.revision,
          requestId,
          details: {
            status: message.status,
            hasBody: message.body.trim() !== "",
            hasSummary: message.summary !== null,
            hasCategory: message.categoryId !== null
          }
        });
      }
      return outcome.item;
    });
  }

  async listMessages(status?: string): Promise<ContentMessageRow[]> {
    return this.repository.listMessages(
      status === undefined ? undefined : (status as MessageStatus)
    );
  }

  async getMessage(id: string): Promise<ContentMessageRow> {
    const message = await this.repository.findMessage(id);
    if (message === null) throw new DomainError("resource_not_found", "公告不存在");
    return message;
  }

  async updateMessage(
    adminId: string,
    id: string,
    expectedRevision: number,
    changes: OptionalOf<Pick<ContentMessageRow, "title" | "body" | "summary" | "categoryId">>,
    requestId?: string
  ): Promise<ContentMessageRow> {
    requireChange(changes);
    return this.repository.transaction(async () => {
      const current = await this.getMessage(id);
      const next: ContentMessageRow = {
        ...current,
        title: changes.title ?? current.title,
        body: changes.body ?? current.body,
        summary: changes.summary === undefined ? current.summary : changes.summary,
        categoryId: changes.categoryId === undefined ? current.categoryId : changes.categoryId,
        status: current.status === "published" ? "draft" : current.status,
        publishedAt: current.status === "published" ? null : current.publishedAt,
        revision: current.revision + 1,
        updatedAt: now()
      };
      const updated = this.messageOutcome(
        await this.repository.updateMessage(next, expectedRevision),
        expectedRevision
      );
      await this.audit.record({
        actorKind: "admin",
        actorId: adminId,
        action: "content.message.update",
        entityType: "content_message",
        entityId: id,
        entityRevision: updated.revision,
        requestId,
        details: {
          status: updated.status,
          previousStatus: current.status,
          changedFields: Object.keys(changes).sort(),
          hasBody: updated.body.trim() !== "",
          hasSummary: updated.summary !== null,
          hasCategory: updated.categoryId !== null
        }
      });
      return updated;
    });
  }

  async publishMessage(
    adminId: string,
    id: string,
    expectedRevision: number,
    requestId?: string
  ): Promise<ContentMessageRow> {
    return this.repository.transaction(async () => {
      const current = await this.getMessage(id);
      if (current.status === "published") {
        throw new DomainError("validation_failed", "公告已经发布");
      }
      if (current.title.trim() === "" || current.body.trim() === "") {
        throw new DomainError("validation_failed", "发布前公告标题和正文不能为空");
      }
      const timestamp = now();
      const published = this.messageOutcome(
        await this.repository.setMessageStatus(
          id,
          expectedRevision,
          "published",
          timestamp,
          timestamp
        ),
        expectedRevision
      );
      await this.audit.record({
        actorKind: "admin",
        actorId: adminId,
        action: "content.message.publish",
        entityType: "content_message",
        entityId: id,
        entityRevision: published.revision,
        requestId,
        details: { status: "published" }
      });
      return published;
    });
  }

  async unpublishMessage(
    adminId: string,
    id: string,
    expectedRevision: number,
    requestId?: string
  ): Promise<ContentMessageRow> {
    return this.repository.transaction(async () => {
      const current = await this.getMessage(id);
      if (current.status !== "published") {
        throw new DomainError("validation_failed", "只有已发布公告可以下架");
      }
      const unpublished = this.messageOutcome(
        await this.repository.setMessageStatus(
          id,
          expectedRevision,
          "unpublished",
          null,
          now()
        ),
        expectedRevision
      );
      await this.audit.record({
        actorKind: "admin",
        actorId: adminId,
        action: "content.message.unpublish",
        entityType: "content_message",
        entityId: id,
        entityRevision: unpublished.revision,
        requestId,
        details: { status: "unpublished" }
      });
      return unpublished;
    });
  }

  private messageOutcome(
    outcome:
      | { kind: "updated"; message: ContentMessageRow }
      | { kind: "not_found" }
      | { kind: "version_conflict"; currentRevision: number },
    expectedRevision: number
  ): ContentMessageRow {
    if (outcome.kind === "not_found") {
      throw new DomainError("resource_not_found", "公告不存在");
    }
    if (outcome.kind === "version_conflict") {
      throw new DomainError("version_conflict", "公告已更新，请重新读取", {
        details: { expectedRevision, currentRevision: outcome.currentRevision }
      });
    }
    return outcome.message;
  }
}
