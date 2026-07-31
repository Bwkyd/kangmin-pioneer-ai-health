import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../../kernel/errors.js";
import type { AuditPort } from "../system/audit-ports.js";
import type { ContentAuxRepository } from "./content-aux-repository.js";
import type {
  AdminContentItem,
  ContentAdminRepository,
  ContentItemKind
} from "./content-admin-repository.js";

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface PreviewView extends AdminContentItem {
  validation: { ok: boolean; missing: string[] };
  patientVisible: boolean;
}

type OptionalOf<T> = { [K in keyof T]?: T[K] | undefined };

export type ContentItemChanges = OptionalOf<
  Pick<
    AdminContentItem,
    | "title"
    | "category"
    | "summary"
    | "body"
    | "source"
    | "coverMediaId"
    | "mediaId"
    | "instructions"
    | "precautions"
    | "disclaimer"
    | "methodTags"
    | "displayOrder"
  >
>;

export type CreateContentInput = Omit<
  AdminContentItem,
  "id" | "kind" | "status" | "revision" | "publishedAt" | "updatedAt"
> & { idempotencyKey: string };

/** 内部修订指针语义：update 只改当前修订，published_revision 指针不动。 */
export class ContentAdminService {
  constructor(
    private readonly repository: ContentAdminRepository,
    private readonly aux: ContentAuxRepository,
    private readonly audit: AuditPort
  ) {}

  // ==== 文章（#135 兼容，扩展媒体/分类校验） ====

  async create(adminId: string, input: CreateContentInput) {
    const timestamp = new Date().toISOString();
    const request = this.businessFields(input);
    const item: AdminContentItem = {
      id: randomUUID(),
      kind: "article",
      ...request,
      status: "draft",
      revision: 1,
      publishedAt: null,
      updatedAt: timestamp
    };
    const outcome = await this.repository.create(
      adminId,
      item,
      input.idempotencyKey,
      hash(request)
    );
    if (outcome.kind === "conflict") {
      throw new DomainError("idempotency_conflict", "相同幂等键已用于不同请求");
    }
    if (outcome.kind === "stale_replay") {
      throw new DomainError("stale_replay", "相同幂等键对应的内容已不存在");
    }
    return outcome.item;
  }

  async list(status?: "draft" | "published" | "unpublished") {
    return this.repository.list("article", status);
  }

  async get(id: string): Promise<AdminContentItem> {
    const item = await this.repository.find("article", id);
    if (item === null) {
      throw new DomainError("resource_not_found", "文章不存在");
    }
    return item;
  }

  async preview(id: string): Promise<PreviewView> {
    return this.previewOf("article", id);
  }

  async update(
    id: string,
    expectedRevision: number,
    changes: ContentItemChanges
  ): Promise<AdminContentItem> {
    return this.updateItem("article", id, expectedRevision, changes);
  }

  async publish(
    adminId: string,
    id: string,
    expectedRevision: number
  ): Promise<AdminContentItem> {
    return this.publishItem(adminId, "article", id, expectedRevision);
  }

  async unpublish(
    adminId: string,
    id: string,
    expectedRevision: number
  ): Promise<AdminContentItem> {
    return this.unpublishItem(adminId, "article", id, expectedRevision);
  }

  // ==== 视频 ====

  async createVideo(adminId: string, input: CreateContentInput) {
    const timestamp = new Date().toISOString();
    const request = this.businessFields(input);
    const item: AdminContentItem = {
      id: randomUUID(),
      kind: "video",
      ...request,
      status: "draft",
      revision: 1,
      publishedAt: null,
      updatedAt: timestamp
    };
    const outcome = await this.repository.create(
      adminId,
      item,
      input.idempotencyKey,
      hash(request)
    );
    if (outcome.kind === "conflict") {
      throw new DomainError("idempotency_conflict", "相同幂等键已用于不同请求");
    }
    if (outcome.kind === "stale_replay") {
      throw new DomainError("stale_replay", "相同幂等键对应的内容已不存在");
    }
    return outcome.item;
  }

  async listVideos(status?: "draft" | "published" | "unpublished") {
    return this.repository.list("video", status);
  }

  async getVideo(id: string): Promise<AdminContentItem> {
    const item = await this.repository.find("video", id);
    if (item === null) {
      throw new DomainError("resource_not_found", "视频不存在");
    }
    return item;
  }

  async previewVideo(id: string): Promise<PreviewView> {
    return this.previewOf("video", id);
  }

  async updateVideo(
    id: string,
    expectedRevision: number,
    changes: ContentItemChanges
  ): Promise<AdminContentItem> {
    return this.updateItem("video", id, expectedRevision, changes);
  }

  async publishVideo(
    adminId: string,
    id: string,
    expectedRevision: number
  ): Promise<AdminContentItem> {
    return this.publishItem(adminId, "video", id, expectedRevision);
  }

  async unpublishVideo(
    adminId: string,
    id: string,
    expectedRevision: number
  ): Promise<AdminContentItem> {
    return this.unpublishItem(adminId, "video", id, expectedRevision);
  }

  // ==== 内部 ====

  private businessFields(input: CreateContentInput) {
    return {
      title: input.title,
      category: input.category,
      summary: input.summary,
      body: input.body,
      source: input.source,
      coverMediaId: input.coverMediaId,
      mediaId: input.mediaId,
      instructions: input.instructions,
      precautions: input.precautions,
      disclaimer: input.disclaimer,
      methodTags: [...input.methodTags],
      displayOrder: input.displayOrder
    };
  }

