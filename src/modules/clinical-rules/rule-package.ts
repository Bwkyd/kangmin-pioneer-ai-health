/**
 * Draft 规则包：clinical-rules-draft-v0（status=candidate，未临床冻结）。
 *
 * 规则来源（只读客户资料，全部引用见 sourceRefs）：
 * - 过敏性鼻炎辩证分级诊断库：§1 前置通用规则（仅接诊鼻鼽）、§3 四型辨证判定
 *   （5 条决策树规则）、§4 ARIA 严重度 4 问、§5 鉴别排除、§6 高危兜底提示；
 * - 03-技术资料-鼻鼽辨治规律与决策树研究：决策树“口渴”为根节点的证型规律；
 * - 证型→基础方案映射表：证型-方法安全（肺经伏热禁灸助热、皮损禁刮痧拔罐）。
 *
 * 临床红线：本包 status=candidate，正式患者输出路径必须硬阻断；
 * draft 规则只允许出现在 `agent test run` 模拟链路。
 * approved 只能由开发发布流程在取得临床冻结证据后产生（架构 §16.2）。
 */

import { createHash } from "node:crypto";

import type { ClinicalRule, RulePackage } from "./domain.js";

export { FIELD_LABELS } from "./domain.js";

export const DRAFT_PACKAGE_VERSION = "clinical-rules-draft-v0";
export const DRAFT_PACKAGE_STATUS = "candidate" as const;

export const SOURCE_REFS: string[] = [
  "docs/客户资料/42md转换/过敏性鼻炎辩证分级诊断库(2).md",
  "docs/客户资料/42md转换/03-技术资料-鼻鼽辨治规律与决策树研究.md",
  "docs/客户资料/42md转换/证型→基础方案映射表(1).md"
];

const SAFETY_RULES: readonly ClinicalRule[] = [
  {
    id: "SAF-01",
    stage: "safety",
    outcome: "blocked",
    message:
      "您存在需要立即急救的呼吸系统高风险表现（呼吸困难、喘不上气、胸闷憋气、喘息或口唇发紫），本工具不提供任何调理建议，请立即就医。",
    nextQuestions: [
      {
        fieldCode: "urgent_help",
        prompt: "您是否现在呼吸困难、喘不上气、胸闷憋气，或口唇发紫？"
      }
    ],
    conditions: [{ fieldCode: "urgent_help", state: "yes" }]
  },
  {
    id: "SAF-02",
    stage: "safety",
    outcome: "blocked",
    message:
      "持续高热属于最高风险红线（体温超过 39℃ 持续 3 天不退或伴寒战），本工具不提供任何调理建议，请立即线下就医。",
    nextQuestions: [
      {
        fieldCode: "high_fever",
        prompt: "您是否体温超过 39℃ 持续 3 天不退，或伴有寒战？"
      }
    ],
    conditions: [{ fieldCode: "high_fever", state: "yes" }]
  },
  {
    id: "SAF-03",
    stage: "safety",
    outcome: "blocked",
    message:
      "鼻腔大量鲜血、反复流鼻血不止或单侧流恶臭脓血涕属于最高风险红线，本工具不提供任何调理建议，请立即线下就医。",
    nextQuestions: [
      {
        fieldCode: "epistaxis_foul_discharge",
        prompt: "您是否鼻腔流出大量鲜血、反复流鼻血不止，或单侧流恶臭脓血涕？"
      }
    ],
    conditions: [{ fieldCode: "epistaxis_foul_discharge", state: "yes" }]
  },
  {
    id: "SAF-04",
    stage: "safety",
    outcome: "blocked",
    message:
      "爆炸样头痛、视力模糊、复视或喷射性呕吐属于最高风险神经症状，本工具不提供任何调理建议，请立即线下就医。",
    nextQuestions: [
      {
        fieldCode: "severe_neuro_symptoms",
        prompt: "您是否有爆炸样头痛、视力模糊、复视，或恶心喷射性呕吐？"
      }
    ],
    conditions: [{ fieldCode: "severe_neuro_symptoms", state: "yes" }]
  },
  {
    id: "SAF-05",
    stage: "safety",
    outcome: "blocked",
    message:
      "调理部位存在皮肤破损、溃烂或皮疹，外治（刮痧、拔罐、灸法）禁做，请先处理皮损并咨询门诊。",
    nextQuestions: [
      {
        fieldCode: "skin_lesion",
        prompt: "您需要调理的部位皮肤是否有破损、溃烂或皮疹？"
      }
    ],
    conditions: [{ fieldCode: "skin_lesion", state: "yes" }]
  },
  {
    id: "SAF-06",
    stage: "safety",
    outcome: "blocked",
    message:
      "孕期属于外治禁忌，本工具不提供孕期调理建议，请咨询产科与耳鼻喉科门诊。",
    nextQuestions: [
      {
        fieldCode: "pregnancy",
        prompt: "您目前是否怀孕（或可能怀孕）？"
      }
    ],
    conditions: [{ fieldCode: "pregnancy", state: "yes" }]
  },
  {
    id: "SAF-07",
    stage: "safety",
    outcome: "blocked",
    message:
      "儿童调理方案尚未完成临床批准，本工具暂不提供儿童个性化方案，请咨询门诊。",
    nextQuestions: [
      {
        fieldCode: "child_under_12",
        prompt: "您是否未满 12 周岁？"
      }
    ],
    conditions: [{ fieldCode: "child_under_12", state: "yes" }]
  }
];

