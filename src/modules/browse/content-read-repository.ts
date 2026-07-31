import type {
  CarePlanDetail,
  CarePlanSummary,
  PublicContent,
  PublicContentKind
} from "./contracts.js";

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

  /** 通用护理方案只读：published_revision 非空的当前发布内容。 */
  listPlans(): Promise<CarePlanSummary[]>;
  findPlan(id: string): Promise<CarePlanDetail | null>;
  searchPlans(query: string, limit: number): Promise<CarePlanSummary[]>;
}
