import {
  SAFETY_FIELDS,
  SEVERITY_FIELDS,
  SYNDROME_FIELDS,
  evaluateAssessment,
  type AssessmentInput,
  type SafetyAnswers,
  type SafetyField,
  type SeverityAnswers,
  type SyndromeAnswers,
  type TriState,
} from "./rules.ts";
import {
  DeepSeekUnavailableError,
  extractCandidatesWithDeepSeek,
  type DeepSeekOptions,
  type ExtractionCandidates,
} from "./deepseek.ts";
import {
  InMemoryAgentLimiter,
  agentLimiter,
  getRequestClientKey,
} from "./rate-limit.ts";
import {
  evaluateRehabSafety,
  isRehabMethod,
  REHAB_SAFETY_FIELDS,
  REHAB_SAFETY_DISCLAIMER,
  type RehabSafetyAnswers,
  type RehabSafetyResult,
} from "./rehab-safety.ts";

const TRI_STATES = new Set<TriState>(["yes", "no", "unknown"]);
const ASSESSMENT_BODY_LIMIT_BYTES = 8_192;
const EXTRACT_BODY_LIMIT_BYTES = 8_192;
const EXTRACT_TEXT_MAX_LENGTH = 2_000;
const REQUESTS_PER_MINUTE = 30;
const MODEL_REQUESTS_PER_MINUTE = 10;
const MAX_MODEL_CONCURRENCY = 2;

type ErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "MODEL_BUSY"
  | "INTERNAL_ERROR";

interface ApiError {
  code: ErrorCode;
  message: string;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

class RequestError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function parseAnswerGroup<T extends Record<string, TriState>>(
  value: unknown,
  fields: readonly string[],
): T | null {
  if (!isRecord(value) || !hasExactKeys(value, fields)) {
    return null;
  }

  if (
    !fields.every(
      (field) =>
        typeof value[field] === "string" &&
        TRI_STATES.has(value[field] as TriState),
    )
  ) {
    return null;
  }

  return value as T;
}

export function parseAssessmentInput(value: unknown): AssessmentInput | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "diagnosedAllergicRhinitis",
      "safety",
      "severity",
      "syndrome",
    ]) ||
    typeof value.diagnosedAllergicRhinitis !== "string" ||
    !TRI_STATES.has(value.diagnosedAllergicRhinitis as TriState)
  ) {
    return null;
  }

  const safety = parseAnswerGroup<SafetyAnswers>(value.safety, SAFETY_FIELDS);
  const severity = parseAnswerGroup<SeverityAnswers>(
    value.severity,
    SEVERITY_FIELDS,
  );
  const syndrome = parseAnswerGroup<SyndromeAnswers>(
    value.syndrome,
    SYNDROME_FIELDS,
  );

  if (!safety || !severity || !syndrome) {
    return null;
  }

  return {
    diagnosedAllergicRhinitis:
      value.diagnosedAllergicRhinitis as TriState,
    safety,
    severity,
    syndrome,
  };
}

export function parseRehabSafetyInput(value: unknown): { method: Parameters<typeof evaluateRehabSafety>[0]; answers: RehabSafetyAnswers } | null {
  if (!isRecord(value) || !hasExactKeys(value, ["method", "answers"]) || !isRehabMethod(value.method)) return null;
  const answers = parseAnswerGroup<RehabSafetyAnswers>(value.answers, REHAB_SAFETY_FIELDS);
  return answers ? { method: value.method, answers } : null;
}

export type ApprovedPlan = {
  id: string;
  title: string;
  summary: string;
  method: Parameters<typeof evaluateRehabSafety>[0];
  risks: string;
  contraindications: string;
  steps: Array<{ title: string; instruction: string }>;
};

type ExplainInput = {
  assessment: AssessmentInput;
  rehabSafety: { method: Parameters<typeof evaluateRehabSafety>[0]; answers: RehabSafetyAnswers } | null;
};

function parseExplainInput(value: unknown): ExplainInput | null {
  if (!isRecord(value)) return null;
  const assessment = parseAssessmentInput({
    diagnosedAllergicRhinitis: value.diagnosedAllergicRhinitis,
    safety: value.safety,
    severity: value.severity,
    syndrome: value.syndrome,
  });
  if (!assessment) return null;
  if (!("rehabSafety" in value)) return { assessment, rehabSafety: null };
  const rehabSafety = parseRehabSafetyInput(value.rehabSafety);
  return rehabSafety ? { assessment, rehabSafety } : null;
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestError(413, "PAYLOAD_TOO_LARGE", "请求内容过长");
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new RequestError(413, "PAYLOAD_TOO_LARGE", "请求内容过长");
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new RequestError(400, "INVALID_JSON", "请求必须是有效 JSON");
  }
}

