import type { ContentType } from "./store";
import { clinicalCandidateDefinition, isClinicalCandidateKind, normalizeSyndromePlanMappings } from "./clinical-candidates.ts";
import { SYNDROME_CODES, type SyndromeCode } from "../agent/syndromes.ts";
import { getRehabMethodDefinition, isRehabMethodCode, normalizeRehabPointGroups, normalizeRehabRoutes, REHAB_METHOD_CODES, type RehabMethodCode } from "../agent/rehab-methods.ts";
import { parseVideoTopicType } from "../content/video-topics.ts";

export const contentTypes = new Set<ContentType>(["article", "video", "knowledge", "plan"]);
export const approvedSyndromes = new Set<SyndromeCode>(SYNDROME_CODES);
export const APPROVED_REHAB_METHODS = REHAB_METHOD_CODES;
export type ApprovedRehabMethod = RehabMethodCode;
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

export function clinicalCandidateProblem(candidateKind: unknown, changeDiff: unknown, source: unknown) {
  const kind = cleanText(candidateKind, 80);
  const diff = cleanText(changeDiff, 4000);
  if (!kind) {
    if (diff) return "填写变更差异前必须先选择临床候选类别";
    return null;
  }
  if (!isClinicalCandidateKind(kind)) return "临床候选类别无效，请从受控选项中选择";
  if (!cleanText(source, 1000)) return "临床候选必须填写来源或依据";
  if (!diff) return "临床候选必须填写本版本相对上一版本的变更差异";
  return null;
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
    methodCode: isRehabMethodCode(metadata.methodCode) ? metadata.methodCode : null,
    methodLabel: isRehabMethodCode(metadata.methodCode) ? getRehabMethodDefinition(metadata.methodCode)?.label ?? null : null,
    routes: normalizeRehabRoutes(Array.isArray(metadata.routes) ? metadata.routes : { routeCodes: metadata.routeCodes }),
    pointGroups: normalizeRehabPointGroups(Array.isArray(metadata.pointGroups) ? metadata.pointGroups : { pointGroupCodes: metadata.pointGroupCodes }, metadata.methodCode),
    syndromePlanMappings: normalizeSyndromePlanMappings(metadata.syndromePlanMappings),
    videoTopicType: contentType === "video" ? parseVideoTopicType(metadata.topicType) : null,
  };
}

export function clinicalCandidateContentProblem(candidateKind: unknown, metadataValue: unknown, contentType?: ContentType) {
  const definition = clinicalCandidateDefinition(candidateKind);
  if (!definition) return null;
  const metadata = parseMetadata(metadataValue, contentType);
  if (definition.code === "base_syndrome_mapping") {
    const expected = definition.syndromeCodes ?? [];
    const actual = metadata.syndromePlanMappings;
    if (actual.length !== expected.length || expected.some((code) => !actual.some((mapping) => mapping.syndromeCode === code))) return "五种证型基础方案映射必须逐项保存 mapped、no_plan 或 missing 状态";
    if (actual.some((mapping) => mapping.status === "mapped" && (!mapping.planId || !mapping.planVersion || mapping.planVersion < 1))) return "已映射证型必须同时保存基础方案 ID 和版本";
  }
  if (definition.requiredMethodCode && metadata.methodCode !== definition.requiredMethodCode) return `${definition.label}必须选择受控方法“${getRehabMethodDefinition(definition.requiredMethodCode)?.label ?? definition.requiredMethodCode}”`;
  if (definition.requiredPointGroupCode && !metadata.pointGroups.some((group) => group.code === definition.requiredPointGroupCode)) return `${definition.label}必须保存受控穴位结构`;
  if (contentType === "plan" && definition.enforceSyndromeCodes && definition.syndromeCodes && (metadata.syndromeCodes.length !== definition.syndromeCodes.length || definition.syndromeCodes.some((code) => !metadata.syndromeCodes.includes(code as SyndromeCode)))) return `${definition.label}必须绑定Issue要求的适用证型映射`;
  return null;
}