const APPLICABILITY_RULES: readonly ClinicalRule[] = [
  {
    // 诊断库 §1①：仅接诊过敏性鼻炎；主症（喷嚏、清涕、鼻痒、鼻塞）
    // 不足两项时拒绝诊断。反转计数条件：<2 项主症时命中。
    id: "APP-01",
    stage: "applicability",
    outcome: "non_applicable",
    message:
      "根据您的描述，目前症状不完全符合鼻鼽（过敏性鼻炎）的典型特征。本工具的调理方案仅适用于过敏性鼻炎及慢性鼻炎体质调理，建议您先到正规医院耳鼻喉科明确诊断，切勿盲目外治。",
    nextQuestions: [
      { fieldCode: "paroxysmal_sneezing", prompt: "您是否有阵发性喷嚏（数十个连发）？" },
      { fieldCode: "watery_rhinorrhea", prompt: "您是否有大量清水样鼻涕？" },
      { fieldCode: "nasal_itching", prompt: "您是否有鼻痒（可伴眼痒、咽痒）？" },
      { fieldCode: "nasal_congestion", prompt: "您是否有鼻塞？" }
    ],
    conditions: [
      {
        fieldCodes: [
          "paroxysmal_sneezing",
          "watery_rhinorrhea",
          "nasal_itching",
          "nasal_congestion"
        ],
        minYes: 2
      }
    ],
    inverted: true
  },
  {
    id: "APP-02",
    stage: "applicability",
    outcome: "non_applicable",
    message:
      "根据您的描述，目前症状更倾向于普通感冒（发热、畏寒、头痛、肌肉酸痛，7~10 天自愈），不属于鼻鼽典型特征。本工具仅适用于过敏性鼻炎及慢性鼻炎体质调理，建议先到正规医院明确诊断。",
    nextQuestions: [
      {
        fieldCode: "cold_like_symptoms",
        prompt: "您是否有发热、畏寒、头痛、肌肉酸痛等感冒样表现？"
      }
    ],
    conditions: [{ fieldCode: "cold_like_symptoms", state: "yes" }]
  },
  {
    id: "APP-03",
    stage: "applicability",
    outcome: "non_applicable",
    message:
      "根据您的描述，目前症状更倾向于鼻窦炎（黄绿色脓性黏稠涕伴臭味、面部胀痛、牙痛、头昏沉、病程超过 10 天），不属于鼻鼽典型特征。本工具仅适用于过敏性鼻炎及慢性鼻炎体质调理，建议先到正规医院明确诊断。",
    nextQuestions: [
      {
        fieldCode: "sinusitis_like_symptoms",
        prompt: "您是否有黄绿色脓涕伴臭味、面部胀痛或牙痛等鼻窦炎样表现？"
      }
    ],
    conditions: [{ fieldCode: "sinusitis_like_symptoms", state: "yes" }]
  }
];

