export type RegistryContentKind = "article" | "video";
export type CategoryAudience = "adult" | "child" | "all";
export type CategoryNodeType = "audience" | "group" | "leaf";

export interface ContentCategoryRegistrySeed {
  id: string;
  kind: RegistryContentKind;
  parentId: string | null;
  name: string;
  audience: CategoryAudience;
  nodeType: CategoryNodeType;
  selectable: boolean;
  displayOrder: number;
}

const video = (
  id: string,
  parentId: string | null,
  name: string,
  audience: CategoryAudience,
  nodeType: CategoryNodeType,
  selectable: boolean,
  displayOrder: number
): ContentCategoryRegistrySeed => ({
  id,
  kind: "video",
  parentId,
  name,
  audience,
  nodeType,
  selectable,
  displayOrder
});

/** 作者 2026-08-26 确认：文章不设二级分类，时间只用于排序。 */
export const ARTICLE_CATEGORY_REGISTRY: readonly ContentCategoryRegistrySeed[] = [{
  id: "article-general",
  kind: "article",
  parentId: null,
  name: "科普文章",
  audience: "all",
  nodeType: "leaf",
  selectable: true,
  displayOrder: 0
}];

/** `vault/truth/视频大全.md` 的稳定分类树；显示名可改，ID 不随名称变化。 */
export const VIDEO_CATEGORY_REGISTRY: readonly ContentCategoryRegistrySeed[] = [
  video("video-adult", null, "成人方案", "adult", "audience", false, 0),
  video("video-adult-quick", "video-adult", "快速通窍方案", "adult", "group", false, 0),
  video("video-adult-quick-content", "video-adult-quick", "快速通窍方案", "adult", "leaf", true, 0),
  video("video-adult-conditioning", "video-adult", "调体方案", "adult", "group", false, 1),
  video("video-adult-lung-qi-cold", "video-adult-conditioning", "肺气虚寒", "adult", "leaf", true, 0),
  video("video-adult-spleen-qi", "video-adult-conditioning", "脾气虚弱", "adult", "leaf", true, 1),
  video("video-adult-kidney-yang", "video-adult-conditioning", "肾阳不足", "adult", "leaf", true, 2),
  video("video-adult-lung-heat", "video-adult-conditioning", "肺经伏热", "adult", "leaf", true, 3),
  video("video-adult-mixed", "video-adult-conditioning", "寒热错杂，虚实并见", "adult", "leaf", true, 4),
  video("video-adult-symptom", "video-adult", "按症状分类", "adult", "group", false, 2),
  video("video-adult-cough", "video-adult-symptom", "过敏性鼻炎伴咳嗽", "adult", "leaf", true, 0),
  video("video-adult-headache", "video-adult-symptom", "过敏性鼻炎伴头痛", "adult", "leaf", true, 1),
  video("video-adult-sleep", "video-adult-symptom", "过敏性鼻炎伴睡眠不佳", "adult", "leaf", true, 2),
  video("video-adult-skin", "video-adult-symptom", "局部湿疹/皮疹/瘙痒", "adult", "leaf", true, 3),
  video("video-child", null, "儿童方案", "child", "audience", false, 1),
  video("video-child-quick", "video-child", "快速通窍方案", "child", "group", false, 0),
  video("video-child-quick-content", "video-child-quick", "快速通窍方案", "child", "leaf", true, 0),
  video("video-child-conditioning", "video-child", "调体方案", "child", "group", false, 1),
  video("video-child-conditioning-content", "video-child-conditioning", "调体方案", "child", "leaf", true, 0)
];

export const CONTENT_CATEGORY_REGISTRY: readonly ContentCategoryRegistrySeed[] = [
  ...ARTICLE_CATEGORY_REGISTRY,
  ...VIDEO_CATEGORY_REGISTRY
];

export interface VideoTruthAssignment {
  title: string;
  categoryIds: readonly string[];
}

/** truth 明列的视频标题到叶分类，多分类逐项显式列出。 */
export const VIDEO_TRUTH_ASSIGNMENTS: readonly VideoTruthAssignment[] = [
  { title: "抗敏要穴之姜行通窍--鼻三线姜刮", categoryIds: ["video-adult-quick-content"] },
  { title: "抗敏要穴之迎香穴（指腹擦迎香）", categoryIds: ["video-adult-quick-content"] },
  { title: "抗敏要穴之补肺固表--肺俞穴", categoryIds: ["video-adult-lung-qi-cold", "video-adult-mixed"] },
  { title: "抗敏要穴之息风止敏--耳穴过敏区", categoryIds: ["video-adult-lung-qi-cold", "video-adult-spleen-qi", "video-adult-kidney-yang", "video-adult-lung-heat", "video-adult-mixed"] },
  { title: "抗敏要穴之通阳固本--身柱穴", categoryIds: ["video-adult-lung-qi-cold", "video-adult-kidney-yang"] },
  { title: "抗敏要穴之固守风关--风门", categoryIds: ["video-adult-lung-qi-cold", "video-adult-mixed"] },
  { title: "抗敏要穴之阳中之阳--大椎穴", categoryIds: ["video-adult-lung-qi-cold", "video-adult-kidney-yang", "video-adult-mixed"] },
  { title: "刮中府、云门+隔姜灸", categoryIds: ["video-adult-lung-qi-cold"] },
  { title: "耳穴压豆神门、肺、皮质下", categoryIds: ["video-adult-lung-qi-cold", "video-adult-spleen-qi", "video-adult-kidney-yang", "video-adult-lung-heat"] },
  { title: "抗敏要穴之健脾益气--天枢穴", categoryIds: ["video-adult-spleen-qi"] },
  { title: "抗敏要穴之健脾补虚--足三里穴", categoryIds: ["video-adult-spleen-qi"] },
  { title: "抗敏要穴之补肺固表--肺俞穴（点揉，不灸）", categoryIds: ["video-adult-lung-heat"] },
  { title: "天突、膻中、尺泽刮痧法", categoryIds: ["video-adult-cough"] },
  { title: "按揉太阳穴、印堂穴、合谷穴", categoryIds: ["video-adult-headache"] },
  { title: "耳穴压豆：神门、肺、风溪、皮质下", categoryIds: ["video-adult-headache"] },
  { title: "颈三线刮痧", categoryIds: ["video-adult-sleep"] },
  { title: "麦灸棒点灸", categoryIds: ["video-adult-skin"] },
  { title: "鼻炎手法", categoryIds: ["video-child-quick-content"] },
  { title: "头面四大手法", categoryIds: ["video-child-quick-content"] },
  { title: "鼻三线姜刮", categoryIds: ["video-child-quick-content"] },
  { title: "过敏手法", categoryIds: ["video-child-conditioning-content"] },
  { title: "呼吸手法", categoryIds: ["video-child-conditioning-content"] },
  { title: "清肺经、清大肠", categoryIds: ["video-child-conditioning-content"] },
  { title: "揉天枢、摩腹", categoryIds: ["video-child-conditioning-content"] },
  { title: "消化手法", categoryIds: ["video-child-conditioning-content"] },
  { title: "清热手法", categoryIds: ["video-child-conditioning-content"] }
];
