import type { ContentType } from "./store";

export const contentTypes = new Set<ContentType>(["article", "video", "knowledge", "plan"]);
export const approvedSyndromes = new Set(["LUNG_QI_DEFICIENCY_COLD", "SPLEEN_QI_DEFICIENCY", "KIDNEY_YANG_DEFICIENCY", "LUNG_HEAT", "COLD_HEAT_COMPLEX"]);

export function cleanText(value: unknown, maximum = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

export function parseMetadata(value: unknown) {
  const metadata = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    risks: cleanText(metadata.risks, 4000),
    contraindications: cleanText(metadata.contraindications, 4000),
    syndromeCodes: Array.isArray(metadata.syndromeCodes)
      ? metadata.syndromeCodes.filter((code): code is string => typeof code === "string" && approvedSyndromes.has(code))
      : [],
  };
}

export function publishProblem(type: ContentType, item: { title?: string; body?: string; mediaId?: string | null; metadata?: string }, stepCount = 0, validStepMediaCount = 0) {
  if (!item.title?.trim()) return "请先填写标题";
  if (type === "article" && !item.body?.trim()) return "文章正文不能为空";
  if (type === "video" && !item.mediaId) return "视频发布前必须上传视频文件";
  if (type === "knowledge") {
    if (!item.mediaId) return "知识资料发布前必须上传来源文件";
    const raw = item.metadata ? JSON.parse(item.metadata) as { indexedChunks?: number } : {};
    if (!raw.indexedChunks) return "知识资料必须先完成索引";
  }
  if (type === "plan") {
    const metadata = parseMetadata(item.metadata ? JSON.parse(item.metadata) : {});
    if (!metadata.risks || !metadata.contraindications || metadata.syndromeCodes.length === 0) return "调理方案必须填写风险、禁忌并绑定已批准证型";
    if (stepCount === 0) return "调理方案至少需要一个操作步骤";
    if (validStepMediaCount === 0) return "调理方案至少需要绑定一个已发布视频";
  }
  return null;
}
