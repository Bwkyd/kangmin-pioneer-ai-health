/**
 * 学一学内容数据层：对接 browse 只读命令（科普文章 / 操作视频 / 通用方案）。
 * 只渲染服务端返回的已发布内容；注入 candidate 包时方案列表返回空是
 * 设计行为（设计 §17 双门禁），界面如实展示“暂未开放”，不伪造数据。
 * coverUrl / mediaUrl 是同源相对路径（/v1/media/<id>），可直接用作
 * <img> / <video> 的 src。
 */

import { command } from "./command-client";

// ---- 命令协议 DTO（与 src/modules/browse/contracts.ts 对应） ----

export type PublicContentKind = "article" | "video";

export interface PublicContent {
  id: string;
  kind: PublicContentKind;
  title: string;
  category: string;
  categoryIds: string[];
  summary: string;
  body: string | null;
  source: string;
  coverUrl: string | null;
  mediaUrl: string | null;
  publishedAt: string;
  updatedAt: string;
  instructions: string;
  precautions: string;
  disclaimer: string;
}

export interface PublicContentCategory {
  id: string;
  kind: PublicContentKind;
  parentId: string | null;
  name: string;
  audience: "adult" | "child" | "all";
  nodeType: "audience" | "group" | "leaf";
  selectable: boolean;
  displayOrder: number;
}

export interface CarePlanSummary {
  id: string;
  name: string;
  publishedRevision: number;
}

export interface CarePlanDetail extends CarePlanSummary {
  summary: string | null;
  steps: Array<{ step: number; title: string; description?: string }>;
  precautions: string;
  risks: string;
  contraindications: string;
  videoResourceId: string | null;
  disclaimer: string | null;
}

/** 列表一次读取的条数上限。 */
const LIST_LIMIT = 50;

async function listPublicContentPage(
  kind: PublicContentKind,
  offset: number
): Promise<PublicContent[]> {
  const { items } = await command<{ items: PublicContent[] }>(
    `browse ${kind} list`,
    { limit: LIST_LIMIT, offset }
  );
  return items;
}

export async function listPublicContent(
  kind: PublicContentKind
): Promise<PublicContent[]> {
  return listPublicContentPage(kind, 0);
}

/**
 * 最终方案需要在全部已发布视频中找对应方法，不能因为内容超过首 50 条
 * 再次出现“后台有视频、方案里没有”。按页读取并以 id 去重；短页、空页、
 * 无新增项时停止。服务端数据有限，重复页也会由“无新增项”确定性终止，
 * 不设置会在第 501 条重新制造漏配的静默总量上限。
 */
export async function listAllPublicContent(
  kind: PublicContentKind
): Promise<PublicContent[]> {
  const found = new Map<string, PublicContent>();
  for (let offset = 0; ; offset += LIST_LIMIT) {
    const items = await listPublicContentPage(kind, offset);
    const sizeBefore = found.size;
    items.forEach((item) => found.set(item.id, item));
    if (items.length < LIST_LIMIT || found.size === sizeBefore) break;
  }
  return [...found.values()];
}

export async function showPublicContent(
  kind: PublicContentKind,
  id: string
): Promise<PublicContent> {
  return command<PublicContent>(`browse ${kind} show`, { id });
}

export async function listContentCategories(
  kind: PublicContentKind
): Promise<string[]> {
  const { items } = await command<{ items: string[] }>(
    `browse ${kind} categories`
  );
  return items;
}

export async function listContentCategoryRegistry(
  kind: PublicContentKind
): Promise<PublicContentCategory[]> {
  const { items } = await command<{ items: PublicContentCategory[] }>(
    `browse ${kind} category-registry`
  );
  return items;
}

export async function listCarePlans(): Promise<CarePlanSummary[]> {
  const { items } = await command<{ items: CarePlanSummary[] }>(
    "browse plan list"
  );
  return items;
}

export async function showCarePlan(id: string): Promise<CarePlanDetail> {
  return command<CarePlanDetail>("browse plan show", { id });
}

export interface KnowledgeAnswer {
  answer: string;
  sources: Array<{ knowledgeId: string; name: string; source: string | null }>;
  generated: boolean;
  disclaimer: string;
}

export async function askKnowledge(question: string): Promise<KnowledgeAnswer> {
  return command<KnowledgeAnswer>("agent knowledge ask", { question });
}
