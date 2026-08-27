/**
 * 临床规则包 clinical-rules-v3（status=approved，2026-08-09 客户纠正确认）。
 *
 * v3 明确拆开两类客户资料：
 * - 《页面展示》唯一决定 Q1-Q14 的题面、选项、顺序和结果结构；
 * - 《前置规则》及客户确认六步树唯一决定证型跳转、终止和期别。
 * 旧安全/筛查/严重度规则保留作历史包兼容，不再插入 page_q1_q14 页面流程。
 *
 * 当前开发和验收采用的客户确认资料引用见 sourceRefs：
 * - 《前置规则》：证型决策树及急性期/缓解期判定；
 * - 《页面展示》：Q1-Q14 题面、选项、顺序和结果结构；
 * - 《急性期方案、调体方案（缓解期方案）》：急性期方案和各证型调体方案。
 * 开发侧补充的高风险兜底规则属于程序安全约束，不冒充客户资料原文。
 *
 * 临床红线：正式患者输出路径只允许 approved 包；规则变更须走开发发布流程
 * （架构 §16.2），模型与后台无权修改本包。
 */

import { createHash } from "node:crypto";

import type { ClinicalRule, RulePackage } from "./domain.js";
import { ASSESSMENT_QUESTIONS } from "./assessment-questionnaire.js";
import { SYNDROME_TREE } from "./syndrome-decision-tree.js";

export { FIELD_LABELS } from "./domain.js";

export const DRAFT_PACKAGE_VERSION = "clinical-rules-v3";
export const DRAFT_PACKAGE_STATUS = "approved" as const;

export const SOURCE_REFS: string[] = [
  "vault/truth/前置规则.md",
  "vault/truth/页面展示.md",
  "vault/truth/急性期方案、调体方案（缓解期方案）.md"
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
  }
];

/** screening 阶段：确诊门禁（诊断库 §1①，作者拍板 3）+ 人群派生（作者拍板 4）。
 *  unknown 特判在内核（A4）：仅 diagnosed_confirmed 白名单按 no→转介。 */
const SCREENING_RULES: readonly ClinicalRule[] = [
  {
    id: "S-01",
    stage: "screening",
    outcome: "non_applicable",
    message:
      "本工具的调理方案仅适用于已确诊的过敏性鼻炎患者。您尚未确认由医生确诊过过敏性鼻炎，建议先到正规医院耳鼻喉科明确诊断，切勿盲目外治。",
    nextQuestions: [
      {
        fieldCode: "diagnosed_confirmed",
        prompt: "您是否由医生确诊过过敏性鼻炎？"
      }
    ],
    conditions: [{ fieldCode: "diagnosed_confirmed", state: "no" }]
  },
  {
    id: "S-02",
    stage: "screening",
    outcome: "classified",
    code: "child",
    message: null,
    nextQuestions: [
      {
        fieldCode: "child_under_12",
        prompt: "您是否未满 12 周岁？（未满 12 周岁按儿童方案提供建议）"
      }
    ],
    conditions: [{ fieldCode: "child_under_12", state: "yes" }]
  },
  {
    id: "S-03",
    stage: "screening",
    outcome: "classified",
    code: "adult",
    message: null,
    nextQuestions: [
      {
        fieldCode: "child_under_12",
        prompt: "您是否未满 12 周岁？（未满 12 周岁按儿童方案提供建议）"
      }
    ],
    conditions: [{ fieldCode: "child_under_12", state: "no" }]
  }
];

/** phase 阶段：Q1 选项值映射 paroxysmal_sneezing → 期别（决定⑤：《前置规则》Q1 为准）。
 *  仅作期别派生，不阻断；映射表见 option-mapping.ts。 */
const PHASE_RULES: readonly ClinicalRule[] = [
  {
    id: "P-01",
    stage: "phase",
    outcome: "classified",
    code: "acute",
    message: null,
    nextQuestions: [
      {
        fieldCode: "paroxysmal_sneezing",
        prompt: "您打喷嚏的情况是？（频繁 / 偶尔为急性发作，基本不打为缓解期）"
      }
    ],
    conditions: [{ fieldCode: "paroxysmal_sneezing", state: "yes" }]
  },
  {
    id: "P-02",
    stage: "phase",
    outcome: "classified",
    code: "remission",
    message: null,
    nextQuestions: [
      {
        fieldCode: "paroxysmal_sneezing",
        prompt: "您打喷嚏的情况是？（频繁 / 偶尔为急性发作，基本不打为缓解期）"
      }
    ],
    conditions: [{ fieldCode: "paroxysmal_sneezing", state: "no" }]
  }
];

const APPLICABILITY_RULES: readonly ClinicalRule[] = [
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
  syndromeStrategy: "ordered_six_step";
  questionnaireStrategy: "page_q1_q14";
}): string {
  return createHash("sha256")
    // 题面和状态机不是 rules 数组的一部分，也必须进入包哈希；否则只改
    // 页面/跳转却不会让旧会话失效。
    .update(JSON.stringify({
      ...pack,
      questionnaire: ASSESSMENT_QUESTIONS,
      syndromeTree: SYNDROME_TREE
    }), "utf8")
    .digest("hex");
}

const base = {
  version: DRAFT_PACKAGE_VERSION,
  status: DRAFT_PACKAGE_STATUS,
  sourceRefs: SOURCE_REFS,
  rules: SAFETY_RULES.concat(
    SCREENING_RULES,
    PHASE_RULES,
    APPLICABILITY_RULES,
    SEVERITY_RULES
  ),
  planSafetyRules: PLAN_SAFETY_RULES,
  syndromeStrategy: "ordered_six_step" as const,
  questionnaireStrategy: "page_q1_q14" as const
};

/** 运行时只读加载的已冻结规则包；变更须走开发发布流程（架构 §16.2）。 */
export const DRAFT_RULE_PACKAGE: RulePackage = {
  ...base,
  checksum: packageChecksum(base)
};
