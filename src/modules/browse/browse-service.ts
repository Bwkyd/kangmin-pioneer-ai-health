import { DomainError } from "../../kernel/errors.js";
import type { ContentReadRepository } from "./content-read-repository.js";
import type {
  BrowseHome,
  BrowseHomeEnvironment,
  BrowseSearchResults,
  CarePlanDetail,
  CarePlanSummary,
  PublicContent,
  PublicContentKind,
  PublishedMedia
} from "./contracts.js";
import type { EnvironmentSnapshot } from "../environment/environment-ports.js";
import type { ObjectStoragePort } from "../system/object-storage-ports.js";

/** browse 首页需要的最小环境能力（由应用层注入 EnvironmentService）。 */
export interface BrowseEnvironmentPort {
  current(location: string): Promise<EnvironmentSnapshot>;
}

/**
 * 媒体响应 Content-Type 白名单：只收具体类型（历史或外部写入的行可能
 * 存具体 mime）。为空或不在白名单一律 application/octet-stream——
 * 绝不原样反射库存值（防 text/html 等可被浏览器执行的类型注入）。
 * 上传白名单通配形式（image/*、video/*）不在这里直发，见下方扩展名映射。
 */
const SERVABLE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown"
]);

/**
 * 通配库存 mime 按 storedPath 扩展名映射的具体 Content-Type：库存
 * mime_type 是上传白名单通配形式（image/*、video/*），浏览器不识别
 * 通配形式，必须下发具体类型。
 */
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8"
};

function servableContentType(mimeType: string | null, storedPath: string): string {
  // 通配 mime（含 *）：按对象键扩展名映射具体类型（storedPath 形如
  // `<med_id>/<原始文件名>`）；映射不到一律回退 application/octet-stream，
  // 不下发非标准通配形式。
  if (mimeType !== null && mimeType.includes("*")) {
    const extension = storedPath.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
    return EXTENSION_CONTENT_TYPES[extension] ?? "application/octet-stream";
  }
  return mimeType !== null && SERVABLE_CONTENT_TYPES.has(mimeType)
    ? mimeType
    : "application/octet-stream";
}

export class BrowseService {
  constructor(
    private readonly repository: ContentReadRepository,
    private readonly environment: BrowseEnvironmentPort,
    private readonly objectStorage?: ObjectStoragePort | undefined
  ) {}

  async home(location?: string): Promise<BrowseHome> {
    const [articles, videos, articleCategories, videoCategories] =
      await Promise.all([
        this.repository.list("article"),
        this.repository.list("video"),
        this.repository.categories("article"),
        this.repository.categories("video")
      ]);
    return {
      articles: articles.slice(0, 3),
      videos: videos.slice(0, 3),
      recentlyUpdated: [...articles, ...videos]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 6),
      categories: {
        articles: articleCategories,
        videos: videoCategories
      },
      environment: await this.environmentBlock(location)
    };
  }

  /**
   * 环境区块三态：未指定位置 → no_location（不取数）；DomainError →
   * unavailable（环境数据源故障不拖垮首页其余区块）；非领域错误继续上抛。
   */
  private async environmentBlock(
    location?: string
  ): Promise<BrowseHomeEnvironment> {
    if (location === undefined) {
      return { status: "no_location" };
    }
    try {
      return { status: "ok", current: await this.environment.current(location) };
    } catch (error) {
      if (error instanceof DomainError) {
        return { status: "unavailable", code: error.code };
      }
      throw error;
    }
  }

  async list(kind: PublicContentKind): Promise<PublicContent[]> {
    return this.repository.list(kind);
  }

  /** 分页列表：limit 上限 100（超出在 application 层截断），offset 非负。 */
  async listPage(
    kind: PublicContentKind,
    limit: number,
    offset: number
  ): Promise<PublicContent[]> {
    return this.repository.listPage(kind, limit, offset);
  }

  async categories(kind: PublicContentKind): Promise<string[]> {
    return this.repository.categories(kind);
  }

  async search(
    kind: PublicContentKind,
    query: string
  ): Promise<PublicContent[]> {
    return this.repository.search(kind, query);
  }

  async get(kind: PublicContentKind, id: string): Promise<PublicContent> {
    const content = await this.repository.find(kind, id);
    if (content === null) {
      throw new DomainError("resource_not_found", "内容不存在或当前不可见");
    }
    return content;
  }

  async listPlans(): Promise<{ items: CarePlanSummary[] }> {
    return { items: await this.repository.listPlans() };
  }

  async showPlan(id: string): Promise<CarePlanDetail> {
    const plan = await this.repository.findPlan(id);
    if (plan === null) {
      throw new DomainError("resource_not_found", "通用方案不存在或未发布");
    }
    return plan;
  }

  /** 跨文章/视频/通用方案搜索，只覆盖已发布内容。 */
  async searchAll(query: string): Promise<BrowseSearchResults> {
    const [articles, videos, plans] = await Promise.all([
      this.repository.search("article", query),
      this.repository.search("video", query),
      this.repository.searchPlans(query, 100)
    ]);
    return { articles, videos, plans };
  }

  /**
   * 已发布内容引用的媒体字节（HTTP GET /v1/media/:id 专用，不走命令
   * 信封）。公开范围门禁在仓储层（仅 published 引用可见）；素材可用性
   * 在此判定（非 ready 不服务）。未注入对象存储、无引用、素材不可用
   * 一律 null（路由 404，不泄露存在性）。
   */
  async getPublishedMedia(mediaId: string): Promise<PublishedMedia | null> {
    if (this.objectStorage === undefined) {
      return null;
    }
    const media = await this.repository.findPublishedMedia(mediaId);
    if (media === null || media.status !== "ready") {
      return null;
    }
    const body = await this.objectStorage.getObject(media.storedPath);
    return { body, contentType: servableContentType(media.mimeType, media.storedPath) };
  }
}