function jsonResponse<T>(body: ApiResult<T>, status = 200, headers?: HeadersInit) {
  return Response.json(body, { status, headers });
}

function errorResponse(error: unknown): Response {
  if (error instanceof RequestError) {
    const headers =
      error.retryAfterSeconds === undefined
        ? undefined
        : { "retry-after": String(error.retryAfterSeconds) };
    return jsonResponse(
      {
        ok: false,
        error: { code: error.code, message: error.message },
      },
      error.status,
      headers,
    );
  }

  return jsonResponse(
    {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" },
    },
    500,
  );
}

const HIGH_RISK_PATTERNS: ReadonlyArray<{
  field: SafetyField;
  patterns: readonly RegExp[];
}> = [
  {
    field: "respiratoryEmergency",
    patterns: [
      /呼吸困难|呼吸不畅|胸闷|胸痛|喘不过气|窒息|嘴唇.{0,4}发紫/u,
      /difficulty breathing|cannot breathe/iu,
    ],
  },
  {
    field: "persistentHighFever",
    patterns: [/发烧|发热|高烧|高热|持续.{0,4}(?:发烧|发热)|体温\s*(?:39|40)(?:\.\d)?/u],
  },
  {
    field: "facialSwelling",
    patterns: [/面部.{0,6}(肿|肿胀)|脸.{0,6}(肿|肿胀)/u],
  },
  {
    field: "severeNoseBleed",
    patterns: [/鼻血.{0,6}止不住|鼻出血.{0,6}(不止|止不住)|大量鼻出血|严重鼻出血/u],
  },
  {
    field: "unilateralFoulDischarge",
    patterns: [/单侧.{0,8}(恶臭|臭味)|一边鼻.{0,8}(恶臭|臭味)/u],
  },
  {
    field: "severeNeurologicalSymptoms",
    patterns: [/明显头痛|剧烈头痛|意识模糊|抽搐|颈项强直|视力.{0,6}(下降|丧失)/u],
  },
];

export function findHighRiskCandidateFields(text: string): SafetyField[] {
  const normalized = text.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/gu, "");
  return HIGH_RISK_PATTERNS.filter(({ patterns }) =>
    patterns.some((pattern) => pattern.test(normalized)),
  ).map(({ field }) => field);
}

function emptyCandidates(): ExtractionCandidates {
  return { safety: {}, severity: {}, syndrome: {} };
}

function publicAssessment(assessment: ReturnType<typeof evaluateAssessment>) {
  const disclaimer = "这是内部规则辅助结果，不是诊断或证型结论；正式康复建议需经临床审核。";
  const base = { rulePackageVersion: assessment.rulePackageVersion, disclaimer };
  if (assessment.status === "classified") return { ...base, status: assessment.status, planStatus: assessment.planStatus };
  if (assessment.status === "conflict" || assessment.status === "no_match") return { ...base, status: assessment.status };
  if (assessment.status === "blocked") return { ...base, status: assessment.status, safetyStatus: "blocked" as const, matchedRuleIds: assessment.safety.matchedRuleIds };
  return { ...base, status: assessment.status, ...("stage" in assessment ? { stage: assessment.stage } : {}), ...("reason" in assessment ? { reason: assessment.reason } : {}), ...("nextQuestions" in assessment && assessment.nextQuestions ? { nextQuestions: assessment.nextQuestions } : {}) };
}

interface AgentApiDependencies {
  limiter?: InMemoryAgentLimiter;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  modelTimeoutMs?: number;
  approvedPlanProvider?: (syndromeCode: string, method: Parameters<typeof evaluateRehabSafety>[0]) => Promise<ApprovedPlan | null>;
  approvedPlanAccess?: (request: Request) => Promise<boolean>;
}

function resolveApiKey(dependencies: AgentApiDependencies): string | null {
  if (dependencies.apiKey !== undefined) {
    return dependencies.apiKey?.trim() || null;
  }
  return process.env.DEEPSEEK_API_KEY?.trim() || null;
}

