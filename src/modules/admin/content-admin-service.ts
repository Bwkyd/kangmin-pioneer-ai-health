import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../../kernel/errors.js";
import type { AuditPort } from "../system/audit-ports.js";
import type { ContentAuxRepository } from "./content-aux-repository.js";
import type {
  AdminContentItem,
  ContentAdminRepository,
  ContentItemKind,
  PublishGuardState,
  UpdateGuardedResult
} from "./content-admin-repository.js";
import { mediaIdsInContentBody } from "../content-body-references.js";

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
    | "categoryIds"
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
    const category = await this.categoryDisplay("article", input.categoryIds);
    const timestamp = new Date().toISOString();
    const request = { ...this.businessFields(input), category };
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
    expectedRevision: number,
    requestId?: string
  ): Promise<AdminContentItem> {
    return this.publishItem(adminId, "article", id, expectedRevision, requestId);
  }

  async unpublish(
    adminId: string,
    id: string,
    expectedRevision: number,
    requestId?: string
  ): Promise<AdminContentItem> {
    return this.unpublishItem(adminId, "article", id, expectedRevision, requestId);
  }

  // ==== 视频 ====

  async createVideo(adminId: string, input: CreateContentInput) {
    const category = await this.categoryDisplay("video", input.categoryIds);
    const timestamp = new Date().toISOString();
    const request = { ...this.businessFields(input), category };
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

  async categoryRegistry(kind: ContentItemKind) {
    return this.repository.listCategoryRegistry(kind);
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
    expectedRevision: number,
    requestId?: string
  ): Promise<AdminContentItem> {
    return this.publishItem(adminId, "video", id, expectedRevision, requestId);
  }

  async unpublishVideo(
    adminId: string,
    id: string,
    expectedRevision: number,
    requestId?: string
  ): Promise<AdminContentItem> {
    return this.unpublishItem(adminId, "video", id, expectedRevision, requestId);
  }

  // ==== 内部 ====

  private businessFields(input: CreateContentInput) {
    return {
      title: input.title,
      category: input.category,
      categoryIds: [...new Set(input.categoryIds)],
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
    if (changes.categoryIds !== undefined) {
      provided.category = await this.categoryDisplay(kind, changes.categoryIds);
    }
    return this.commitItem(
      {
        ...current,
        ...(provided as Partial<AdminContentItem>),
        // 已发布内容被修改必须置回草稿：患者端展示的是已校验版本，
        // 未校验的新修改不能继续对患者可见。published_at 清空，
        // patient_visible 由仓储按 status 派生为 0（update 的 SQL 中
        // patient_visible = status === 'published' ? 1 : 0）。
        ...(current.status === "published"
          ? { status: "draft" as const, publishedAt: null }
          : {}),
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
    expectedRevision: number,
    requestId?: string
  ): Promise<AdminContentItem> {
    const current =
      kind === "article" ? await this.get(id) : await this.getVideo(id);
    if (current.status === "published") {
      throw new DomainError("validation_failed", "内容已经发布");
    }
    // 静态字段校验（标题/分类/摘要/来源/正文/视频文件）不依赖数据库；
    // 依赖（分类/素材）状态由仓储在同一事务内快照并校验
    // （repository.updateGuarded），消除校验与提交之间的并发窗口。
    const staticMissing = this.staticPublishMissing(current);
    if (staticMissing.length > 0) {
      throw new DomainError(
        "validation_failed",
        `发布前校验未通过：${staticMissing.join("、")}`
      );
    }
    const timestamp = new Date().toISOString();
    const outcome = await this.repository.updateGuarded(
      {
        ...current,
        status: "published",
        revision: current.revision + 1,
        publishedAt: timestamp,
        updatedAt: timestamp
      },
      expectedRevision,
      (state) => this.dependencyMissing(current, state)
    );
    const published = this.guardedOutcome(outcome, expectedRevision);
    await this.audit.record({
      actorKind: "admin",
      actorId: adminId,
      action: `content.${kind}.publish`,
      entityType: "content_item",
      entityId: id,
      entityRevision: published.revision,
      requestId,
      details: { status: "published" }
    });
    return published;
  }

  private async unpublishItem(
    adminId: string,
    kind: ContentItemKind,
    id: string,
    expectedRevision: number,
    requestId?: string
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
      requestId,
      details: { status: "unpublished" }
    });
    return unpublished;
  }

  /** 写入只接受稳定分类 ID；category 仅由注册表路径派生用于展示。 */
  private async categoryDisplay(kind: ContentItemKind, categoryIds: readonly string[]): Promise<string> {
    const ids = [...new Set(categoryIds)];
    const registry = await this.repository.listCategoryRegistry(kind);
    const byId = new Map(registry.map((category) => [category.id, category]));
    for (const id of ids) {
      const category = byId.get(id);
      if (category === undefined) {
        const otherKind = kind === "article" ? "video" : "article";
        const belongsToOtherKind = (await this.repository.listCategoryRegistry(otherKind))
          .some((candidate) => candidate.id === id);
        if (belongsToOtherKind) {
          throw new DomainError("validation_failed", `分类 ID「${id}」与${kind === "article" ? "文章" : "视频"}类型不符`);
        }
        throw new DomainError("validation_failed", `${kind === "article" ? "文章" : "视频"}分类 ID「${id}」不存在`);
      }
      if (!category.selectable || category.status !== "active") {
        throw new DomainError("validation_failed", `分类「${category.name}」当前不可选择`);
      }
    }
    return ids.map((id) => {
      const names: string[] = [];
      let current = byId.get(id);
      while (current !== undefined) {
        names.unshift(current.name);
        current = current.parentId === null ? undefined : byId.get(current.parentId);
      }
      return names.join(" / ");
    }).join("；");
  }

  /**
   * 发布前程序校验（preview 用）：静态字段校验 + 依赖状态校验。
   * 发布路径的依赖校验由 repository.updateGuarded 在事务内完成
   * （dependencyMissing），本方法仅供 preview 完整展示缺失清单。
   */
  private async validateForPublish(item: AdminContentItem): Promise<string[]> {
    const missing = this.staticPublishMissing(item);
    {
      const registry = await this.repository.listCategoryRegistry(item.kind);
      const selected = registry.filter((category) => item.categoryIds.includes(category.id));
      if (selected.length !== item.categoryIds.length) missing.push("分类不存在");
      if (selected.some((category) => !category.selectable)) missing.push("分类不可选择");
      if (selected.some((category) => category.status !== "active")) missing.push("分类已停用");
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
    for (const mediaId of mediaIdsInContentBody(item.body)) {
      const media = await this.aux.findMedia(mediaId);
      if (media === null) {
        missing.push("正文引用的素材不存在");
      } else if (media.status !== "ready") {
        missing.push(
          media.status === "disabled" ? "正文引用的素材已停用" : "正文引用的素材未就绪"
        );
      }
    }
    return missing;
  }

  /** 静态字段校验：不依赖数据库，事务内外均可执行。 */
  private staticPublishMissing(item: AdminContentItem): string[] {
    const missing: string[] = [];
    for (const [field, value] of Object.entries({
      标题: item.title,
      摘要: item.summary,
      来源: item.source
    })) {
      if (value.trim() === "") {
        missing.push(field);
      }
    }
    if (item.categoryIds.length === 0) {
      missing.push("分类");
    }
    if (item.body.trim() === "") {
      missing.push("正文");
    }
    if (item.kind === "video" && item.mediaId === null) {
      missing.push("视频文件");
    }
    if (item.kind === "video") {
      if (item.instructions.trim() === "") missing.push("操作提示");
      if (item.precautions.trim() === "") missing.push("注意事项");
    }
    return missing;
  }

  /** 依赖校验（纯函数）：状态由仓储在事务内快照，与提交原子。 */
  private dependencyMissing(
    item: AdminContentItem,
    state: PublishGuardState
  ): string[] {
    const missing: string[] = [];
    {
      if (state.categories.length !== item.categoryIds.length) {
        missing.push("分类不存在");
      } else if (state.categories.some((category) => category.kind !== item.kind)) {
        missing.push("分类类型不符");
      } else if (state.categories.some((category) => !category.selectable)) {
        missing.push("分类不可选择");
      } else if (state.categories.some((category) => category.status !== "active")) {
        missing.push("分类已停用");
      }
    }
    const mediaChecks: Array<{ media: PublishGuardState["media"]; videoFile: boolean }> = [
      { media: state.coverMedia, videoFile: false },
      { media: state.media, videoFile: item.kind === "video" }
    ];
    for (const { media, videoFile } of mediaChecks) {
      if (media === null) {
        continue;
      }
      if (!media.found) {
        missing.push("引用的素材不存在");
      } else if (media.status !== "ready") {
        missing.push(
          media.status === "disabled" ? "引用的素材已停用" : "引用的素材未就绪"
        );
      } else if (videoFile && media.kind !== "video") {
        missing.push("视频文件类型不符");
      }
    }
    for (const media of state.bodyMedia) {
      if (!media.found) {
        missing.push("正文引用的素材不存在");
      } else if (media.status !== "ready") {
        missing.push(
          media.status === "disabled" ? "正文引用的素材已停用" : "正文引用的素材未就绪"
        );
      }
    }
    return missing;
  }

  private guardedOutcome(
    outcome: UpdateGuardedResult,
    expectedRevision: number
  ): AdminContentItem {
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
    if (outcome.kind === "validation_failed") {
      throw new DomainError(
        "validation_failed",
        `发布前校验未通过：${outcome.missing.join("、")}`
      );
    }
    return outcome.item;
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
