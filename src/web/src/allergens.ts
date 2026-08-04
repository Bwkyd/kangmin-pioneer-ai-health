/**
 * 过敏原固定词汇目录（与 src/modules/record/domain.ts 的 ALLERGEN_FACTORS
 * 同一套 code 词汇）。界面展示中文 label，提交服务端时转换为 code。
 */

export const ALLERGEN_GROUPS = [
  {
    code: "environment",
    label: "环境暴露",
    options: [
      { code: "pollen", label: "花粉" },
      { code: "dust_mite", label: "尘螨" },
      { code: "mold", label: "霉菌" },
      { code: "dust", label: "灰尘" },
      { code: "smoke", label: "烟雾" },
      { code: "air_pollution", label: "空气污染" }
    ]
  },
  {
    code: "contact",
    label: "接触性物质",
    options: [
      { code: "pet_dander", label: "宠物皮屑或动物毛" },
      { code: "fragrance", label: "香水或香味产品" },
      { code: "cleaning_products", label: "清洁用品" },
      { code: "cosmetics", label: "化妆品或护肤品" },
      { code: "metal_latex", label: "金属或乳胶" }
    ]
  },
  {
    code: "diet_lifestyle",
    label: "饮食与作息",
    options: [
      { code: "alcohol", label: "饮酒" },
      { code: "spicy_food", label: "辛辣食物" },
      { code: "sleep_deprivation", label: "睡眠不足" },
      { code: "specific_food", label: "特定食物" }
    ]
  },
  {
    code: "activity",
    label: "活动相关",
    options: [
      { code: "exercise", label: "运动" },
      { code: "cold_air", label: "冷空气" },
      { code: "outdoor_activity", label: "户外活动" },
      { code: "cleaning_bedding", label: "打扫或整理床品" },
      { code: "work_study_place", label: "工作或学习场所" }
    ]
  },
  {
    code: "other",
    label: "其他",
    options: [
      { code: "other", label: "其它（请简要描述）" },
      { code: "none_identified", label: "未识别到明确因素" }
    ]
  }
] as const;

const codeByLabel = new Map<string, string>(
  ALLERGEN_GROUPS.flatMap((group) =>
    group.options.map((option) => [option.label, option.code] as const)
  )
);
const labelByCode = new Map<string, string>(
  ALLERGEN_GROUPS.flatMap((group) =>
    group.options.map((option) => [option.code, option.label] as const)
  )
);

export function labelToCode(label: string): string | null {
  return codeByLabel.get(label) ?? null;
}

export function codeToLabel(code: string): string {
  return labelByCode.get(code) ?? code;
}

export function isKnownLabel(label: string): boolean {
  return codeByLabel.has(label);
}