function enforceRequestLimit(
  request: Request,
  operation: string,
  limiter: InMemoryAgentLimiter,
): string {
  const clientKey = getRequestClientKey(request);
  const result = limiter.consume(
    `request:${operation}:${clientKey}`,
    REQUESTS_PER_MINUTE,
  );
  if (!result.allowed) {
    throw new RequestError(
      429,
      "RATE_LIMITED",
      "请求过于频繁，请稍后再试",
      result.retryAfterSeconds,
    );
  }
  return clientKey;
}

function enforceModelLimit(clientKey: string, limiter: InMemoryAgentLimiter) {
  const result = limiter.consume(
    `model:${clientKey}`,
    MODEL_REQUESTS_PER_MINUTE,
  );
  if (!result.allowed) {
    throw new RequestError(
      429,
      "RATE_LIMITED",
      "模型请求过于频繁，请稍后再试",
      result.retryAfterSeconds,
    );
  }
}

export function createAgentApi(dependencies: AgentApiDependencies = {}) {
  const limiter = dependencies.limiter ?? agentLimiter;

  return {
    async evaluate(request: Request): Promise<Response> {
      try {
        enforceRequestLimit(request, "evaluate", limiter);
        const value = await readJsonBody(request, ASSESSMENT_BODY_LIMIT_BYTES);
        const input = parseAssessmentInput(value);
        if (!input) {
          throw new RequestError(
            400,
            "INVALID_INPUT",
            "问卷字段不完整或包含无效值",
          );
        }

        return jsonResponse({
          ok: true,
          data: { assessment: publicAssessment(evaluateAssessment(input)) },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async extract(request: Request): Promise<Response> {
      try {
        const clientKey = enforceRequestLimit(request, "extract", limiter);
        const value = await readJsonBody(request, EXTRACT_BODY_LIMIT_BYTES);
        if (
          !isRecord(value) ||
          !hasExactKeys(value, ["text"]) ||
          typeof value.text !== "string"
        ) {
          throw new RequestError(
            400,
            "INVALID_INPUT",
            "请求必须只包含 text 字段",
          );
        }

        const text = value.text.trim();
        if (text.length === 0 || text.length > EXTRACT_TEXT_MAX_LENGTH) {
          throw new RequestError(
            400,
            "INVALID_INPUT",
            "text 长度必须在 1 到 2000 个字符之间",
          );
        }

        const candidateFields = findHighRiskCandidateFields(text);
        if (candidateFields.length > 0) {
          const safety = Object.fromEntries(
            candidateFields.map((field) => [field, "yes"]),
          ) as Partial<SafetyAnswers>;
          return jsonResponse({
            ok: true,
            data: {
              requiresConfirmation: true as const,
              candidates: { ...emptyCandidates(), safety },
              safetyGate: {
                status: "confirmation_required" as const,
                candidateFields,
              },
              model: { used: false as const },
            },
          });
        }

        const apiKey = resolveApiKey(dependencies);
        if (!apiKey) {
          return jsonResponse({
            ok: true,
            data: {
              requiresConfirmation: true as const,
              candidates: emptyCandidates(),
              safetyGate: {
                status: "clear" as const,
                candidateFields: [] as SafetyField[],
              },
              model: {
                used: false as const,
                degradedReason: "model_not_configured" as const,
              },
            },
          });
        }

        enforceModelLimit(clientKey, limiter);
        const release = limiter.acquireModelSlot(MAX_MODEL_CONCURRENCY);
        if (!release) {
          throw new RequestError(
            503,
            "MODEL_BUSY",
            "模型请求繁忙，请稍后再试",
            1,
          );
        }

        try {
          const modelOptions: DeepSeekOptions = {
            apiKey,
            ...(dependencies.fetchImpl
              ? { fetchImpl: dependencies.fetchImpl }
              : {}),
            ...(dependencies.modelTimeoutMs
              ? { timeoutMs: dependencies.modelTimeoutMs }
              : {}),
          };
          const candidates = await extractCandidatesWithDeepSeek(
            text,
            modelOptions,
          );

          return jsonResponse({
            ok: true,
            data: {
              requiresConfirmation: true as const,
              candidates,
              safetyGate: {
                status: "clear" as const,
                candidateFields: [] as SafetyField[],
              },
              model: { used: true as const },
            },
          });
        } catch (error) {
          if (!(error instanceof DeepSeekUnavailableError)) {
            throw error;
          }
          return jsonResponse({
            ok: true,
            data: {
              requiresConfirmation: true as const,
              candidates: emptyCandidates(),
              safetyGate: {
                status: "clear" as const,
                candidateFields: [] as SafetyField[],
              },
              model: {
                used: false as const,
                degradedReason: "model_unavailable" as const,
              },
            },
          });
        } finally {
          release();
        }
      } catch (error) {
        return errorResponse(error);
      }
    },

    async explain(request: Request): Promise<Response> {
      try {
        enforceRequestLimit(request, "explain", limiter);
        const value = await readJsonBody(request, ASSESSMENT_BODY_LIMIT_BYTES);
        const parsed = parseExplainInput(value);
        if (!parsed) {
          throw new RequestError(
            400,
            "INVALID_INPUT",
            "问卷字段不完整或包含无效值",
          );
        }

        const input = parsed.assessment;
        const assessment = evaluateAssessment(input);
        if (assessment.status !== "classified") {
          return jsonResponse({
            ok: true,
            data: {
              assessment: publicAssessment(assessment),
              explanation: null,
              model: {
                used: false as const,
                degradedReason: "assessment_not_classified" as const,
              },
            },
          });
        }

        if (!parsed.rehabSafety) {
          return jsonResponse({
            ok: true,
            data: {
              assessment: publicAssessment(assessment),
              explanation: null,
              model: { used: false as const, degradedReason: "rehab_safety_required" as const },
            },
          });
        }

        const forcedLungHeatBlock = assessment.syndrome.syndromeCode === "LUNG_HEAT" && parsed.rehabSafety.method === "moxa_or_blow_dazhui";
        const rehabSafety: RehabSafetyResult = forcedLungHeatBlock
          ? {
              status: "blocked" as const,
              method: parsed.rehabSafety.method,
              blockedBy: ["lungHeatPattern"],
              rulePackageVersion: "rehab-safety-v1",
              disclaimer: REHAB_SAFETY_DISCLAIMER,
            }
          : evaluateRehabSafety(parsed.rehabSafety.method, parsed.rehabSafety.answers);
        if (rehabSafety.status !== "clear") {
          return jsonResponse({
            ok: true,
            data: {
              assessment: publicAssessment(assessment),
              rehabSafety,
              explanation: null,
              model: { used: false as const, degradedReason: rehabSafety.status === "blocked" ? "rehab_safety_blocked" as const : "rehab_safety_incomplete" as const },
            },
          });
        }

        const approvedPlanAllowed = dependencies.approvedPlanAccess ? await dependencies.approvedPlanAccess(request) : true;
        const plan = approvedPlanAllowed && dependencies.approvedPlanProvider
          ? await dependencies.approvedPlanProvider(assessment.syndrome.syndromeCode, parsed.rehabSafety.method)
          : null;
        if (plan) {
          return jsonResponse({
            ok: true,
            data: {
              assessment: { ...publicAssessment(assessment), planStatus: "approved_plan" as const },
              rehabSafety,
              explanation: {
                summary: `已根据当前规则和已审核内容匹配到康复建议：${plan.title}`,
                plan,
                disclaimer: "仅供健康管理参考，不能替代诊断和治疗；操作前请再次确认禁忌情况。",
              },
              model: { used: false as const, degradedReason: "approved_knowledge" as const },
            },
          });
        }

        return jsonResponse({
          ok: true,
          data: {
            assessment: publicAssessment(assessment),
            explanation: {
              summary:
                "已完成内部规则匹配和操作安全筛查，但当前没有匹配到已审核康复内容，暂不直接推荐操作。",
              disclaimer: "如症状持续、加重或出现危险信号，请及时线下就医。",
            },
            model: {
              used: false as const,
              degradedReason: approvedPlanAllowed ? "no_approved_knowledge" as const : "identity_required" as const,
            },
          },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async rehabSafety(request: Request): Promise<Response> {
      try {
        enforceRequestLimit(request, "rehab-safety", limiter);
        const value = await readJsonBody(request, ASSESSMENT_BODY_LIMIT_BYTES);
        const input = parseRehabSafetyInput(value);
        if (!input) throw new RequestError(400, "INVALID_INPUT", "康复方法或安全筛查字段不完整或包含无效值");
        return jsonResponse({ ok: true, data: { safety: evaluateRehabSafety(input.method, input.answers) } });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export const agentApi = createAgentApi();
