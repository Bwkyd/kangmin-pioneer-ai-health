/**
 * 智能体安全评估适配层（demo 版）。
 *
 * legacy 的 /api/v1/agent/explain 是一次性提交整套安全评估表单；新内核
 * 患者侧可用的确定性路径是安全外壳会话（agent start → agent continue，
 * 目前只发布 urgentHelp 一个问题键）。本适配层把面板中的“危险信号”组
 * 归并为一个三态答案驱动该会话，并把会话结论映射回面板的结果视图。
 *
 * 注意：面板的其余分组（严重度/体质/康复方法安全项）在新规则包临床
 * 冻结前不送服务端，界面文案已如实说明，绝不伪造“已评估”。
 */

import { command } from "./command-client";

export type TriState = "yes" | "no" | "unknown";

// ---- 自由对话（agent exec）：chat 页底部输入的真实会话通道 ----

/** agent exec 单轮结果（与 src/modules/agent/conversation-contracts.ts 的 ConversationTurnResult 对应）。 */
export interface AgentTurnResult {
  conversationId: string;
  state: "active" | "completed" | "abandoned";
  /** 本轮助手输出；已结束的保存确认轮可能为 null。 */
  message: {
    role: string;
    content: string;
    contentHash: string;
    decisionId: string | null;
  } | null;
  /** 代码生成的固定 system_notice（如模型提取降级提示），如实展示。 */
  notices: Array<{ content: string; contentHash: string }>;
  verdict: {
    outcome: string;
    severityCode: string | null;
    syndromeCode: string | null;
    nextQuestions: Array<{ fieldCode: string; prompt: string }>;
    matchedRuleIds: string[];
    rulePackageVersion: string;
    rulePackageStatus: string;
  } | null;
  closed: boolean;
}

/** 发送一轮自由对话；带 conversationId 续接既有会话，缺省创建新会话。 */
export async function runAgentTurn(
  message: string,
  conversationId?: string
): Promise<AgentTurnResult> {
  return command<AgentTurnResult>("agent exec", {
    message,
    ...(conversationId === undefined ? {} : { conversationId })
  });
}

interface AgentSessionDto {
  id: string;
  status: "awaiting_answer" | "safety_blocked" | "completed";
  revision: number;
  nextQuestion: { key: "urgentHelp"; prompt: string } | null;
  outcome:
    | "urgent_help_required"
    | "cannot_confirm_safety"
    | "clinical_content_unavailable"
    | null;
  decisionEvidence: {
    ruleId: string;
    rulePackVersion: string;
  } | null;
}

/** 与面板 AgentResult 渲染结构对齐的结果视图（兼容 legacy 渲染分支）。 */
export interface SafetyAssessmentResult {
  assessment?: {
    status?: string;
    planStatus?: string;
    disclaimer?: string;
    nextQuestions?: string[];
    matchedRuleIds?: string[];
    reason?: string;
    stage?: string;
  };
  rehabSafety?: {
    status?: string;
    nextQuestions?: string[];
    blockedBy?: string[];
    blockedReasons?: string[];
    rulePackageVersion?: string;
    ruleSource?: string;
    disclaimer?: string;
  };
  explanation?: {
    summary?: string;
    disclaimer?: string;
    plan?: {
      title: string;
      summary: string;
      methodLabel: string;
      routes: Array<{ code: string; label: string; points: string[] }>;
      pointGroups: Array<{ code: string; label: string; methodCode: string; points: string[]; relation?: string }>;
      risks: string;
      contraindications: string;
      steps: Array<{ title: string; instruction: string }>;
    };
  };
  model?: { used?: boolean; degradedReason?: string };
}

function urgentHelpAnswer(safety: Record<string, TriState>): TriState {
  const answers = Object.values(safety);
  if (answers.includes("yes")) return "yes";
  if (answers.includes("unknown")) return "unknown";
  return "no";
}

export async function runSafetyAssessment(
  safety: Record<string, TriState>
): Promise<SafetyAssessmentResult> {
  const started = await command<AgentSessionDto>("agent start");
  const session = await command<AgentSessionDto>("agent continue", {
    id: started.id,
    expectedRevision: started.revision,
    question: "urgentHelp",
    answer: urgentHelpAnswer(safety)
  });
  const rulePackageVersion = session.decisionEvidence?.rulePackVersion;

  if (session.outcome === "urgent_help_required") {
    return {
      assessment: {
        status: "blocked",
        matchedRuleIds: ["urgentHelp"],
        disclaimer: "结果不能替代门诊诊断。"
      },
      explanation: {
        summary: "检测到需要立即就医的紧急情况，本工具不会给出居家操作建议。"
      },
      model: { used: false }
    };
  }
  if (session.outcome === "cannot_confirm_safety") {
    return {
      assessment: {
        status: "need_more_information",
        nextQuestions: ["urgentHelp"],
        disclaimer: "不确定不会被当成没有；请先确认安全风险。"
      },
      explanation: {
        summary: "还有安全信息未确认，服务端按 fail-closed 处理，未给出操作建议。"
      },
      model: { used: false }
    };
  }
  return {
    assessment: {
      status: "classified",
      disclaimer: "筛查已完成；当前没有可返回的已审核方案。"
    },
    rehabSafety: {
      status: "clear",
      ...(rulePackageVersion ? { rulePackageVersion } : {}),
      ruleSource: "服务端固定规则（安全外壳）"
    },
    explanation: {
      summary: "未发现需要立即就医的危险信号。"
    },
    model: { used: false }
  };
}
