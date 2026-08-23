import { DomainError } from "../../kernel/errors.js";
import type { KnowledgeAnswerPort, KnowledgeRetrievalPort } from "./knowledge-ports.js";
import {
  requestsMedicationDosageGuidance,
  requestsProfessionalOperationGuidance
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

const DISCLAIMER = "内容仅供健康科普参考，不能替代医生诊断和专业医疗建议。";

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
    if (
      requestsProfessionalOperationGuidance(normalized) ||
      requestsMedicationDosageGuidance(normalized)
    ) {
      return {
        answer: "这涉及需要结合具体情况确认的药物或专业操作参数。请查看药品说明书或咨询医生、药师；你也可以继续问相关原理、用途或常见风险。",
        sources: [],
        generated: false,
        disclaimer: DISCLAIMER
      };
    }
    let hits: Awaited<ReturnType<KnowledgeRetrievalPort["searchEnabled"]>> = [];
    try { hits = await this.retrieval.searchEnabled(normalized, 3); } catch { hits = []; }
    let generated: string | null = null;
    try { generated = await this.model.answer(normalized, hits); } catch { generated = null; }
    const answer = generated ?? "现在暂时没能生成回答，请稍后再试。";
    // Top-k 只是候选上下文，不能证明模型实际采用了某一片段。患者侧不把
    // 候选检索结果标成回答来源；后台 search-test 仍可独立核验命中详情。
    return { answer, sources: [], generated: generated !== null, disclaimer: DISCLAIMER };
  }
}
