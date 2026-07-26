export const REHAB_METHOD_DEFINITIONS = [
  {
    code: "nose_three_line_ginger_scrape",
    label: "鼻三线姜刮",
    note: "不等同于普通刮痧",
  },
  {
    code: "gua_sha",
    label: "刮痧",
    note: "独立安全门禁（#94–#96），临床确认前不可发布",
  },
  {
    code: "finger_pressure_yingxiang",
    label: "指腹擦迎香",
    note: "",
  },
  {
    code: "acupoint_massage",
    label: "穴位按摩",
    note: "",
  },
  {
    code: "ear_acupressure",
    label: "耳穴压豆",
    note: "",
  },
  {
    code: "moxa_dazhui_fengchi",
    label: "艾灸大椎、风池",
    note: "参数和禁忌待临床确认",
  },
  {
    code: "electric_blow_dazhui_fengchi",
    label: "电吹风吹大椎、风池",
    note: "参数和禁忌待临床确认",
  },
] as const;

export const THERMAL_REHAB_METHOD_CODES = [
  "moxa_dazhui_fengchi",
  "electric_blow_dazhui_fengchi",
] as const;

export type ThermalRehabMethodCode = (typeof THERMAL_REHAB_METHOD_CODES)[number];

export function isThermalRehabMethod(value: unknown): value is ThermalRehabMethodCode {
  return (THERMAL_REHAB_METHOD_CODES as readonly string[]).includes(value as string);
}

export type RehabMethodCode = (typeof REHAB_METHOD_DEFINITIONS)[number]["code"];
export type RehabMethodDefinition = (typeof REHAB_METHOD_DEFINITIONS)[number];

export const REHAB_METHOD_CODES = REHAB_METHOD_DEFINITIONS.map(({ code }) => code) as [RehabMethodCode, ...RehabMethodCode[]];

const methodDefinitions = new Map<RehabMethodCode, RehabMethodDefinition>(
  REHAB_METHOD_DEFINITIONS.map((definition) => [definition.code, definition]),
);

export function isRehabMethodCode(value: unknown): value is RehabMethodCode {
  return typeof value === "string" && methodDefinitions.has(value as RehabMethodCode);
}

export function getRehabMethodDefinition(value: unknown): RehabMethodDefinition | null {
  return isRehabMethodCode(value) ? methodDefinitions.get(value) ?? null : null;
}

export type RehabRoute = {
  code: string;
  label: string;
  points: string[];
};

export type RehabPointGroup = {
  code: string;
  label: string;
  methodCode: RehabMethodCode;
  points: string[];
  relation?: string;
};

export const REHAB_POINT_GROUP_DEFINITIONS: readonly RehabPointGroup[] = [
  { code: "finger_pressure_yingxiang", label: "迎香", methodCode: "finger_pressure_yingxiang", points: ["迎香"] },
  { code: "ear_shenmen_subcortex_lung_fengxi", label: "神门-皮质下-肺-风溪", methodCode: "ear_acupressure", points: ["神门", "皮质下", "肺", "风溪"], relation: "按此顺序记录" },
  { code: "fengchi_fengmen_feishu_lieque_plus_taiyuan", label: "风池-风门-肺俞-列缺+太渊", methodCode: "acupoint_massage", points: ["风池", "风门", "肺俞", "列缺", "太渊"], relation: "列缺+太渊" },
  { code: "moxa_dazhui_fengchi", label: "大椎、风池（艾灸）", methodCode: "moxa_dazhui_fengchi", points: ["大椎", "风池"], relation: "参数和禁忌待临床确认" },
  { code: "electric_blow_dazhui_fengchi", label: "大椎、风池（电吹风）", methodCode: "electric_blow_dazhui_fengchi", points: ["大椎", "风池"], relation: "参数和禁忌待临床确认" },
];

export const NOSE_THREE_LINE_GINGER_ROUTES: readonly RehabRoute[] = [
  { code: "yintang_shenting", label: "印堂-神庭", points: ["印堂", "神庭"] },
  { code: "bitong_yingxiang", label: "鼻通-迎香", points: ["鼻通", "迎香"] },
  { code: "shangyingxiang_sibai", label: "上迎香-四白", points: ["上迎香", "四白"] },
  { code: "yingxiang_juliao", label: "迎香-巨髎", points: ["迎香", "巨髎"] },
  { code: "fengchi_jianjing", label: "风池-肩井", points: ["风池", "肩井"] },
];

const knownRoutes = new Map(NOSE_THREE_LINE_GINGER_ROUTES.map((route) => [route.code, route]));

function cleanRoutePart(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizeRoute(value: unknown): RehabRoute | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const code = cleanRoutePart(raw.code, 64);
  if (!/^[a-z0-9][a-z0-9_]{0,63}$/u.test(code)) return null;
  const known = knownRoutes.get(code);
  if (known) return { code: known.code, label: known.label, points: [...known.points] };
  const label = cleanRoutePart(raw.label, 80);
  const points = Array.isArray(raw.points)
    ? raw.points.map((point) => cleanRoutePart(point, 40)).filter(Boolean).slice(0, 8)
    : [];
  if (!label || points.length < 2) return null;
  return { code, label, points };
}

export function normalizeRehabRoutes(value: unknown): RehabRoute[] {
  const values = Array.isArray(value)
    ? value
    : Array.isArray((value as { routeCodes?: unknown } | null)?.routeCodes)
      ? ((value as { routeCodes: unknown[] }).routeCodes).map((code) => ({ code }))
      : [];
  const routes: RehabRoute[] = [];
  const seen = new Set<string>();
  for (const candidate of values) {
    const route = normalizeRoute(candidate);
    if (!route || seen.has(route.code)) continue;
    seen.add(route.code);
    routes.push(route);
  }
  return routes;
}

const knownPointGroups = new Map(REHAB_POINT_GROUP_DEFINITIONS.map((group) => [group.code, group]));

export function normalizeRehabPointGroups(value: unknown, methodCode?: unknown): RehabPointGroup[] {
  const values = Array.isArray(value)
    ? value
    : Array.isArray((value as { pointGroupCodes?: unknown } | null)?.pointGroupCodes)
      ? ((value as { pointGroupCodes: unknown[] }).pointGroupCodes).map((code) => ({ code }))
      : [];
  const groups: RehabPointGroup[] = [];
  const seen = new Set<string>();
  for (const candidate of values) {
    const code = typeof candidate === "string" ? candidate : candidate && typeof candidate === "object" && !Array.isArray(candidate) ? (candidate as Record<string, unknown>).code : null;
    const group = typeof code === "string" ? knownPointGroups.get(code) : null;
    if (!group || (methodCode && group.methodCode !== methodCode) || seen.has(group.code)) continue;
    seen.add(group.code);
    groups.push({ ...group, points: [...group.points] });
  }
  return groups;
}

export function routesForMethod(method: unknown): readonly RehabRoute[] {
  return method === "nose_three_line_ginger_scrape" ? NOSE_THREE_LINE_GINGER_ROUTES : [];
}