const SEVERITY_RULES: readonly ClinicalRule[] = [
  {
    id: "SEV-01",
    stage: "severity",
    outcome: "classified",
    code: "moderate_severe",
    message: "症状已影响睡眠，判定为中重度。",
    nextQuestions: [
      {
        fieldCode: "sleep_affected",
        prompt: "过去一周，鼻炎症状是否影响您的夜间睡眠质量？"
      }
    ],
    conditions: [{ fieldCode: "sleep_affected", state: "yes" }]
  },
  {
    id: "SEV-02",
    stage: "severity",
    outcome: "classified",
    code: "moderate_severe",
    message: "症状已影响日常活动，判定为中重度。",
    nextQuestions: [
      {
        fieldCode: "daily_activity_affected",
        prompt: "过去一周，鼻炎症状是否影响您的日常活动（如运动、社交）？"
      }
    ],
    conditions: [{ fieldCode: "daily_activity_affected", state: "yes" }]
  },
  {
    id: "SEV-03",
    stage: "severity",
    outcome: "classified",
    code: "moderate_severe",
    message: "症状已影响工作或学习，判定为中重度。",
    nextQuestions: [
      {
        fieldCode: "work_study_affected",
        prompt: "过去一周，鼻炎症状是否影响您的工作或学习效率？"
      }
    ],
    conditions: [{ fieldCode: "work_study_affected", state: "yes" }]
  },
  {
    id: "SEV-04",
    stage: "severity",
    outcome: "classified",
    code: "moderate_severe",
    message: "症状已让您感到难以忍受，判定为中重度。",
    nextQuestions: [
      {
        fieldCode: "symptoms_intolerable",
        prompt: "过去一周，鼻炎症状是否让您感到难以忍受？"
      }
    ],
    conditions: [{ fieldCode: "symptoms_intolerable", state: "yes" }]
  },
  {
    // ARIA：4 问全部“否” → 轻度。反转为计数条件；字段未知时必须补问
    // （否则未知会被当作“全否”而误判轻度——unknown 不等于 no）。
    id: "SEV-05",
    stage: "severity",
    outcome: "classified",
    code: "mild",
    message: "四项生活质量影响均未出现，判定为轻度。",
    nextQuestions: [
      {
        fieldCode: "sleep_affected",
        prompt: "过去一周，鼻炎症状是否影响您的夜间睡眠质量？"
      },
      {
        fieldCode: "daily_activity_affected",
        prompt: "过去一周，鼻炎症状是否影响您的日常活动（如运动、社交）？"
      },
      {
        fieldCode: "work_study_affected",
        prompt: "过去一周，鼻炎症状是否影响您的工作或学习效率？"
      },
      {
        fieldCode: "symptoms_intolerable",
        prompt: "过去一周，鼻炎症状是否让您感到难以忍受？"
      }
    ],
    conditions: [
      {
        fieldCodes: [
          "sleep_affected",
          "daily_activity_affected",
          "work_study_affected",
          "symptoms_intolerable"
        ],
        minYes: 1
      }
    ],
    inverted: true
  }
];

