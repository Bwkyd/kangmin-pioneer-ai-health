/**
 * 问卷选项值 → 判定字段确定性映射（智能体设计 v4：多选题保真）。
 *
 * 前端渲染客户问卷原题原选项按钮，点击只传稳定选项值（如 q1=B），
 * 服务端本表确定性映射到临床字段；前端与模型均不复制本映射。
 * 映射值草案标注供医学审核（客户反馈后回写），见
 * docs/product/2026-08-09-智能体设计-决策记录.md 待确认清单 5。
 */

export interface QuestionOptionDef {
  /** 映射到的判定字段；null = 仅信息收集，不参与判定（Q5/Q7/Q12-14）。 */
  field: string | null;
  options: Record<string, string>;
}

export interface ParsedOptionPayload {
  question: string;
  option: string;
  field: string | null;
  state: string | null;
}

const QUESTION_MAP: Record<string, QuestionOptionDef> = {
  q1: { field: "paroxysmal_sneezing", options: { A: "yes", B: "yes", C: "no" } },
  q2: { field: "watery_rhinorrhea", options: { A: "yes", B: "no", C: "no", D: "no" } },
  q3: { field: "nasal_congestion", options: { A: "yes", B: "yes", C: "yes", D: "no" } },
  q4: { field: "nasal_itching", options: { A: "yes", B: "yes", C: "no" } },
  q5: { field: null, options: {} },
  q6: { field: "fear_wind", options: { A: "yes", B: "yes", C: "no" } },
  q7: { field: null, options: {} },
  q8: { field: "fatigue", options: { A: "yes", B: "yes", C: "no" } },
  q9: { field: "limbs_not_warm", options: { A: "yes", B: "yes", C: "no" } },
  q10: { field: "thirst", options: { A: "yes", B: "yes", C: "no" } },
  q11: { field: "heat_imbalance", options: { A: "no", B: "yes", C: "no", D: "no" } },
  q12: { field: null, options: {} },
  q13: { field: null, options: {} },
  q14: { field: null, options: {} }
};

/** 未命中（非法题号/选项）返回 null：不猜测，留给自由文本/兜底路径。 */
export function parseOptionPayload(message: string): ParsedOptionPayload | null {
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
  return {
    question,
    option,
    field: def.field ?? null,
    state: def.options[option] ?? null
  };
}

/** 判定字段 → 问卷题号（供前端在补问字段时选择对应问卷卡片；UI 呈现层映射）。 */
export const FIELD_TO_QUESTION: Record<string, string> = {
  paroxysmal_sneezing: "q1",
  watery_rhinorrhea: "q2",
  nasal_congestion: "q3",
  nasal_itching: "q4",
  fear_wind: "q6",
  fatigue: "q8",
  limbs_not_warm: "q9",
  thirst: "q10",
  heat_imbalance: "q11"
};
