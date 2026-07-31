export type PublicContentKind = "article" | "video";

export interface PublicContent {
  id: string;
  kind: PublicContentKind;
  title: string;
  category: string;
  summary: string;
  body: string | null;
  source: string;
  coverUrl: string | null;
  mediaUrl: string | null;
  publishedAt: string;
  updatedAt: string;
  disclaimer: string;
}

export interface BrowseHome {
  articles: PublicContent[];
  videos: PublicContent[];
  recentlyUpdated: PublicContent[];
  categories: {
    articles: string[];
    videos: string[];
  };
}

/** 通用护理方案列表条目（agent_care_plans.published_revision 非空才可见）。 */
export interface CarePlanSummary {
  id: string;
  name: string;
  publishedRevision: number;
}

/** 通用护理方案详情（内容来自当前发布修订）。 */
export interface CarePlanDetail extends CarePlanSummary {
  summary: string | null;
  steps: Array<{ step: number; title: string; description?: string }>;
  disclaimer: string | null;
}

/** browse search：跨文章/视频/通用方案，只覆盖已发布内容。 */
export interface BrowseSearchResults {
  articles: PublicContent[];
  videos: PublicContent[];
  plans: CarePlanSummary[];
}