const SYNDROME_RULES: readonly ClinicalRule[] = [
  {
    // T1 肺经伏热：口渴是核心（非黄涕），但口渴+四肢不温+无倦怠乏力
    // 属于 T5 寒热错杂（决策树分支），故 T1 排除该组合。
    id: "T1",
    stage: "syndrome",
    outcome: "classified",
    code: "LUNG_HEAT",
    message: "肺经伏热，上犯鼻窍。",
    nextQuestions: [
      { fieldCode: "thirst", prompt: "您近一周是否口渴（总想喝水，或咽干口燥）？" },
      { fieldCode: "limbs_not_warm", prompt: "您近一周是否四肢不温（手脚经常冰凉）？" },
      { fieldCode: "fatigue", prompt: "您近一周是否倦怠乏力（容易累，没精神）？" }
    ],
    conditions: [
      { fieldCode: "thirst", state: "yes" },
      { anyOf: [{ fieldCode: "limbs_not_warm", state: "no" }, { fieldCode: "fatigue", state: "yes" }] }
    ]
  },
  {
    id: "T2",
    stage: "syndrome",
    outcome: "classified",
    code: "SPLEEN_QI_DEF",
    message: "脾气虚弱，清阳不升。",
    nextQuestions: [
      { fieldCode: "fatigue", prompt: "您近一周是否倦怠乏力（容易累，没精神）？" },
      { fieldCode: "thirst", prompt: "您近一周是否口渴（总想喝水，或咽干口燥）？" }
    ],
    conditions: [
      { fieldCode: "fatigue", state: "yes" },
      { fieldCode: "thirst", state: "no" }
    ]
  },
  {
    id: "T3",
    stage: "syndrome",
    outcome: "classified",
    code: "LUNG_QI_COLD",
    message: "肺气虚寒，卫表不固。",
    nextQuestions: [
      { fieldCode: "fear_wind", prompt: "您近一周是否怕风（吹风时鼻痒、喷嚏加重）？" },
      { fieldCode: "limbs_not_warm", prompt: "您近一周是否四肢不温（手脚经常冰凉）？" },
      { fieldCode: "fatigue", prompt: "您近一周是否倦怠乏力（容易累，没精神）？" },
      { fieldCode: "thirst", prompt: "您近一周是否口渴（总想喝水，或咽干口燥）？" }
    ],
    conditions: [
      { fieldCode: "fear_wind", state: "yes" },
      { fieldCode: "limbs_not_warm", state: "no" },
      { fieldCode: "fatigue", state: "no" },
      { fieldCode: "thirst", state: "no" }
    ]
  },
  {
    id: "T4",
    stage: "syndrome",
    outcome: "classified",
    code: "KIDNEY_YANG_DEF",
    message: "肾阳不足，温煦失职。",
    nextQuestions: [
      { fieldCode: "cold_intolerance", prompt: "您近一周是否形寒肢冷（特别怕冷，穿得比别人多）？" },
      { fieldCode: "limbs_not_warm", prompt: "您近一周是否四肢不温（手脚经常冰凉）？" },
      { fieldCode: "fatigue", prompt: "您近一周是否倦怠乏力（容易累，没精神）？" },
      { fieldCode: "thirst", prompt: "您近一周是否口渴（总想喝水，或咽干口燥）？" }
    ],
    conditions: [
      { fieldCode: "cold_intolerance", state: "yes" },
      { fieldCode: "limbs_not_warm", state: "yes" },
      { fieldCode: "fatigue", state: "no" },
      { fieldCode: "thirst", state: "no" }
    ]
  },
  {
    // 寒热错杂：口渴+四肢不温+无倦怠乏力（最难掌握的组合）。
    id: "T5",
    stage: "syndrome",
    outcome: "classified",
    code: "COLD_HEAT_COMPLEX",
    message: "寒热错杂，虚实并见。",
    nextQuestions: [
      { fieldCode: "limbs_not_warm", prompt: "您近一周是否四肢不温（手脚经常冰凉）？" },
      { fieldCode: "fatigue", prompt: "您近一周是否倦怠乏力（容易累，没精神）？" },
      { fieldCode: "thirst", prompt: "您近一周是否口渴（总想喝水，或咽干口燥）？" }
    ],
    conditions: [
      { fieldCode: "limbs_not_warm", state: "yes" },
      { fieldCode: "fatigue", state: "no" },
      { fieldCode: "thirst", state: "yes" }
    ]
  }
];

/** 方案安全规则：匹配到方案后，方法属性与患者事实冲突时阻断。 */
const PLAN_SAFETY_RULES: readonly ClinicalRule[] = [
  {
    // 证型→基础方案映射表：肺经伏热 ⚠️ 不推荐灸法（助热）。
    id: "MSAF-01",
    stage: "plan_safety",
    outcome: "blocked",
    message: "肺经伏热证型不推荐灸法（助热），方案已排除灸法，请以门诊方案为准。",
    nextQuestions: [],
    conditions: [
      { fieldCode: "syndrome_code", state: "value", value: "LUNG_HEAT" },
      { fieldCode: "moxibustion", state: "value", value: "yes" }
    ]
  },
  {
    // 皮损处禁做刮痧/拔罐。
    id: "MSAF-02",
    stage: "plan_safety",
    outcome: "blocked",
    message: "调理部位存在皮肤破损时禁做刮痧与拔罐，方案已排除相关步骤。",
    nextQuestions: [
      {
        fieldCode: "skin_lesion",
        prompt: "您需要调理的部位皮肤是否有破损、溃烂或皮疹？"
      }
    ],
    conditions: [
      { fieldCode: "skin_lesion", state: "yes" },
      { fieldCode: "guasha_cupping", state: "value", value: "yes" }
    ]
  }
];

function packageChecksum(pack: {
  version: string;
  status: string;
  sourceRefs: readonly string[];
  rules: readonly ClinicalRule[];
  planSafetyRules: readonly ClinicalRule[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify(pack), "utf8")
    .digest("hex");
}

const base = {
  version: DRAFT_PACKAGE_VERSION,
  status: DRAFT_PACKAGE_STATUS,
  sourceRefs: SOURCE_REFS,
  rules: SAFETY_RULES.concat(APPLICABILITY_RULES, SEVERITY_RULES, SYNDROME_RULES),
  planSafetyRules: PLAN_SAFETY_RULES
};

/** 运行时只读加载的候选规则包；approved 由开发发布流程产生。 */
export const DRAFT_RULE_PACKAGE: RulePackage = {
  ...base,
  checksum: packageChecksum(base)
};
