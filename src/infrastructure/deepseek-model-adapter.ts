/**
 * DeepSeek 模型适配器骨架（架构 §19 ModelExtractionPort/ModelExplanationPort）。
 *
 * 安全降级（§15.2）：
 * - 未配置 API key → 抛 provider_unavailable（调用方降级为结构化问答）；
 * - 超时/网络失败 → 返回空候选 / null，绝不用部分内容充当完整回答；
 * - 非法 JSON → 丢弃本次候选，绝不宽松解析出临床结论；
 * - 候选/解释字段只允许规则包已知字段与固定枚举，越权字段直接拒绝。
 *
 * 模型只能输出结构化 JSON；患者可见正文一律由固定模板渲染
 * （modules/agent/output-validation.ts），模型不写自由文本。
 */

import { FIELD_LABELS } from "../modules/clinical-rules/domain.js";
import type {
  ClinicalVerdict,
  RulePackageStatus
} from "../modules/clinical-rules/contracts.js";
import { DomainError } from "../kernel/errors.js";
import type {
  ExplanationFields,
  ExtractionCandidate,
  ModelExplanationPort,
  ModelExtractionInput,
  ModelExtractionPort
} from "../modules/agent/model-ports.js";
import type { KnowledgeAnswerPort, KnowledgeSource } from "../modules/agent/knowledge-ports.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_TIMEOUT_MS = 10_000;
const ALLOWED_STATES = new Set(["yes", "no", "unknown", "value"]);
const EXPLANATION_KEYS = new Set([
  "outcome",
  "severityCode",
  "syndromeCode",
  "matchedRuleIds",
  "message"
]);

export interface DeepSeekModelOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  /** 可注入 fetch（测试用）；缺省使用全局 fetch。 */
  fetchImpl?: typeof fetch | undefined;
}

const EXTRACTION_SYSTEM_PROMPT = `你是鼻鼽（过敏性鼻炎）健康助手的结构化信息提取器。
规则：只从患者消息中提取明确表达的事实，不得猜测、不得把未提及当否定。
只允许输出以下字段编码之一：${Object.keys(FIELD_LABELS).join("、")}。
状态只能是 yes|no|unknown|value；unknown 表示患者明确表示不知道。
不得新增任何穴位、疗程、力度、剂量、禁忌或疗效内容。
输出必须是 JSON 数组：[{"fieldCode":"...","state":"...","value":?,"justification":"..."}]，不要输出其他文本。`;

const EXPLANATION_SYSTEM_PROMPT = `你是鼻鼽健康助手的结构化结果解释器。
只能把给定的规则结果字段搬运进 JSON，字段只能包含：
outcome、severityCode、syndromeCode、matchedRuleIds、message。
值必须与给定规则结果完全一致，不得新增穴位、疗程、力度、剂量、禁忌或疗效，
不得输出其他键或自由文本。输出必须是 JSON 对象。`;

