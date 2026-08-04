/**
 * 康复方法选项目录（移植自 legacy/lib/agent/rehab-methods.ts，仅保留
 * 患者端安全评估面板需要的方法清单；路线/穴位常量随正式方案审核后接入）。
 */
export const REHAB_METHOD_DEFINITIONS = [
  {
    code: "nose_three_line_ginger_scrape",
    label: "鼻三线姜刮",
    note: "不等同于普通刮痧"
  },
  {
    code: "gua_sha",
    label: "刮痧",
    note: "独立安全门禁（#94–#96），临床确认前不可发布"
  },
  {
    code: "finger_pressure_yingxiang",
    label: "指腹擦迎香",
    note: ""
  },
  {
    code: "acupoint_massage",
    label: "穴位按摩",
    note: ""
  },
  {
    code: "ear_acupressure",
    label: "耳穴压豆",
    note: ""
  },
  {
    code: "moxa_dazhui_fengchi",
    label: "艾灸大椎、风池",
    note: "参数和禁忌待临床确认"
  },
  {
    code: "electric_blow_dazhui_fengchi",
    label: "电吹风吹大椎、风池",
    note: "参数和禁忌待临床确认"
  }
] as const;
