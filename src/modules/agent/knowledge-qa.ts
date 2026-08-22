import { DomainError } from "../../kernel/errors.js";
import type { KnowledgeAnswerPort, KnowledgeRetrievalPort } from "./knowledge-ports.js";

export interface KnowledgeAnswerResult {
  answer: string;
  sources: Array<{ knowledgeId: string; name: string; source: string | null }>;
  generated: boolean;
  disclaimer: string;
}

const DISCLAIMER = "回答仅依据后台已启用的知识资料作健康科普，不代替门诊诊断和专业医疗建议。";

export class KnowledgeQaService {
  constructor(private readonly retrieval: KnowledgeRetrievalPort, private readonly model: KnowledgeAnswerPort) {}

  async ask(question: string): Promise<KnowledgeAnswerResult> {
    const normalized = question.trim();
    if (normalized.length < 2 || normalized.length > 500) {
      throw new DomainError("validation_failed", "知识问题长度需为 2 到 500 个字符");
    }
    const hits = await this.retrieval.searchEnabled(normalized, 3);
    let generated: string | null = null;
    try { generated = await this.model.answer(normalized, hits); } catch { generated = null; }
    const answer = generated?.trim() || (hits.length === 0
      ? "当前可用资料还不够回答这个问题。你可以补充：最想了解的是原因、日常注意事项，还是当前方案中的某个细节？"
      : hits.map((hit) => hit.text.trim().slice(0, 260)).join("\n\n"));
    const sources = [...new Map(hits.map((hit) => [hit.knowledgeId, { knowledgeId: hit.knowledgeId, name: hit.name, source: hit.source }])).values()];
    return { answer, sources, generated: generated !== null && generated.trim() !== "", disclaimer: DISCLAIMER };
  }
}
