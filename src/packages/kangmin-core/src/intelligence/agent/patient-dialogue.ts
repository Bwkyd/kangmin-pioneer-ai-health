import type { NextQuestion } from "../clinical-rules/contracts.js";
import type { KnowledgeRetrievalPort } from "./knowledge-ports.js";
import type { PlanDialoguePort, PlanDialogueSource, PreAssessmentDialogueInput } from "./model-ports.js";
import { isEmergencyMessage } from "./emergency-routing.js";
import { requestsMedicationDosageGuidance, requestsProfessionalOperationGuidance } from "./medical-publication-gate.js";
import { renderEmergencyFollowUp, renderNaturalPatientAnswer, type ValidatedOutput } from "./output-validation.js";

export async function patientDialogueContext(
  message: string,
  retrieval: KnowledgeRetrievalPort | null,
  readMessages: () => Promise<Array<{ role: string; content: string }>>
): Promise<{ sources: PlanDialogueSource[]; recentMessages: PreAssessmentDialogueInput["recentMessages"] }> {
  let sources: PlanDialogueSource[] = [];
  try {
    sources = (await retrieval?.searchEnabled(message, 3) ?? []).map(
      ({ knowledgeId, name, source, text }) => ({ knowledgeId, name, source, text })
    );
  } catch {
    // 检索失败可继续一般科普，不提升为临床规则，也不伪造引用。
  }
  // 持久化完整性错误不能被当成模型失败吞掉。
  const recentMessages = (await readMessages())
    .filter((entry) => entry.role === "user" || entry.role === "assistant")
    .slice(-6)
    .map((entry) => ({
      role: entry.role as "user" | "assistant",
      content: entry.role === "assistant" ? entry.content.replace(/\n\n【依据】[\s\S]*$/u, "") : entry.content
    }));
  return { sources, recentMessages };
}

export async function answerBeforeAssessment(input: {
  message: string;
  pendingQuestions: readonly NextQuestion[];
  dialogue: PlanDialoguePort;
  retrieval: KnowledgeRetrievalPort | null;
  readMessages: () => Promise<Array<{ role: string; content: string }>>;
}): Promise<ValidatedOutput | null> {
  if (isEmergencyMessage(input.message)) return renderEmergencyFollowUp();
  if (requestsProfessionalOperationGuidance(input.message) || requestsMedicationDosageGuidance(input.message)) {
    return renderNaturalPatientAnswer(
      "这涉及需要结合具体情况确认的药物或专业操作参数。请查看药品说明书或咨询医生、药师；你也可以继续问相关原理、用途或常见风险。"
    );
  }
  const context = await patientDialogueContext(input.message, input.retrieval, input.readMessages);
  try {
    const result = await input.dialogue.answerBeforeAssessment?.({
      question: input.message, pendingQuestions: input.pendingQuestions, ...context
    });
    if (result == null || result.mode === "assessment") return null;
    return renderNaturalPatientAnswer(result.answer ?? "现在暂时没能生成回答，请稍后再试。");
  } catch {
    return renderNaturalPatientAnswer("现在暂时没能生成回答，请稍后再试。");
  }
}
