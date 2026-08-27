/**
 * 客户确认的六步证型决策树。
 *
 * 这是有序状态机，不是可以任意重排的症状条件集合。同名的 Q8/Q10
 * 二次确认拥有独立节点身份；调用方必须以 state=value、value=A|B|C
 * 保存患者确认选项。
 */

import type { NextQuestion } from "./contracts.js";
import type { FactMap } from "./domain.js";

export type SyndromeNodeCode =
  | "step1_q10"
  | "step2_q8"
  | "step3_q6"
  | "step4_q9"
  | "step5_q8_confirm"
  | "step6_q10_confirm";

export type SyndromeOption = "A" | "B" | "C";

export interface SyndromeLeaf {
  syndromeCode:
    | "LUNG_HEAT"
    | "SPLEEN_QI_DEF"
    | "LUNG_QI_COLD"
    | "KIDNEY_YANG_DEF"
    | "COLD_HEAT_COMPLEX";
  ruleId: string;
  message: string;
}

type Transition = SyndromeNodeCode | SyndromeLeaf;

interface SyndromeNode {
  question: NextQuestion;
  transitions: Record<SyndromeOption, Transition>;
}

const leaf = (
  syndromeCode: SyndromeLeaf["syndromeCode"],
  ruleId: string,
  message: string
): SyndromeLeaf => ({ syndromeCode, ruleId, message });

export const SYNDROME_TREE_ROOT: SyndromeNodeCode = "step1_q10";

export const SYNDROME_TREE: Readonly<Record<SyndromeNodeCode, SyndromeNode>> = {
  step1_q10: {
    question: {
      fieldCode: "step1_q10",
      prompt: "您是否经常感觉口干、想喝水？"
    },
    transitions: {
      A: leaf("LUNG_HEAT", "SDT-01-A", "肺经伏热，上犯鼻窍。"),
      B: "step2_q8",
      C: "step2_q8"
    }
  },
  step2_q8: {
    question: {
      fieldCode: "step2_q8",
      prompt: "您是否经常感觉疲倦、没力气？"
    },
    transitions: {
      A: leaf("SPLEEN_QI_DEF", "SDT-02-A", "脾气虚弱，清阳不升。"),
      B: "step3_q6",
      C: "step3_q6"
    }
  },
  step3_q6: {
    question: {
      fieldCode: "step3_q6",
      prompt: "您是否比别人更怕风、怕冷？"
    },
    transitions: {
      A: "step4_q9",
      B: "step4_q9",
      C: "step4_q9"
    }
  },
  step4_q9: {
    question: {
      fieldCode: "step4_q9",
      prompt: "您的手脚是否经常冰凉？"
    },
    transitions: {
      A: "step5_q8_confirm",
      B: leaf("LUNG_QI_COLD", "SDT-04-B", "肺气虚寒，卫表不固。"),
      C: leaf("LUNG_QI_COLD", "SDT-04-C", "肺气虚寒，卫表不固。")
    }
  },
  step5_q8_confirm: {
    question: {
      fieldCode: "step5_q8_confirm",
      prompt: "再次确认：您是否经常感觉疲倦、没力气？"
    },
    transitions: {
      A: leaf("KIDNEY_YANG_DEF", "SDT-05-A", "肾阳不足，温煦失职。"),
      B: "step6_q10_confirm",
      C: "step6_q10_confirm"
    }
  },
  step6_q10_confirm: {
    question: {
      fieldCode: "step6_q10_confirm",
      prompt: "再次确认：您是否经常感觉口干、想喝水？"
    },
    transitions: {
      A: leaf("COLD_HEAT_COMPLEX", "SDT-06-A", "寒热错杂，虚实并见。"),
      B: leaf("KIDNEY_YANG_DEF", "SDT-06-B", "肾阳不足，温煦失职。"),
      C: leaf("KIDNEY_YANG_DEF", "SDT-06-C", "肾阳不足，温煦失职。")
    }
  }
};

export type SyndromeTreeResult =
  | { kind: "need_answer"; nodeCode: SyndromeNodeCode; question: NextQuestion }
  | { kind: "classified"; leaf: SyndromeLeaf }
  | { kind: "invalid_answer"; nodeCode: SyndromeNodeCode };

export function evaluateSyndromeDecisionTree(facts: FactMap): SyndromeTreeResult {
  let nodeCode: SyndromeNodeCode = SYNDROME_TREE_ROOT;
  const visited = new Set<SyndromeNodeCode>();

  while (!visited.has(nodeCode)) {
    visited.add(nodeCode);
    const node = SYNDROME_TREE[nodeCode];
    const answer = facts.get(nodeCode);
    if (answer === null) {
      return { kind: "need_answer", nodeCode, question: node.question };
    }
    if (
      answer.state !== "value" ||
      typeof answer.value !== "string" ||
      !Object.hasOwn(node.transitions, answer.value.toUpperCase())
    ) {
      return { kind: "invalid_answer", nodeCode };
    }
    const option = answer.value.toUpperCase() as SyndromeOption;
    const transition = node.transitions[option];
    if (typeof transition === "string") {
      nodeCode = transition;
      continue;
    }
    return { kind: "classified", leaf: transition };
  }

  // 常量树若被错误改成环，必须 fail-closed，不能无限循环。
  return { kind: "invalid_answer", nodeCode };
}

export interface SyndromeTreePath {
  answers: ReadonlyArray<{ nodeCode: SyndromeNodeCode; option: SyndromeOption }>;
  leaf: SyndromeLeaf;
}

/** 由规范树生成全部根到叶路径，供穷举验收和 benchmark 共用。 */
export function enumerateSyndromeTreePaths(): SyndromeTreePath[] {
  const paths: SyndromeTreePath[] = [];
  const visit = (
    nodeCode: SyndromeNodeCode,
    answers: Array<{ nodeCode: SyndromeNodeCode; option: SyndromeOption }>,
    active: Set<SyndromeNodeCode>
  ): void => {
    if (active.has(nodeCode)) {
      throw new Error(`证型决策树存在循环：${nodeCode}`);
    }
    const nextActive = new Set(active).add(nodeCode);
    for (const option of ["A", "B", "C"] as const) {
      const nextAnswers = [...answers, { nodeCode, option }];
      const transition = SYNDROME_TREE[nodeCode].transitions[option];
      if (typeof transition === "string") {
        visit(transition, nextAnswers, nextActive);
      } else {
        paths.push({ answers: nextAnswers, leaf: transition });
      }
    }
  };
  visit(SYNDROME_TREE_ROOT, [], new Set());
  return paths;
}
