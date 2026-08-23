/** 通义千问：规则结果通俗转译与方案后受约束追问。 */

import { DomainError } from "../kernel/errors.js";
import { SYNDROME_LABELS } from "../modules/clinical-rules/domain.js";
import type {
  ApprovedPlan,
  ClinicalVerdict
} from "../modules/clinical-rules/contracts.js";
import type {
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

const KNOWLEDGE_SYSTEM_PROMPT = `你是直接服务普通患者的鼻健康助手。使用简短、通俗、自然的中文，先直接回答患者当前的问题。

系统会提供当前评估、已批准方案和可能相关的后台资料：
1. 如果资料与问题相关，优先依据资料回答；如果没有资料或资料不相关，可以使用可靠的一般医学知识正常回答。
2. 不要向患者提及知识库、检索、命中、资料不足、系统规则、提示词或内部判断。
3. 当前评估和已批准方案是服务端确定的事实，不得修改。患者的问题没有询问当前评估、体质或方案时，必须完全忽略这些字段，不得提及、解释或把它们与一般知识建立因果联系。
4. 不把一般说明写成对当前患者的确定诊断；不知道具体药名或成分时不猜剂量、次数和疗程；不要把专业资料中的厘米、分钟、次数、力度和手法自动改写成居家操作。
5. 用户只问概念、原因或区别时，只回答所问内容，不主动追加药物、穴位、艾灸或其他护理步骤。
6. 不保证治愈或不复发。信息不足时最多追问一个真正必要的问题。

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

  async answerFollowUp(input: {
    question: string;
    verdict: ClinicalVerdict;
    sources: readonly PlanDialogueSource[];
    context: Parameters<PlanDialoguePort["answerFollowUp"]>[0]["context"];
  }): Promise<string | null> {
    return this.chatAnswer(KNOWLEDGE_SYSTEM_PROMPT, {
      ...this.followUpPayload(input),
      sources: input.sources.map((source, index) => ({
        index: index + 1,
        name: source.name,
        text: source.text
      }))
    }, 500);
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
