import type { PublicContent, PublicContentCategory } from "./discover";

export type LearningAudience = "adult" | "child";

export interface LearningCategory { id: string; label: string }
export interface LearningSection { id: string; label: string; categories: LearningCategory[] }
export interface LearningAudienceCatalog {
  id: LearningAudience;
  label: string;
  sections: LearningSection[];
}

/** 目录完全由服务端 truth 注册表派生，客户端不再复制标题/别名规则。 */
export function catalogsFromRegistry(nodes: PublicContentCategory[]): LearningAudienceCatalog[] {
  return nodes.filter((node) => node.nodeType === "audience")
    .map((root) => ({
      id: root.audience as LearningAudience,
      label: root.name,
      sections: nodes.filter((node) => node.parentId === root.id && node.nodeType === "group")
        .map((group) => ({
          id: group.id,
          label: group.name,
          categories: nodes.filter((node) => node.parentId === group.id && node.selectable)
            .map((leaf) => ({ id: leaf.id, label: leaf.name }))
        })).filter((section) => section.categories.length > 0)
    })).filter((catalog) => catalog.sections.length > 0);
}

export function belongsToCategory(item: PublicContent, category: LearningCategory): boolean {
  return item.categoryIds.includes(category.id);
}
