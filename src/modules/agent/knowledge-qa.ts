import { DomainError } from "../../kernel/errors.js";

export interface KnowledgeSource {
  knowledgeId: string;
  name: string;
  source: string | null;
  chunkIndex: number;
  text: string;
}

export interface KnowledgeRetrievalPort {
  searchEnabled(query: string, limit: number): Promise<KnowledgeSource[]>;
}

export interface KnowledgeAnswerPort {
  answer(question: string, sources: readonly KnowledgeSource[]): Promise<string | null>;
}

export interface KnowledgeAnswerResult {
  answer: string;
  sources: Array<{ knowledgeId: string; name: string; source: string | null }>;
  generated: boolean;
  disclaimer: string;
}

const DISCLAIMER = "回答仅依据已审核知识资料作健康科普，不代替门诊诊断和专业医疗建议。";

export class KnowledgeQaService {
  constructor(private readonly retrieval: KnowledgeRetrievalPort, private readonly model: KnowledgeAnswerPort) {}

  async ask(question: string): Promise<KnowledgeAnswerResult> {
    const normalized = question.trim();
    if (normalized.length < 2 || normalized.length > 500) {
      throw new DomainError("validation_failed", "知识问题长度需为 2 到 500 个字符");
    }
    const hits = await this.retrieval.searchEnabled(normalized, 3);
    if (hits.length === 0) {
      return { answer: "当前已审核知识库中没有找到足够依据，请换一种问法或咨询专业医生。", sources: [], generated: false, disclaimer: DISCLAIMER };
    }
    let generated: string | null = null;
    try { generated = await this.model.answer(normalized, hits); } catch { generated = null; }
    const answer = generated?.trim() || hits.map((hit) => hit.text.trim().slice(0, 260)).join("\n\n");
    const sources = [...new Map(hits.map((hit) => [hit.knowledgeId, { knowledgeId: hit.knowledgeId, name: hit.name, source: hit.source }])).values()];
    return { answer, sources, generated: generated !== null && generated.trim() !== "", disclaimer: DISCLAIMER };
  }
}
