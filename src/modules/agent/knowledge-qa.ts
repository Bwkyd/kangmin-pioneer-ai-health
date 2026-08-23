import { DomainError } from "../../kernel/errors.js";
import type { KnowledgeAnswerPort, KnowledgeRetrievalPort } from "./knowledge-ports.js";
import {
  requestsProfessionalOperationGuidance,
  validateMedicalHardFacts
} from "./medical-publication-gate.js";
import {
  EMERGENCY_KNOWLEDGE_ANSWER,
  isEmergencyMessage
} from "./emergency-routing.js";

export interface KnowledgeAnswerResult {
  answer: string;
  sources: Array<{ knowledgeId: string; name: string; source: string | null }>;
  generated: boolean;
  disclaimer: string;
}

const DISCLAIMER = "回答优先参考后台已启用资料，并用于一般健康科普，不代替门诊诊断和专业医疗建议。";

function extractPatientExcerpt(text: string, question: string): string {
  const body = text
    .split("\n")
    .filter((line) => !/^(?:资料章节|知识主题)：/u.test(line.trim()))
    .join("\n")
    .trim();
  const parts = body.match(/[^。！？；\n]+[。！？；]?/gu) ?? [];
  let excerpt = "";
  for (const part of parts) {
    if (excerpt !== "" && excerpt.length + part.length > 420) break;
    excerpt += part;
    if (/(?:是什么|什么意思|何谓|概念)/u.test(question)) break;
    if (excerpt.length >= 180) break;
  }
  return excerpt.trim();
}

export class KnowledgeQaService {
  constructor(private readonly retrieval: KnowledgeRetrievalPort, private readonly model: KnowledgeAnswerPort) {}

  async ask(question: string): Promise<KnowledgeAnswerResult> {
    const normalized = question.trim();
    if (normalized.length < 2 || normalized.length > 500) {
      throw new DomainError("validation_failed", "知识问题长度需为 2 到 500 个字符");
    }
    if (isEmergencyMessage(normalized)) {
      return {
        answer: EMERGENCY_KNOWLEDGE_ANSWER,
        sources: [],
        generated: false,
        disclaimer: DISCLAIMER
      };
    }
    const hits = await this.retrieval.searchEnabled(normalized, 3);
    if (requestsProfessionalOperationGuidance(normalized)) {
      const sources = [...new Map(hits.map((hit) => [hit.knowledgeId, {
        knowledgeId: hit.knowledgeId,
        name: hit.name,
        source: hit.source
      }])).values()];
      return {
        answer: "这涉及需要由专业人员结合当前情况确认的操作参数，我不能只依据知识资料给出个体化做法。请咨询医生；也可以继续问它的原理、用途或常见风险。",
        sources,
        generated: false,
        disclaimer: DISCLAIMER
      };
    }
    let generated: string | null = null;
    try { generated = await this.model.answer(normalized, hits); } catch { generated = null; }
    const validated = validateMedicalHardFacts(generated, {
      allowGeneralKnowledge: true,
      sources: hits.map((hit) => ({
        knowledgeId: hit.knowledgeId,
        name: hit.name,
        source: hit.source,
        text: hit.text
      }))
    });
    const fallback = hits.map((hit) => validateMedicalHardFacts(
      extractPatientExcerpt(hit.text, normalized),
      {
        sources: [{
          knowledgeId: hit.knowledgeId,
          name: hit.name,
          source: hit.source,
          text: hit.text
        }]
      }
    )).find((candidate) => candidate !== null) ?? null;
    const answer = validated || fallback || (hits.length === 0
      ? "当前可用资料还不够回答这个问题。你可以补充：最想了解的是原因、日常注意事项，还是当前方案中的某个细节？"
      : "当前资料包含需要结合专业场景理解的内容，我不能把其中未经当前方案确认的医学动作直接作为建议。你可以改问相关概念、原因，或当前方案中已经列出的内容。");
    const sources = [...new Map(hits.map((hit) => [hit.knowledgeId, { knowledgeId: hit.knowledgeId, name: hit.name, source: hit.source }])).values()];
    return { answer, sources, generated: validated !== null, disclaimer: DISCLAIMER };
  }
}
