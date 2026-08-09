/**
 * 问卷选项值 → 判定字段确定性映射（智能体设计 v4：多选题保真）。
 *
 * 前端渲染客户问卷原题原选项按钮，点击只传稳定选项值（如 q1=B）。
 * 生产页面流程按 qN 保存原始 A/B/C/D；六步二次确认按独立节点保存 A/B/C。
 * 旧流水线的临床字段映射仅为历史包兼容，见
 * docs/product/2026-08-09-智能体设计-决策记录.md。
 */

export interface QuestionOptionDef {
  /** 旧语义映射字段；页面问卷流程以 qN 节点保存原始选项。 */
  field: string | null;
  options: Record<string, string>;
}

export interface ParsedOptionPayload {
  question: string;
  option: string;
  field: string | null;
  state: string | null;
  /** state=value 时保存原始选项 A/B/C。 */
  factValue: string | null;
}

const QUESTION_MAP: Record<string, QuestionOptionDef> = {
  q1: { field: "paroxysmal_sneezing", options: { A: "yes", B: "yes", C: "no" } },
  q2: { field: "watery_rhinorrhea", options: { A: "yes", B: "no", C: "no", D: "no" } },
  q3: { field: "nasal_congestion", options: { A: "yes", B: "yes", C: "yes", D: "no" } },
  q4: { field: "nasal_itching", options: { A: "yes", B: "yes", C: "no" } },
  q5: { field: null, options: { A: "value", B: "value", C: "value", D: "value" } },
  q6: { field: "fear_wind", options: { A: "yes", B: "yes", C: "no" } },
  q7: { field: null, options: { A: "value", B: "value", C: "value" } },
  q8: { field: "fatigue", options: { A: "yes", B: "yes", C: "no" } },
  q9: { field: "limbs_not_warm", options: { A: "yes", B: "yes", C: "no" } },
  q10: { field: "thirst", options: { A: "yes", B: "yes", C: "no" } },
  q11: { field: "heat_imbalance", options: { A: "no", B: "yes", C: "no", D: "no" } },
  q12: { field: null, options: { A: "value", B: "value", C: "value" } },
  q13: { field: null, options: { A: "value", B: "value" } },
  q14: { field: null, options: { A: "value", B: "value" } }
};

/** 未命中（非法题号/选项）返回 null：不猜测，留给自由文本/兜底路径。 */
export function parseOptionPayload(
  message: string,
  targets: readonly { fieldCode: string }[] = []
): ParsedOptionPayload | null {
  const trimmed = message.trim();
  const m = /^q(\d+)=([A-D])$/i.exec(trimmed);
  if (!m) {
    return null;
  }
  const question = `q${m[1]}`;
  const option = (m[2] ?? "").toUpperCase();
  const def = QUESTION_MAP[question];
  if (!def || !(option in def.options)) {
    return null;
  }

  const expectedField = targets.find(
    (target) => FIELD_TO_QUESTION[target.fieldCode] === question
  )?.fieldCode;
  if (targets.length > 0 && expectedField === undefined) {
    // 当前节点与载荷题号不一致：不把越序回答写入其他事实。
    return null;
  }
  if (
    expectedField?.startsWith("step") === true ||
    /^q(?:[1-9]|1[0-4])$/u.test(expectedField ?? "")
  ) {
    return {
      question,
      option,
      field: expectedField ?? null,
      state: "value",
      factValue: option
    };
  }
  return {
    question,
    option,
    field: expectedField ?? def.field ?? null,
    state: def.options[option] ?? null,
    factValue: null
  };
}

/** 判定字段 → 问卷题号（供前端在补问字段时选择对应问卷卡片；UI 呈现层映射）。 */
export const FIELD_TO_QUESTION: Record<string, string> = {
  q1: "q1",
  q2: "q2",
  q3: "q3",
  q4: "q4",
  q5: "q5",
  q6: "q6",
  q7: "q7",
  q8: "q8",
  q9: "q9",
  q10: "q10",
  q11: "q11",
  q12: "q12",
  q13: "q13",
  q14: "q14",
  paroxysmal_sneezing: "q1",
  watery_rhinorrhea: "q2",
  nasal_congestion: "q3",
  nasal_itching: "q4",
  fear_wind: "q6",
  fatigue: "q8",
  limbs_not_warm: "q9",
  thirst: "q10",
  heat_imbalance: "q11",
  step1_q10: "q10",
  step2_q8: "q8",
  step3_q6: "q6",
  step4_q9: "q9",
  step5_q8_confirm: "q8",
  step6_q10_confirm: "q10"
};