const KNOWLEDGE_SYSTEM_PROMPT = `你是鼻健康知识问答助手。只能依据用户消息中提供的“已审核资料”回答，不能补充外部知识，不能诊断、开药或承诺疗效。资料不足时明确说资料不足。输出 JSON 对象且只能包含 answer 字段，answer 不超过 500 个中文字符。`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class DeepSeekModelAdapter
  implements ModelExtractionPort, ModelExplanationPort, KnowledgeAnswerPort
{
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DeepSeekModelOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async extractCandidates(
    input: ModelExtractionInput
  ): Promise<ExtractionCandidate[]> {
    this.ensureConfigured();
    const content = await this.chat(
      EXTRACTION_SYSTEM_PROMPT,
      input.message
    );
    if (content === null) {
      return [];
    }
    const parsed = this.parseJson(content);
    if (!Array.isArray(parsed)) {
      return [];
    }
    // 严格过滤：非法条目直接丢弃，不宽松解析。
    const candidates: ExtractionCandidate[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) {
        continue;
      }
      const fieldCode = entry.fieldCode;
      const state = entry.state;
      if (
        typeof fieldCode !== "string" ||
        !Object.hasOwn(FIELD_LABELS, fieldCode) ||
        typeof state !== "string" ||
        !ALLOWED_STATES.has(state)
      ) {
        continue;
      }
      const candidate: ExtractionCandidate = {
        fieldCode,
        state: state as ExtractionCandidate["state"]
      };
      if (state === "value") {
        const value = entry.value;
        if (typeof value !== "string" && typeof value !== "number") {
          continue;
        }
        candidate.value = value;
      }
      if (typeof entry.justification === "string") {
        candidate.justification = entry.justification;
      }
      candidates.push(candidate);
    }
    return candidates;
  }

  async explain(
    verdict: ClinicalVerdict,
    packageStatus: RulePackageStatus
  ): Promise<ExplanationFields | null> {
    this.ensureConfigured();
    const content = await this.chat(
      EXPLANATION_SYSTEM_PROMPT,
      JSON.stringify({
        outcome: verdict.outcome,
        severityCode: verdict.severityCode,
        syndromeCode: verdict.syndromeCode,
        matchedRuleIds: verdict.matchedRuleIds,
        message: verdict.message,
        packageStatus
      })
    );
    if (content === null) {
      return null;
    }
    const parsed = this.parseJson(content);
    if (!isRecord(parsed)) {
      return null;
    }
    return this.sanitizeExplanation(parsed);
  }

  async answer(question: string, sources: readonly KnowledgeSource[]): Promise<string | null> {
    this.ensureConfigured();
    const content = await this.chat(KNOWLEDGE_SYSTEM_PROMPT, JSON.stringify({
      question,
      approvedSources: sources.map((source, index) => ({ index: index + 1, name: source.name, text: source.text }))
    }));
    if (content === null) return null;
    const parsed = this.parseJson(content);
    if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== "answer") || typeof parsed.answer !== "string") return null;
    const answer = parsed.answer.trim();
    return answer !== "" && answer.length <= 500 ? answer : null;
  }

  /** 越权/多余键、类型不符一律拒绝（返回 null → 调用方回退固定模板）。 */
  private sanitizeExplanation(
    parsed: Record<string, unknown>
  ): ExplanationFields | null {
    for (const key of Object.keys(parsed)) {
      if (!EXPLANATION_KEYS.has(key)) {
        return null;
      }
    }
    if (typeof parsed.outcome !== "string") {
      return null;
    }
    if (parsed.severityCode !== null && typeof parsed.severityCode !== "string") {
      return null;
    }
    if (parsed.syndromeCode !== null && typeof parsed.syndromeCode !== "string") {
      return null;
    }
    if (!Array.isArray(parsed.matchedRuleIds)) {
      return null;
    }
    if (!parsed.matchedRuleIds.every((rule) => typeof rule === "string")) {
      return null;
    }
    if (parsed.message !== null && typeof parsed.message !== "string") {
      return null;
    }
    return {
      outcome: parsed.outcome,
      severityCode: parsed.severityCode,
      syndromeCode: parsed.syndromeCode,
      matchedRuleIds: parsed.matchedRuleIds,
      message: parsed.message
    };
  }

  private ensureConfigured(): void {
    if (this.apiKey === undefined || this.apiKey.trim() === "") {
      throw new DomainError(
        "provider_unavailable",
        "DeepSeek 模型服务未配置（缺少 API key），已降级为结构化问答"
      );
    }
  }

  /**
   * 调用 chat completions；超时/网络/非 2xx/非法响应体一律返回 null
   * （调用方降级），记录供应商状态但不泄露凭据。
   */
  private async chat(systemPrompt: string, userPrompt: string): Promise<string | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ]
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) {
        return null;
      }
      const body: unknown = await response.json();
      if (!isRecord(body)) {
        return null;
      }
      const choices = body.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        return null;
      }
      const first = choices[0];
      if (!isRecord(first)) {
        return null;
      }
      const message = first.message;
      if (!isRecord(message)) {
        return null;
      }
      return typeof message.content === "string" ? message.content : null;
    } catch {
      // 超时、DNS、连接失败等：降级为空候选，规则结果仍然有效。
      return null;
    }
  }

  private parseJson(content: string): unknown {
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return null;
    }
  }
}
