export interface LearningCategoryMatchRule {
  id: string;
  aliases: string[];
  titles: string[];
}

export interface LearningCategoryMatchItem {
  category: string;
  title: string;
}

function normalized(value: string): string {
  return value.replace(/[\s·——、，,()（）+]/gu, "").toLocaleLowerCase("zh-CN");
}

export function belongsToLearningCategory(
  item: LearningCategoryMatchItem,
  category: LearningCategoryMatchRule,
  allCategories: LearningCategoryMatchRule[]
): boolean {
  const categoryText = normalized(item.category);
  const titleText = normalized(item.title);
  const explicitMatches = categoryText === "" ? [] : allCategories.filter((candidate) =>
    candidate.aliases.some((alias) => categoryText === normalized(alias))
  );
  if (explicitMatches.length > 0) {
    return explicitMatches.length === 1 && explicitMatches[0]!.id === category.id;
  }
  const titleMatches = allCategories.filter((candidate) =>
    candidate.titles.some((title) => titleText.includes(normalized(title)))
  );
  return titleMatches.length === 1 && titleMatches[0]!.id === category.id;
}