  private async previewOf(
    kind: ContentItemKind,
    id: string
  ): Promise<PreviewView> {
    const item =
      kind === "article" ? await this.get(id) : await this.getVideo(id);
    const missing = await this.validateForPublish(item);
    return {
      ...item,
      validation: { ok: missing.length === 0, missing },
      patientVisible: item.status === "published"
    };
  }

  private async updateItem(
    kind: ContentItemKind,
    id: string,
    expectedRevision: number,
    changes: ContentItemChanges
  ): Promise<AdminContentItem> {
    const current =
      kind === "article" ? await this.get(id) : await this.getVideo(id);
    if (Object.keys(changes).length === 0) {
      throw new DomainError("validation_failed", "至少提供一个需要更新的字段");
    }
    // 显式 undefined 表示未提供（继承当前值），不能覆盖现有字段。
    const provided: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) {
        provided[key] = value;
      }
    }
    return this.commitItem(
      {
        ...current,
        ...(provided as Partial<AdminContentItem>),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString()
      },
      expectedRevision
    );
  }

  private async publishItem(
    adminId: string,
    kind: ContentItemKind,
    id: string,
    expectedRevision: number
  ): Promise<AdminContentItem> {
    const current =
      kind === "article" ? await this.get(id) : await this.getVideo(id);
    if (current.status === "published") {
      throw new DomainError("validation_failed", "内容已经发布");
    }
    const missing = await this.validateForPublish(current);
    if (missing.length > 0) {
      throw new DomainError(
        "validation_failed",
        `发布前校验未通过：${missing.join("、")}`
      );
    }
    const timestamp = new Date().toISOString();
    const published = await this.commitItem(
      {
        ...current,
        status: "published",
        revision: current.revision + 1,
        publishedAt: timestamp,
        updatedAt: timestamp
      },
      expectedRevision
    );
    await this.audit.record({
      actorKind: "admin",
      actorId: adminId,
      action: `content.${kind}.publish`,
      entityType: "content_item",
      entityId: id,
      entityRevision: published.revision,
      details: { status: "published" }
    });
    return published;
  }

  private async unpublishItem(
    adminId: string,
    kind: ContentItemKind,
    id: string,
    expectedRevision: number
  ): Promise<AdminContentItem> {
    const current =
      kind === "article" ? await this.get(id) : await this.getVideo(id);
    if (current.status !== "published") {
      throw new DomainError("validation_failed", "只有已发布内容可以下架");
    }
    const unpublished = await this.commitItem(
      {
        ...current,
        status: "unpublished",
        revision: current.revision + 1,
        updatedAt: new Date().toISOString()
      },
      expectedRevision
    );
    await this.audit.record({
      actorKind: "admin",
      actorId: adminId,
      action: `content.${kind}.unpublish`,
      entityType: "content_item",
      entityId: id,
      entityRevision: unpublished.revision,
      details: { status: "unpublished" }
    });
    return unpublished;
  }

  /**
   * 发布前程序校验：标题/分类/摘要/来源非空、文章或公告正文非空、
   * 视频必须引用可用视频素材、封面素材可用、分类有效（存在时不得停用
   * 或类型不符）、不引用已停用媒体。
   */
  private async validateForPublish(item: AdminContentItem): Promise<string[]> {
    const missing: string[] = [];
    for (const [field, value] of Object.entries({
      标题: item.title,
      分类: item.category,
      摘要: item.summary,
      来源: item.source
    })) {
      if (value.trim() === "") {
        missing.push(field);
      }
    }
    if (item.body.trim() === "") {
      missing.push("正文");
    }
    if (item.kind === "video" && item.mediaId === null) {
      missing.push("视频文件");
    }

    if (item.category.trim() !== "") {
      const category = await this.aux.findCategoryByName(item.category);
      if (category !== null) {
        if (category.status !== "active") {
          missing.push("分类已停用");
        } else if (
          category.kind !== "general" &&
          category.kind !== item.kind
        ) {
          missing.push("分类类型不符");
        }
      }
    }

    for (const mediaId of [item.coverMediaId, item.mediaId]) {
      if (mediaId === null) {
        continue;
      }
      const media = await this.aux.findMedia(mediaId);
      if (media === null) {
        missing.push("引用的素材不存在");
      } else if (media.status !== "ready") {
        missing.push(
          media.status === "disabled" ? "引用的素材已停用" : "引用的素材未就绪"
        );
      } else if (
        item.kind === "video" &&
        media.id === item.mediaId &&
        media.kind !== "video"
      ) {
        missing.push("视频文件类型不符");
      }
    }
    return missing;
  }

  private async commitItem(
    item: AdminContentItem,
    expectedRevision: number
  ): Promise<AdminContentItem> {
    const outcome = await this.repository.update(item, expectedRevision);
    if (outcome.kind === "not_found") {
      throw new DomainError("resource_not_found", "内容不存在");
    }
    if (outcome.kind === "version_conflict") {
      throw new DomainError("version_conflict", "内容已更新，请重新读取", {
        details: {
          expectedRevision,
          currentRevision: outcome.currentRevision
        }
      });
    }
    return outcome.item;
  }
}
