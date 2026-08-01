import { DomainError } from "../../kernel/errors.js";
import type { ContentReadRepository } from "./content-read-repository.js";
import type {
  BrowseHome,
  BrowseSearchResults,
  CarePlanDetail,
  CarePlanSummary,
  PublicContent,
  PublicContentKind
} from "./contracts.js";

export class BrowseService {
  constructor(private readonly repository: ContentReadRepository) {}

  async home(): Promise<BrowseHome> {
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
      }
    };
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
}
