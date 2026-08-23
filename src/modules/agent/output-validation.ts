/**
 * 输出校验与固定模板渲染。
 *
 * 硬规则（患者 CLI 设计 §6.4/§13、数据库设计 §4.5）：
 * - 模型/模板输出不得新增穴位、疗程、力度、剂量、禁忌或疗效；
 * - 模型解释只允许搬运规则结果中的字段，任何新增/篡改都被拒绝，
 *   回退到固定模板（规则结果仍然有效）；
 * - assistant 消息只能绑定已完成的 decision，content_hash 必须等于
 *   已校验输出；失败时只允许代码生成的固定 system_notice。
 *
 * 本模块保留方案生成的严格校验与固定模板。普通患者问答由统一提示词生成，
 * 服务端完成少数模型前分流后直接用 renderNaturalPatientAnswer 渲染，不再逐句关键词裁决。
 */

import { createHash } from "node:crypto";

import type {
  ApprovedPlan,
  ClinicalVerdict,
  ConfirmedFact,
  PlanBundle,
  RulePackageStatus
} from "../clinical-rules/contracts.js";
import {
  SYNDROME_LABELS,
  FIELD_LABELS
} from "../clinical-rules/domain.js";
import type {
  ExplanationFields,
  PlanDialogueSource
} from "./model-ports.js";
import { validateMedicalHardFacts } from "./medical-publication-gate.js";

export interface ValidatedOutput {
  templateId: string;
  content: string;
  contentHash: string;
  /** 模型提供的字段（校验通过时）；null 表示固定模板回退。 */
  fields: ExplanationFields | null;
}

/** 临床冻结前的正式输出阻断文案（红线）。 */
export const CLINICAL_FREEZE_BLOCK = "当前规则包未完成临床冻结，暂不输出个性化方案。";

const CONFLICT_MESSAGE =
  "您的回答同时符合多个证型特征，当前信息不足以确定证型。本工具不做猜测，请以门诊诊断为准。";
const NO_MATCH_MESSAGE =
  "根据您的回答，未匹配到明确的证型。本工具不做猜测，请以门诊诊断为准。";

/** 补问信息无法取得进展时的 fail-closed 固定文案（unknown 不等于 no）。 */
export const FAIL_CLOSED_SAFETY_NOTICE =
  "关键安全信息您表示无法确认。本工具按最高风险处理：unknown 不等于 no。请立即线下就医确认，本工具暂不提供调理建议。";
export const FAIL_CLOSED_INFO_NOTICE =
  "您对必要问题表示无法确认，当前信息不足，无法继续评估。本工具不做猜测，请以门诊诊断为准。";

/** 模型提取不可用时的固定 system_notice（代码生成，不绑定决策）。
 *  客户可读文案（评审 P0-9 修正：不暴露内部"智能提取服务"术语）。 */
export const EXTRACTION_UNAVAILABLE_NOTICE =
  "未识别到您的回答，请点击下方选项按钮回答，或直接输入“是 / 否 / 不清楚”。";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 校验模型解释字段：只允许与规则结果完全一致的字段，
 * 任何新增、缺失或篡改都视为非法，返回 null（回退固定模板）。
 */
export function validateExplanationFields(
  fields: ExplanationFields | null,
  verdict: ClinicalVerdict
): ExplanationFields | null {
  if (fields === null) {
    return null;
  }
  if (fields.outcome !== verdict.outcome) {
    return null;
  }
  if ((fields.severityCode ?? null) !== (verdict.severityCode ?? null)) {
    return null;
  }
  if ((fields.syndromeCode ?? null) !== (verdict.syndromeCode ?? null)) {
    return null;
  }
  const modelRules = [...fields.matchedRuleIds].sort();
  const verdictRules = [...verdict.matchedRuleIds].sort();
  if (
    modelRules.length !== verdictRules.length ||
    modelRules.some((rule, index) => rule !== verdictRules[index])
  ) {
    return null;
  }
  if ((fields.message ?? null) !== (verdict.message ?? null)) {
    return null;
  }
  return fields;
}

function questionText(verdict: ClinicalVerdict): string {
  const lines = verdict.nextQuestions.map((question, index) => {
    const label = FIELD_LABELS[question.fieldCode];
    const suffix = label === undefined ? "" : `（${label}）`;
    return `${index + 1}. ${question.prompt}${suffix}`;
  });
  return `为了继续评估，请回答以下问题：\n${lines.join("\n")}`;
}

