import type { ErrorCode } from "../../kernel/errors.js";
import type { EnvironmentSnapshot } from "../environment/environment-ports.js";

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
  /** 视频发布前填写的操作提示与注意事项；文章返回空串。 */
  instructions: string;
  precautions: string;
  disclaimer: string;
}

/**
 * browse 首页环境区块三态：
 * - ok：取到当前环境快照；
 * - no_location：未指定位置（裸 browse 未给 --location），首页不取数；
 * - unavailable：环境数据源不可用（code 为原 DomainError 错误码），
 *   明确标注状态，绝不伪造数据，也不拖垮首页其余区块。
 */
export type BrowseHomeEnvironment =
  | { status: "ok"; current: EnvironmentSnapshot }
  | { status: "no_location" }
  | { status: "unavailable"; code: ErrorCode };

export interface BrowseHome {
  articles: PublicContent[];
  videos: PublicContent[];
  recentlyUpdated: PublicContent[];
  categories: {
    articles: string[];
    videos: string[];
  };
  environment: BrowseHomeEnvironment;
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
  precautions: string;
  risks: string;
  contraindications: string;
  videoResourceId: string | null;
  disclaimer: string | null;
}

/** browse search：跨文章/视频/通用方案，只覆盖已发布内容。 */
export interface BrowseSearchResults {
  articles: PublicContent[];
  videos: PublicContent[];
  plans: CarePlanSummary[];
}

/** 患者站内消息：仅返回已发布消息，并按患者维度附带已读状态。 */
export interface PatientMessage {
  id: string;
  title: string;
  body: string;
  summary: string | null;
  publishedAt: string;
  readAt: string | null;
}

/**
 * HTTP 媒体路由（GET /v1/media/:id）返回的已发布媒体字节：
 * 不套命令信封，直接发字节流；contentType 已过服务层白名单。
 */
export interface PublishedMedia {
  body: Buffer;
  contentType: string;
}
