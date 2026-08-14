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

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.7-flash";
const DEFAULT_TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = `你是过敏性鼻炎患者科普助手。服务端已经用固定规则完成判定并给出允许的方案。
你只能依据输入中的【规则结果】【允许方案】和【已审核资料】回答：
1. 不得改变证型、期别、人群或方案，不得新增穴位、疗法、禁忌、次数、时长、力度、剂量或疗效；
2. 资料未提供的细节必须明确说依据不足，不得使用模型原生医学知识补全；
3. 患者询问当前方案未包含的疗法时，说明当前方案未包含，并建议咨询专业医生；
4. 使用普通患者听得懂的中文，不称为诊断，不承诺治愈；
5. 只输出 JSON 对象 {"answer":"..."}，answer 不超过 800 个中文字符。`;

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

export class QwenPlanDialogueAdapter implements PlanDialoguePort {
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
    return this.chat({
      task: "把规则结果和允许方案转成通俗、可执行的患者说明。不要重复内部字段名。",
      ruleResult: planPayload(verdict),
      approvedSources: []
    });
  }

  async answerFollowUp(input: {
    question: string;
    verdict: ClinicalVerdict;
    sources: readonly PlanDialogueSource[];
  }): Promise<string | null> {
    return this.chat({
      task: "回答患者对当前方案的追问。资料不足或问题超出当前方案时安全拒绝。",
      question: input.question,
      ruleResult: planPayload(input.verdict),
      approvedSources: input.sources.map((source, index) => ({
        index: index + 1,
        name: source.name,
        text: source.text
      }))
    });
  }

  private ensureConfigured(): void {
    if (this.apiKey === undefined || this.apiKey.trim() === "") {
      throw new DomainError(
        "provider_unavailable",
        "通义千问未配置，已降级为已审核固定内容"
      );
    }
  }

  private async chat(payload: Record<string, unknown>): Promise<string | null> {
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
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
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
      const record = parsed as Record<string, unknown>;
      if (Object.keys(record).some((key) => key !== "answer")) return null;
      const answer = typeof record.answer === "string" ? record.answer.trim() : "";
      return answer !== "" && answer.length <= 800 ? answer : null;
    } catch {
      return null;
    }
  }
}
