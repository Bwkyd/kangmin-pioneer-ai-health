import type {
  CarePlanDetail,
  CarePlanSummary,
  PatientMessage,
  PublicContent,
  PublicContentCategory,
  PublicContentKind
} from "./contracts.js";

/**
 * 已发布内容引用的媒体行（HTTP 媒体路由公开范围门禁）：
 * 仅当素材被某个 status='published' 的 content_item 以 media_id、
 * cover_media_id 或正文 Markdown 媒体链接引用时返回；status 留给服务层做可用性门禁
 * （disabled/failed/processing 不服务）。
 */
export interface PublishedMediaRef {
  storedPath: string;
  mimeType: string | null;
  status: string;
}

export interface ContentReadRepository {
  list(kind: PublicContentKind): Promise<PublicContent[]>;
  /** 分页列表：limit 由服务层截断到上限 100。 */
  listPage(
    kind: PublicContentKind,
    limit: number,
    offset: number
  ): Promise<PublicContent[]>;
  find(kind: PublicContentKind, id: string): Promise<PublicContent | null>;
  search(kind: PublicContentKind, query: string): Promise<PublicContent[]>;
  categories(kind: PublicContentKind): Promise<string[]>;
  categoryRegistry(kind: PublicContentKind): Promise<PublicContentCategory[]>;

  /** 通用护理方案只读：published_revision 非空的当前发布内容。 */
  listPlans(): Promise<CarePlanSummary[]>;
  findPlan(id: string): Promise<CarePlanDetail | null>;
  searchPlans(query: string, limit: number): Promise<CarePlanSummary[]>;

  /** 登录患者的站内消息；未发布消息不可见，已读状态按患者隔离。 */
  listMessages(patientId: string): Promise<PatientMessage[]>;
  findMessage(patientId: string, id: string): Promise<PatientMessage | null>;
  markMessageRead(patientId: string, id: string): Promise<PatientMessage | null>;
  unreadMessageCount(patientId: string): Promise<number>;

  /** 公开媒体只读：无已发布引用或素材不存在时返回 null（不泄露存在性）。 */
  findPublishedMedia(mediaId: string): Promise<PublishedMediaRef | null>;
}
