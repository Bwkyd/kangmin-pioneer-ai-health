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

/**
 * 通用护理方案列表条目（设计 §17 双门禁：临床规则包 approved
 * （planBrowseEnabled）之外，还需管理端启用 agent_plans.status='enabled'；
 * candidate 期间患者不可见）。
 */
export interface CarePlanSummary {
  id: string;
  name: string;
  publishedRevision: number;
}

/** 通用护理方案详情（步骤兼容管理端 string[] 与对象数组两种格式）。 */
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
