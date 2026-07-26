import type { ContentType } from "./store";
import { SYNDROME_CODES, type SyndromeCode } from "../agent/syndromes.ts";
import { parseVideoTopicType } from "../content/video-topics.ts";

export const contentTypes = new Set<ContentType>(["article", "video", "knowledge", "plan"]);
export const approvedSyndromes = new Set<SyndromeCode>(SYNDROME_CODES);
export const APPROVED_REHAB_METHODS = [
  "nose_three_line_ginger_scrape",
  "finger_pressure_yingxiang",
  "acupoint_massage",
  "ear_acupressure",
  "moxa_or_blow_dazhui",
] as const;
export type ApprovedRehabMethod = (typeof APPROVED_REHAB_METHODS)[number];
export const approvedRehabMethods = new Set<ApprovedRehabMethod>(APPROVED_REHAB_METHODS);
const UNAPPROVED_CLINICAL_CONTENT = /鼻三线姜刮|姜刮|刮痧|耳穴压豆|耳穴|艾灸|电吹风|吹大椎|大椎|推拿|揉按|按摩|穴位|风池|风门|肺俞|列缺|太渊|迎香|鼻通|上迎香|印堂|神庭|肩井|调理方案|康复方案/u;

type ClinicalContent = {
  title?: string;
  category?: string;
  summary?: string;
  body?: string;
  source?: string;
  metadata?: string;
  filename?: string;
  chunkText?: string;
  stepsText?: string;
};

export function cleanText(value: unknown, maximum = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

export function parseMetadata(value: unknown, contentType?: ContentType) {
  let metadata: Record<string, unknown> = {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    metadata = value as Record<string, unknown>;
  }
  return {
    risks: cleanText(metadata.risks, 4000),
    contraindications: cleanText(metadata.contraindications, 4000),
    syndromeCodes: Array.isArray(metadata.syndromeCodes)
      ? metadata.syndromeCodes.filter((code): code is SyndromeCode => typeof code === "string" && approvedSyndromes.has(code as SyndromeCode))
      : [],
    methodCode: typeof metadata.methodCode === "string" && approvedRehabMethods.has(metadata.methodCode as ApprovedRehabMethod) ? metadata.methodCode as ApprovedRehabMethod : null,
    videoTopicType: contentType === "video" ? parseVideoTopicType(metadata.topicType) : null,
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
  // 用户端所有内容都是鼻健康/康复相关内容。关键词只能用于提示和回归
  // 检查，不能作为安全边界；未知词、同义词或换写方式都必须默认进入临床审核。
  return contentTypes.has(type) || hasUnapprovedClinicalContent(item);
}

export function publishProblem(type: ContentType, item: { title?: string; category?: string; summary?: string; body?: string; source?: string; stepsText?: string; version?: number; mediaId?: string | null; metadata?: string }) {
  if (!item.title?.trim()) return "请先填写标题";
  if (type === "article" && !item.body?.trim()) return "文章正文不能为空";
  if (type === "video" && !item.mediaId) return "视频发布前必须上传视频文件";
  if (type === "video" && parseMetadata(item.metadata, "video").videoTopicType && (!item.category || item.category === "未分类")) return "视频选择分类维度后必须填写具体分类";
  if (type === "knowledge") {
    if (!item.mediaId) return "知识资料发布前必须上传来源文件";
    const raw = item.metadata ? JSON.parse(item.metadata) as { indexedChunks?: number; indexedVersion?: number } : {};
    if (!raw.indexedChunks || raw.indexedVersion !== item.version) return "知识资料必须先完成当前版本索引";
  }
  if (type === "plan") {
    const metadata = parseMetadata(item.metadata, type);
    const text = [item.title, item.summary, item.body, item.source, item.stepsText].filter((value): value is string => typeof value === "string").join("\n");
    if (metadata.methodCode === "nose_three_line_ginger_scrape" && /普通刮痧|传统刮痧/u.test(text) && !/不等同于普通刮痧|不是普通刮痧/u.test(text)) {
      return "鼻三线姜刮不等同于普通刮痧，请修正方法名称和正文后再发布";
    }
    if (metadata.methodCode !== "nose_three_line_ginger_scrape" && /鼻三线姜刮/u.test(text)) {
      return "正文中的鼻三线姜刮与受控方法不一致，请修正后再发布";
    }
  }
  return null;
}