/**
 * 方法列表：数据库沿用历史字段 steps_json，但客户材料中的每一项是供患者
 * 选择的方法，不是必须依次执行的步骤。数组元素兼容字符串或对象
 * {title, description}；非 JSON 文本作为单个方法展示。
 */
function planMethods(plan: ApprovedPlan): string[] {
  if (plan.steps === "" || plan.steps === "[]") {
    return [];
  }
  try {
    const parsed = JSON.parse(plan.steps) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((step) => {
          if (typeof step === "string") {
            return step;
          }
          if (step !== null && typeof step === "object") {
            const record = step as Record<string, unknown>;
            const title = typeof record.title === "string" ? record.title : "";
            const description =
              typeof record.description === "string" ? record.description : "";
            const text = [title, description].filter((part) => part !== "").join("：");
            return text === "" ? JSON.stringify(step) : text;
          }
          return String(step);
        });
    }
  } catch {
    // 非 JSON 文本按单个方法展示。
  }
  return [plan.steps];
}

/** 单方案区块（名称/方法及各自视频/注意事项）；方案缺失不捏造正文。 */
function planBlock(plan: ApprovedPlan | null): string {
  if (plan === null) {
    return "方案待补充（由后台完善后生效）。";
  }
  const lines: string[] = [plan.name];
  const methods = planMethods(plan);
  if (methods.length > 0) {
    lines.push("方法（请选择其中一项）：");
    methods.forEach((method, index) => {
      lines.push(`${index + 1}. ${method}`, "【操作视频】", videoBlock(plan));
    });
  } else if (plan.method !== "") {
    lines.push("方法：", plan.method, "【操作视频】", videoBlock(plan));
  }
  if (plan.precautions !== "") {
    lines.push(`注意事项：${plan.precautions}`);
  }
  return lines.join("\n");
}

function videoBlock(plan: ApprovedPlan | null): string {
  const videoId = plan?.videoResourceId;
  return videoId === null || videoId === undefined || videoId === ""
    ? "视频暂未上传（医学审核后补充）。"
    : "操作视频已提供（见视频资源）。";
}

const ACUTE_HEADER = (syndrome: string): string =>
  `根据您的自测结果，您目前处于鼻炎的【急性发作期】\n` +
  `您的体质类型为：【${syndrome}】\n` +
  `您目前处于急性发作期，我们为您优先推荐快速缓解症状的治标方案，同时配套日常体质调理方案`;

const REMISSION_HEADER = (syndrome: string): string =>
  `根据您的自测结果，您目前处于鼻炎的【缓解期】\n` +
  `您的体质类型为：【${syndrome}】\n` +
  `此时应缓则治本，专注调理体质\n` +
  `请您坚持执行调体方案，每周 2-3 次，鼻炎反复的根源在体质，体质改善了，复发自然减少\n` +
  `如因受凉或接触过敏原导致症状突然复发，可采取急性期方案缓解症状`;

const DISCLAIMER =
  "⚠️ 温馨提示：本方案为居家辅助调理建议，不能替代专业医疗诊断";

/**
 * 自由文本医学校验：把当前裁决、批准方案、患者确认事实与本轮检索源
 * 交给统一硬事实发布条件；普通措辞不在这里裁决。
 */
export function validateGeneratedMedicalText(
  generated: string | null,
  verdict: ClinicalVerdict,
  sources: readonly PlanDialogueSource[] = [],
  facts: readonly ConfirmedFact[] = []
): string | null {
  return validateMedicalHardFacts(generated, {
    verdict,
    sources,
    facts,
    approvedText: renderValidatedOutput(verdict, "approved", null).content
  });
}

function evidenceFooter(
  verdict: ClinicalVerdict,
  sources: readonly PlanDialogueSource[]
): string {
  const planNames = [verdict.planBundle?.acute?.name, verdict.planBundle?.constitution?.name]
    .filter((name): name is string => typeof name === "string" && name !== "");
  const sourceNames = sources.map((source) => source.name);
  const names = [...new Set([...planNames, ...sourceNames])];
  return [
    names.length === 0 ? "【依据】当前规则结果与方案" : `【依据】${names.join("；")}`,
    DISCLAIMER
  ].join("\n");
}

