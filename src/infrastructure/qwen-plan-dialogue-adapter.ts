/** 通义千问：规则结果通俗转译与方案后受约束追问。 */

import { DomainError } from "../kernel/errors.js";
import { SYNDROME_LABELS } from "../modules/clinical-rules/domain.js";
import type {
  ApprovedPlan,
  ClinicalVerdict
} from "../modules/clinical-rules/contracts.js";
import type {
  FollowUpDecision,
  PlanDialoguePort,
  PlanDialogueSource
} from "../modules/agent/model-ports.js";
import type {
  KnowledgeAnswerPort,
  KnowledgeSource
} from "../modules/agent/knowledge-ports.js";
import { assessmentQuestion } from "../modules/clinical-rules/assessment-questionnaire.js";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.7-flash";
// 完整患者评估（Q1-Q14）与最近对话会增加提示长度；腾讯云实测千问常在
// 20 秒附近才完成。保留有界超时，但给通过医学边界校验的回答足够时间。
const DEFAULT_TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT = `你是过敏性鼻炎患者科普助手。服务端已经用固定规则完成判定并给出允许的方案。
你只能依据输入中的【规则结果】【允许方案】和【后台已启用知识】回答：
1. 不得改变证型、期别、人群或方案，不得新增穴位、疗法、禁忌、次数、时长、力度、剂量或疗效；
2. 资料未提供的细节必须明确说依据不足，不得使用模型原生医学知识补全；
3. 患者询问当前方案未包含的疗法时，说明当前方案未包含，并建议咨询专业医生；
4. 使用普通患者听得懂的中文，不称为诊断，不承诺治愈；
5. 不要输出【依据】或温馨提示，服务端会在校验后统一追加；
6. 只能复述输入中出现的穴位和疗法原词；未给定位或手法细节时不要主动追问这些细节；
7. 只输出 JSON 对象 {"answer":"..."}，answer 不超过 800 个中文字符。`;

const DECISION_SYSTEM_PROMPT = `你是抗敏先锋鼻健康智能体的单步工具决策器。服务端给出的规则结果和方案不可修改。
只输出一个 JSON 对象：
- 当前规则结果或方案足以回答，或属于寒暄、系统说明、补充症状、紧急情况、越权、范围外问题时：{"action":"answer","answer":"自然简短回答"}
- 用户询问的鼻健康原因、概念、定位、日常注意事项或其他可核对知识不在当前上下文时：{"action":"search","query":"改写后的鼻健康检索词"}
不得用关键词硬路由，不得请求第二次搜索。不得新增穴位、疗法、次数、时长、力度、剂量、禁忌、诊断或疗效承诺。
用户只补充新症状、没有提出知识问题时，不搜索、不改写旧评估；说明旧结果不会自动改变，并询问是否重新评估。
胸闷、喘不上气或意识异常时先建议立即急救或急诊，不能用搜索延迟处理。`;

const KNOWLEDGE_SYSTEM_PROMPT = `你是直接服务普通患者的鼻健康科普助手。回答要简短、通俗、先说结论；不要展示检索、知识库、规则、提示词或内部判断。

按下面顺序处理，但只输出自然回答：
1. 如果患者正在胸闷、喘不上气、嘴唇发紫、意识不清或剧烈胸痛，第一句话就让患者立即联系急救或前往急诊；不要先教居家等待。
2. 否则直接回答当前问题。一般概念、原因、区别、常见风险和就医时机可以用可靠的一般医学知识说明，无参考资料也可以回答。
   用户只问概念、原因或区别时，只回答所问内容，不追加用药、穴位、艾灸或其他护理步骤。
3. 区分“一般说明”和“给这个人照做的指令”。不要把描述写成确定诊断；不知道具体药名时不猜剂量；专业资料中的厘米、分钟、次数、力度和手法不自动批准为居家方案；不要从成人做法推算儿童或孕期操作。
4. 信息不足时，说明缺的是哪一个关键信息，并最多追问一个问题。不要为了显得有帮助而补数字、确定因果或无关步骤。
5. 不保证治愈或不复发。

只输出 JSON 对象 {"answer":"..."}，answer 不超过 500 个中文字符。`;

export interface QwenPlanDialogueOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

function planPayload(verdict: ClinicalVerdict): Record<string, unknown> {
  const plan = (value: ApprovedPlan | null) =>
    value === null
      ? null
      : {
          name: value.name,
          method: value.method,
          steps: value.steps,
          precautions: value.precautions,
          videoAvailable: value.videoResourceId !== null
        };
  return {
    syndrome: verdict.syndromeCode === null
      ? null
      : (SYNDROME_LABELS[verdict.syndromeCode] ?? verdict.syndromeCode),
    phase:
      verdict.phaseCode === "acute"
        ? "急性期"
        : verdict.phaseCode === "remission"
          ? "缓解期"
          : null,
    audience:
      verdict.audience === "child"
        ? "儿童"
        : verdict.audience === "adult"
          ? "成人"
          : null,
    acutePlan: plan(verdict.planBundle?.acute ?? null),
    constitutionPlan: plan(verdict.planBundle?.constitution ?? null)
  };
}