export function clinicalCandidateApprovalProblem(candidateKind: unknown, metadataValue: unknown, contentType?: ContentType) {
  if (clinicalCandidateDefinition(candidateKind)?.code !== "base_syndrome_mapping") return null;
  const metadata = parseMetadata(metadataValue, contentType);
  if (metadata.syndromePlanMappings.some((mapping) => mapping.status === "missing")) return "五种证型基础方案映射仍有资料缺失，不能完成临床审核";
  return null;
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

export function publishProblem(type: ContentType, item: { title?: string; category?: string; summary?: string; body?: string; source?: string; stepsText?: string; version?: number; mediaId?: string | null; metadata?: string; clinicalCandidateKind?: string | null }) {
  if (!item.title?.trim()) return "请先填写标题";
  if (type === "article" && !item.body?.trim()) return "文章正文不能为空";
  if (type === "video" && !item.mediaId) return "视频发布前必须上传视频文件";
  if (type === "video" && parseMetadata(item.metadata, "video").videoTopicType && (!item.category || item.category === "未分类")) return "视频选择分类维度后必须填写具体分类";
  if (type === "knowledge") {
    if (!item.mediaId) return "知识资料发布前必须上传来源文件";
    const raw = item.metadata ? JSON.parse(item.metadata) as { indexedChunks?: number; indexedVersion?: number } : {};
    if (!raw.indexedChunks || raw.indexedVersion !== item.version) return "知识资料必须先完成当前版本索引";
  }
  if (type === "plan" || type === "video") {
    const metadata = parseMetadata(item.metadata, type);
    const text = [item.title, item.summary, item.body, item.source, item.stepsText].filter((value): value is string => typeof value === "string").join("\n");
    const methodLabel = metadata.methodLabel;
    if (metadata.routes.length > 0 && metadata.methodCode !== "nose_three_line_ginger_scrape") return "路线/穴位结构只能绑定鼻三线姜刮方法";
    if (metadata.pointGroups.length > 0 && !metadata.methodCode) return "穴位结构必须绑定受控方法";
    if (metadata.pointGroups.some((group) => group.methodCode !== metadata.methodCode)) return "穴位结构与方法类型不一致";
    if (metadata.methodCode === "nose_three_line_ginger_scrape") {
      if (metadata.routes.length === 0) return "鼻三线姜刮方案必须保存至少一条路线/穴位结构";
      const title = item.title ?? "";
      const content = [item.summary, item.body, item.source, item.stepsText].filter((value): value is string => typeof value === "string").join("\n");
      const titleHasOtherMethod = /普通刮痧|传统刮痧/u.test(title);
      const contentWithoutClarifier = content
        .replace(/(?:鼻三线姜刮|姜刮)[\s，,：:、]*(?:不等同于|不是|不同于)[\s，,：:、]*(?:普通|传统)?刮痧/gu, "")
        .replace(/(?:普通|传统)?刮痧[\s，,：:、]*(?:不等同于|不是|不同于)[\s，,：:、]*(?:鼻三线)?姜刮/gu, "");
      if (titleHasOtherMethod || /普通刮痧|传统刮痧/u.test(contentWithoutClarifier)) return "鼻三线姜刮不等同于普通刮痧，请修正方法名称和正文后再发布";
      if (!methodLabel || !item.title?.includes(methodLabel)) return "鼻三线姜刮方案标题必须使用统一方法名称";
      if (/姜刮/u.test(content.replace(/鼻三线姜刮/gu, ""))) return "正文中的姜刮必须使用统一名称“鼻三线姜刮”";
    }
    if (metadata.methodCode === "gua_sha") {
      if (!methodLabel || !item.title?.includes(methodLabel)) return "刮痧方案标题必须使用统一方法名称";
      if (/鼻三线姜刮|姜刮/u.test(text)) return "刮痧与鼻三线姜刮是不同的方法类型，请修正后再发布";
      if (item.clinicalCandidateKind !== "gua_sha_safety_gate") return "普通刮痧方案必须绑定 #94–#96 刮痧安全门禁候选，临床确认前不可发布";
    }
    if (metadata.methodCode !== "nose_three_line_ginger_scrape" && /姜刮/u.test(text)) return "正文中的鼻三线姜刮与受控方法不一致，请修正后再发布";
  }
  return null;
}