export function renderGeneratedPlanOutput(
  generated: string | null,
  verdict: ClinicalVerdict,
  facts: readonly ConfirmedFact[] = []
): ValidatedOutput | null {
  const validated = validateGeneratedMedicalText(generated, verdict, [], facts);
  if (validated === null) return null;
  const fixed = renderValidatedOutput(verdict, "approved", null).content;
  const fixedWithoutDisclaimer = fixed.endsWith(DISCLAIMER)
    ? fixed.slice(0, -DISCLAIMER.length).trimEnd()
    : fixed;
  const content = [
    validated,
    "【已审核方案】",
    fixedWithoutDisclaimer,
    evidenceFooter(verdict, [])
  ].join("\n\n");
  return output("generated_plan", content, null);
}

export function renderGeneratedFollowUpOutput(
  generated: string | null,
  verdict: ClinicalVerdict,
  sources: readonly PlanDialogueSource[],
  facts: readonly ConfirmedFact[] = []
): ValidatedOutput | null {
  const validated = validateGeneratedMedicalText(generated, verdict, sources, facts);
  if (validated === null) return null;
  const content = `${validated}\n\n${evidenceFooter(verdict, sources)}`;
  return output("generated_follow_up", content, null);
}

/**
 * 统一普通患者问答：系统提示词负责回答方式，服务端只验证适配器的
 * JSON/长度契约后原样发布；不追加与当前问题无关的方案依据。
 */
export function renderNaturalPatientAnswer(content: string): ValidatedOutput {
  return output("natural_patient_answer", content, null);
}

/**
 * 泛化解释的确定性降级：只拼接规则结果和已批准方案原文，并根据是否已有
 * 上一轮回答改变表达。它不补充任何医学细节，也不会退回无上下文的重复拒绝。
 */
export function renderContextualPlanFollowUp(
  verdict: ClinicalVerdict,
  hasRecentConversation: boolean
): ValidatedOutput {
  const syndrome = verdict.syndromeCode === null
    ? "当前体质类型"
    : (SYNDROME_LABELS[verdict.syndromeCode] ?? verdict.syndromeCode);
  const phase = verdict.phaseCode === "acute" ? "急性发作期" : "缓解期";
  const acute = verdict.planBundle?.acute ?? null;
  const constitution = verdict.planBundle?.constitution ?? null;
  const content = hasRecentConversation
    ? [
        "承接上一条，先记住一个重点：",
        `您最近一次自测结果仍是【${phase}】，体质类型为【${syndrome}】。`,
        constitution === null
          ? "当前没有可用的调体方案。"
          : `缓解期以【${constitution.name}】为主：${constitution.method}。`,
        acute === null
          ? "症状突然加重时请及时咨询专业医生。"
          : `症状突然发作时，再参考【${acute.name}】：${acute.method}。`
      ].join("\n")
    : [
        "我换成简单说法：",
        `系统沿用了您最近一次自测：目前是【${phase}】，体质类型为【${syndrome}】，不需要重新做问卷。`,
        constitution === null
          ? "当前没有可用的调体方案。"
          : `当前重点是【${constitution.name}】：${constitution.method}。`,
        acute === null
          ? "症状突然加重时请及时咨询专业医生。"
          : `如果症状突然发作，再参考【${acute.name}】：${acute.method}。`
      ].join("\n");
  return output(
    "contextual_plan_follow_up",
    `${content}\n\n${evidenceFooter(verdict, [])}`,
    null
  );
}

export function renderFixedFollowUp(
  templateId:
    | "follow_up_out_of_plan"
    | "follow_up_no_evidence"
    | "follow_up_degraded",
  content: string,
  verdict: ClinicalVerdict,
  sources: readonly PlanDialogueSource[] = []
): ValidatedOutput {
  return output(templateId, `${content}\n\n${evidenceFooter(verdict, sources)}`, null);
}

/** 纯寒暄不调用模型，也不重复问卷；只提示可继续询问的安全范围。 */
export function renderAssessmentGreeting(): ValidatedOutput {
  return output(
    "assessment_greeting",
    "您好，我已接续您最近的评估结果。您可以直接问我当前方案是什么意思、如何理解，或有哪些注意事项。",
    null
  );
}

/** 急救提示不引用当前方案，避免患者误以为紧急建议来自调理方案。 */
export function renderEmergencyFollowUp(): ValidatedOutput {
  return output(
    "follow_up_emergency",
    "您描述的情况可能需要紧急医疗帮助。本工具不继续知识搜索或提供调理建议，请立即联系急救或前往急诊。",
    null
  );
}

