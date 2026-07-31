import { DomainError } from "../../kernel/errors.js";
import type { ContentReadRepository } from "./content-read-repository.js";
import type {
  BrowseHome,
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
}