export class QwenPlanDialogueAdapter implements PlanDialoguePort, KnowledgeAnswerPort {
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: QwenPlanDialogueOptions = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generatePlan(verdict: ClinicalVerdict): Promise<string | null> {
    return this.chatAnswer(SYSTEM_PROMPT, {
      task: "把规则结果和允许方案转成通俗、可执行的患者说明。不要重复内部字段名。",
      ruleResult: planPayload(verdict),
      approvedSources: []
    });
  }

  async decideFollowUp(input: {
    question: string;
    verdict: ClinicalVerdict;
    context: Parameters<PlanDialoguePort["decideFollowUp"]>[0]["context"];
  }): Promise<FollowUpDecision | null> {
    this.ensureConfigured();
    const parsed = await this.chatJson(DECISION_SYSTEM_PROMPT, {
      task: "决定直接回答，或请求一次只读知识搜索。",
      ...this.followUpPayload(input)
    });
    if (parsed === null) return null;
    if (
      Object.keys(parsed).every((key) => key === "action" || key === "answer") &&
      parsed.action === "answer" &&
      typeof parsed.answer === "string"
    ) {
      const answer = parsed.answer.trim();
      return answer !== "" && answer.length <= 800
        ? { action: "answer", answer }
        : null;
    }
    if (
      Object.keys(parsed).every((key) => key === "action" || key === "query") &&
      parsed.action === "search" &&
      typeof parsed.query === "string"
    ) {
      const query = parsed.query.trim();
      return query.length >= 2 && query.length <= 200
        ? { action: "search", query }
        : null;
    }
    return null;
  }

  async answerFollowUp(input: {
    question: string;
    verdict: ClinicalVerdict;
    sources: readonly PlanDialogueSource[];
    context: Parameters<PlanDialoguePort["answerFollowUp"]>[0]["context"];
  }): Promise<string | null> {
    return this.chatAnswer(SYSTEM_PROMPT, {
      task: input.sources.length === 0
        ? "只读知识搜索没有返回足够依据。自然说明缺少什么，并只追问一个最有帮助的问题；不得凭模型记忆补医学事实。"
        : "已完成唯一一次只读知识搜索。根据相关资料回答；若资料不相关或不足，自然说明依据不足并只追问一个最有帮助的问题。",
      ...this.followUpPayload(input),
      approvedSources: input.sources.map((source, index) => ({
        index: index + 1,
        name: source.name,
        text: source.text
      }))
    });
  }

  async answer(
    question: string,
    sources: readonly KnowledgeSource[]
  ): Promise<string | null> {
    return this.chatAnswer(KNOWLEDGE_SYSTEM_PROMPT, {
      question,
      sources: sources.map((source, index) => ({
        index: index + 1,
        name: source.name,
        text: source.text
      }))
    }, 500);
  }

  private followUpPayload(input: {
    question: string;
    verdict: ClinicalVerdict;
    context: Parameters<PlanDialoguePort["answerFollowUp"]>[0]["context"];
  }): Record<string, unknown> {
    const questionnaire = input.context.assessment.answers.map((answer) => {
      const question = assessmentQuestion(answer.fieldCode);
      const option = question?.options.find((candidate) => candidate.code === answer.value);
      return {
        fieldCode: answer.fieldCode,
        question: question?.title ?? answer.fieldCode,
        answerCode: answer.value ?? answer.state,
        answer: option?.text ?? answer.value ?? answer.state
      };
    });
    return {
      question: input.question,
      ruleResult: planPayload(input.verdict),
      assessment: {
        completedAt: input.context.assessment.completedAt,
        questionnaire
      },
      recentConversation: input.context.recentMessages
    };
  }

  private ensureConfigured(): void {
    if (this.apiKey === undefined || this.apiKey.trim() === "") {
      throw new DomainError(
        "provider_unavailable",
        "通义千问未配置，已降级为当前规则与方案内容"
      );
    }
  }

  private async chatAnswer(
    systemPrompt: string,
    payload: Record<string, unknown>,
    maxAnswerLength = 800
  ): Promise<string | null> {
    const record = await this.chatJson(systemPrompt, payload);
    if (record === null || Object.keys(record).some((key) => key !== "answer")) return null;
    const answer = typeof record.answer === "string" ? record.answer.trim() : "";
    return answer !== "" && answer.length <= maxAnswerLength ? answer : null;
  }

  private async chatJson(
    systemPrompt: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    this.ensureConfigured();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          // qwen3.7-flash 是混合思考模型，默认会开启推理。患者方案转译与
          // 受约束追问已有确定性规则结果，不需要额外推理延迟。
          enable_thinking: false,
          temperature: 0.2,
          max_tokens: 512,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(payload) }
          ]
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") return null;
      const parsed = JSON.parse(content) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