/** 急性期模板（《页面展示》纯文本化：去 ###/**，保留【】与换行）。 */
function acuteTemplate(syndrome: string, bundle: PlanBundle | null): string {
  return [
    ACUTE_HEADER(syndrome),
    "",
    "【急性期症状缓解方案】",
    "【文本】",
    planBlock(bundle?.acute ?? null),
    "",
    "【体质调理固本方案】",
    "【文本】",
    planBlock(bundle?.constitution ?? null),
    "",
    "【执行建议】",
    "急性期方案：每日执行，直至症状明显缓解",
    "调体方案：每周执行 2-3 次，建议长期坚持",
    "两种方案可同一天执行，互不冲突（建议先做急性期通窍，再做调体固本）",
    "",
    DISCLAIMER
  ].join("\n");
}

/** 缓解期模板（《页面展示》纯文本化）。 */
function remissionTemplate(syndrome: string, bundle: PlanBundle | null): string {
  return [
    REMISSION_HEADER(syndrome),
    "",
    "【体质调理固本方案】",
    "【文本】",
    planBlock(bundle?.constitution ?? null),
    "",
    "【急性期方案】",
    "【文本】",
    planBlock(bundle?.acute ?? null),
    "",
    "【执行建议】",
    "调体方案每周 2-3 次。配合规律作息、适度运动、忌口生冷辛辣",
    "花 1 分钟填写症状记录，系统将自动生成趋势图，帮助您看到改善曲线",
    "",
    DISCLAIMER
  ].join("\n");
}

/**
 * 渲染某次裁决的最终患者可见输出。
 * modelFields 传入时先校验，非法则回退固定模板。
 */
export function renderValidatedOutput(
  verdict: ClinicalVerdict,
  packageStatus: RulePackageStatus,
  modelFields: ExplanationFields | null
): ValidatedOutput {
  const validated = validateExplanationFields(modelFields, verdict);
  const fields = validated;

  switch (verdict.outcome) {
    case "blocked":
      return output("blocked", verdict.message ?? "安全阻断，请线下就医。", fields);
    case "non_applicable":
      return output(
        "non_applicable",
        verdict.message ?? "当前情况不属于本工具适用范围，请线下明确诊断。",
        fields
      );
    case "need_more_information":
      return output("questions", questionText(verdict), fields);
    case "conflict":
      return output("conflict", CONFLICT_MESSAGE, fields);
    case "no_match":
      // 内核可能携带兜底文案（如怕热单独组合提示门诊，AI 决策 A2）。
      return output("no_match", verdict.message ?? NO_MATCH_MESSAGE, fields);
    case "classified": {
      // 临床红线：规则包未 approved 前，正式输出路径一律阻断。
      if (packageStatus !== "approved") {
        return output("clinical_freeze", CLINICAL_FREEZE_BLOCK, fields);
      }
      const syndrome = SYNDROME_LABELS[verdict.syndromeCode ?? ""] ?? "未定";
      // 两套模板按《页面展示》（vault/truth/页面展示.md）纯文本化；
      // 期别由 Q1 派生（P-01/P-02）。
      // 防御（评审并发 P2-1）：phaseCode 缺失（异常包）时 fail-closed
      // 输出"期别未定"，绝不默认渲染缓解期医学断言。
      if (verdict.phaseCode !== "acute" && verdict.phaseCode !== "remission") {
        return output(
          "classified_result_phase_unknown",
          `您的体质类型为：【${syndrome}】\n` +
            `期别信息暂未确定，本工具暂不输出具体方案。本结果由固定规则产生，仅供参考，最终方案请以门诊诊断为准。`,
          fields
        );
      }
      const content =
        verdict.phaseCode === "acute"
          ? acuteTemplate(syndrome, verdict.planBundle)
          : remissionTemplate(syndrome, verdict.planBundle);
      return output(
        verdict.phaseCode === "acute" ? "acute_result" : "remission_result",
        content,
        fields
      );
    }
  }
}

function output(
  templateId: string,
  content: string,
  fields: ExplanationFields | null
): ValidatedOutput {
  return {
    templateId,
    content,
    contentHash: sha256(content),
    fields
  };
}

/** 固定 system_notice：代码生成的降级提示，不绑定任何决策。 */
export function systemNotice(templateId: string, content: string): ValidatedOutput {
  return output(`system_notice_${templateId}`, content, null);
}
