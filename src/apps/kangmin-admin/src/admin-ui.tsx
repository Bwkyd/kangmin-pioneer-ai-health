import type { ContentItem, KnowledgeItem } from "./admin-contracts";

export const knowledgeStatusLabels: Record<KnowledgeItem["status"], string> = {
  processing: "待建索引",
  indexed: "已建索引",
  enabled: "已启用",
  disabled: "已停用",
  index_failed: "索引失败"
};

export const contentStatusLabels: Record<ContentItem["status"], string> = {
  draft: "草稿",
  published: "已发布",
  unpublished: "已下架"
};

export const mediaKindLabels: Record<string, string> = {
  image: "图片",
  video: "视频",
  word: "Word",
  pdf: "PDF",
  markdown: "Markdown"
};

export function Empty({ icon, title, text }: { icon: string; title: string; text: string }) {
  return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{text}</p></div>;
}
