export const VIDEO_TOPIC_TYPES = ["symptom", "syndrome", "general"] as const;
export type VideoTopicType = (typeof VIDEO_TOPIC_TYPES)[number];
export type VideoTopicFilter = VideoTopicType | "all";

export const VIDEO_TOPIC_LABELS: Record<VideoTopicType, string> = {
  symptom: "按症状",
  syndrome: "按证型",
  general: "通用内容",
};

export function parseVideoTopicType(value: unknown): VideoTopicType | null {
  return typeof value === "string" && VIDEO_TOPIC_TYPES.includes(value as VideoTopicType)
    ? value as VideoTopicType
    : null;
}

export function normalizeVideoTopicType(value: unknown): VideoTopicType {
  return parseVideoTopicType(value) ?? "general";
}

type VideoTopicItem = { category?: string | null; topicType?: unknown };

export function filterVideoItems<T extends VideoTopicItem>(items: T[], topic: VideoTopicFilter, category: string) {
  return items.filter((item) => {
    const matchesTopic = topic === "all" || normalizeVideoTopicType(item.topicType) === topic;
    const itemCategory = item.category?.trim() || "未分类";
    return matchesTopic && (category === "all" || itemCategory === category);
  });
}

export function uniqueVideoCategories(items: VideoTopicItem[], topic: VideoTopicFilter) {
  return [...new Set(
    items
      .filter((item) => topic === "all" || normalizeVideoTopicType(item.topicType) === topic)
      .map((item) => item.category?.trim() || "未分类"),
  )].sort((left, right) => left.localeCompare(right, "zh-CN"));
}
