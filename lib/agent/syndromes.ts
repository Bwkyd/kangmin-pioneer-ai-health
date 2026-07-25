export const SYNDROME_OPTIONS = [
  { code: "LUNG_HEAT", label: "肺经伏热" },
  { code: "LUNG_QI_COLD", label: "肺气虚寒" },
  { code: "SPLEEN_QI_DEF", label: "脾气虚弱" },
  { code: "KIDNEY_YANG_DEF", label: "肾阳亏虚" },
  { code: "MIXED_COLD_HEAT", label: "寒热错杂" },
] as const;

export type SyndromeCode = (typeof SYNDROME_OPTIONS)[number]["code"];

export const SYNDROME_CODES = SYNDROME_OPTIONS.map(({ code }) => code) as readonly SyndromeCode[];
