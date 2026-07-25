import type { ContentType } from "./store";
import { SYNDROME_CODES, type SyndromeCode } from "../agent/syndromes.ts";

export const contentTypes = new Set<ContentType>(["article", "video", "knowledge", "plan"]);
export const approvedSyndromes = new Set<SyndromeCode>(SYNDROME_CODES);
const UNAPPROVED_CLINICAL_CONTENT = /鼻三线姜刮|姜刮|刮痧|耳穴压豆|耳穴|艾灸|电吹风|穴位|风池|风门|肺俞|列缺|太渊|迎香|鼻通|上迎香|印堂|神庭|肩井|按揉|按摩|调理方案|康复方案/u;

type ClinicalContent = {
  title?: string;
  category?: string;
  summary?: string;
  body?: string;
  source?: string;
  metadata?: string;
  filename?: string;
  chunkText?: string;
};

export function cleanText(value: unknown, maximum = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

export function parseMetadata(value: unknown) {
  const metadata = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    risks: cleanText(metadata.risks, 4000),
    contraindications: cleanText(metadata.contraindications, 4000),
    syndromeCodes: Array.isArray(metadata.syndromeCodes)
      ? metadata.syndromeCodes.filter((code): code is SyndromeCode => typeof code === "string" && approvedSyndromes.has(code as SyndromeCode))
      : [],
  };
}

export function hasUnapprovedClinicalContent(item: ClinicalContent) {
  const text = [item.title, item.category, item.summary, item.body, item.source, item.metadata, item.filename, item.chunkText]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
  return UNAPPROVED_CLINICAL_CONTENT.test(text);
}

export const clinicalApprovalRequiredMessage = "涉及康复操作或调理方案的内容必须经过临床审核（由临床负责人审核），当前禁止发布或索引";

export function requiresClinicalApproval(type: ContentType, item: ClinicalContent) {
  return type === "plan" || type === "video" || type === "knowledge" || hasUnapprovedClinicalContent(item);
}

export function publishProblem(type: ContentType, item: { title?: string; body?: string; version?: number; mediaId?: string | null; metadata?: string }) {
  if (!item.title?.trim()) return "请先填写标题";
  if (type === "article" && !item.body?.trim()) return "文章正文不能为空";
  if (type === "video" && !item.mediaId) return "视频发布前必须上传视频文件";
  if (type === "knowledge") {
    if (!item.mediaId) return "知识资料发布前必须上传来源文件";
    const raw = item.metadata ? JSON.parse(item.metadata) as { indexedChunks?: number; indexedVersion?: number } : {};
    if (!raw.indexedChunks || raw.indexedVersion !== item.version) return "知识资料必须先完成当前版本索引";
  }
  return null;
}
