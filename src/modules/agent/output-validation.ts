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
 * 本模块是唯一允许生成患者可见正文的代码路径：固定模板直接渲染；
 * 模型自由文本只有通过方案白名单、医学术语、数值与疗效承诺校验后才放行。
 */

import { createHash } from "node:crypto";

import type {
  ApprovedPlan,
  ClinicalVerdict,
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

const KNOWN_ACUPOINTS = [
  "鼻三线", "迎香", "印堂", "上迎香", "鼻通", "肺俞", "身柱", "风门",
  "大椎", "天枢", "足三里", "耳穴过敏区", "合谷", "曲池", "百会", "关元",
  "气海", "肾俞", "脾俞", "风池", "涌泉", "太阳", "攒竹", "四白", "睛明",
  "列缺", "外关", "太渊", "中脘", "神阙", "膻中", "丰隆", "血海"
] as const;

const METHOD_ALIASES = [
  ["刮痧", "姜刮", "刮"],
  ["艾灸", "灸"],
  ["拔罐"],
  ["针刺", "针灸", "毫针", "直刺", "斜刺", "平刺", "透刺"],
  ["按揉", "点揉", "揉", "按摩"],
  ["推拿"],
  ["耳穴", "压豆"],
  ["温敷"],
  ["贴敷"],
  ["熏洗"],
  ["放血", "刺络"],
  ["注射"],
  ["药物", "服药", "口服"],
  ["擦法", "指腹擦", "擦"]
] as const;

const GENERIC_ACUPOINT = /[\p{Script=Han}]{1,10}穴/gu;
const ACUPOINT_REFERENCES = [
  "该穴", "此穴", "本穴", "其他穴", "其它穴", "各穴", "上述穴", "这些穴"
] as const;
const APPROVED_ACUPOINT_PREFIX = /(?:在|于|取|用|按|揉|擦|找|含|选|为|是|的|里|中|问|讲|说|看|供)$/u;
const NUMBER_WITH_UNIT = /\d+(?:\.\d+)?(?:\s*[～~—\-至]\s*\d+(?:\.\d+)?)?\s*(?:次|分钟|小时|天|周|个月|厘米|毫米|cm|mm|寸|壮)/giu;
const EFFICACY_CLAIMS = /(?:保证|确保|一定|彻底)(?:治愈|根治|有效)|包治|永不复发|药到病除/u;

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

function planText(verdict: ClinicalVerdict): string {
  const plans = [verdict.planBundle?.acute, verdict.planBundle?.constitution]
    .filter((plan): plan is ApprovedPlan => plan !== null && plan !== undefined);
  return plans
    .map((plan) => [plan.name, plan.method, plan.steps, plan.precautions].join("\n"))
    .join("\n");
}

function compact(value: string): string {
  return value.replace(/\s+/gu, "").toLowerCase();
}

function methodAllowed(term: string, allowed: string): boolean {
  const group = METHOD_ALIASES.find((aliases) => aliases.includes(term as never));
  return group === undefined
    ? allowed.includes(term)
    : group.some((alias) => allowed.includes(alias));
}

function containsUnapprovedAcupoint(text: string, allowed: string): boolean {
  for (const point of KNOWN_ACUPOINTS) {
    if (text.includes(point) && !allowed.includes(point)) return true;
  }
  const genericPoints = text.match(GENERIC_ACUPOINT) ?? [];
  GENERIC_ACUPOINT.lastIndex = 0;
  return genericPoints.some((point) => {
    // “轻擦该穴位”一类代词引用可能被贪婪正则整体命中，引用对象仍须由
    // 上面的已知穴位白名单判定；这里只排除代词误伤，不新增任何穴位。
    if (ACUPOINT_REFERENCES.some((reference) => point.endsWith(reference))) {
      return false;
    }
    const approvedSuffix = KNOWN_ACUPOINTS
      .flatMap((knownPoint) => [knownPoint, `${knownPoint}穴`])
      .find(
        (candidate) =>
          point.endsWith(candidate) &&
          allowed.includes(candidate.endsWith("穴") ? candidate.slice(0, -1) : candidate)
      );
    if (approvedSuffix !== undefined) {
      const prefix = point.slice(0, -approvedSuffix.length);
      if (prefix === "" || APPROVED_ACUPOINT_PREFIX.test(prefix)) return false;
    }
    const withoutSuffix = point.slice(0, -1);
    return !allowed.includes(point) && !allowed.includes(withoutSuffix);
  });
}

/** 追问若点名当前方案外的穴位或疗法，模型调用前即确定性拒绝。 */
export function questionWithinApprovedPlan(
  question: string,
  verdict: ClinicalVerdict
): boolean {
  const allowed = planText(verdict);
  if (containsUnapprovedAcupoint(question, allowed)) return false;
  for (const aliases of METHOD_ALIASES) {
    for (const term of aliases) {
      if (question.includes(term) && !methodAllowed(term, allowed)) return false;
    }
  }
  return true;
}

/**
 * 自由文本医学校验：穴位与疗法只能来自方案，操作数值还须能在方案或
 * 本轮已审核来源中逐字找到；疗效承诺一律拒绝。
 */
export function validateGeneratedMedicalText(
  generated: string | null,
  verdict: ClinicalVerdict,
  sources: readonly PlanDialogueSource[] = []
): string | null {
  const text = generated?.trim() ?? "";
  if (text === "" || text.length > 800 || EFFICACY_CLAIMS.test(text)) return null;

  const allowedPlan = planText(verdict);
  if (containsUnapprovedAcupoint(text, allowedPlan)) return null;
  for (const aliases of METHOD_ALIASES) {
    for (const term of aliases) {
      if (text.includes(term) && !methodAllowed(term, allowedPlan)) return null;
    }
  }

  const evidence = compact([
    allowedPlan,
    ...sources.map((source) => source.text)
  ].join("\n"));
  const numericDetails = text.match(NUMBER_WITH_UNIT) ?? [];
  NUMBER_WITH_UNIT.lastIndex = 0;
  if (numericDetails.some((detail) => !evidence.includes(compact(detail)))) return null;
  return text;
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
    names.length === 0 ? "【依据】当前已审核方案" : `【依据】${names.join("；")}`,
    DISCLAIMER
  ].join("\n");
}

export function renderGeneratedPlanOutput(
  generated: string | null,
  verdict: ClinicalVerdict
): ValidatedOutput | null {
  const validated = validateGeneratedMedicalText(generated, verdict);
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
  sources: readonly PlanDialogueSource[]
): ValidatedOutput | null {
  const validated = validateGeneratedMedicalText(generated, verdict, sources);
  if (validated === null) return null;
  const content = `${validated}\n\n${evidenceFooter(verdict, sources)}`;
  return output("generated_follow_up", content, null);
}

/**
 * 模型回答不可用时，允许把单条已启用知识切片原文作为确定性兜底。
 * 原文仍须经过与模型输出相同的方案白名单、数值与疗效校验；任一来源
 * 不合格就跳过，绝不因为“来自知识库”而绕过临床边界。
 */
export function renderRetrievedEvidenceFollowUp(
  verdict: ClinicalVerdict,
  sources: readonly PlanDialogueSource[]
): ValidatedOutput | null {
  for (const source of sources) {
    const validated = validateGeneratedMedicalText(source.text, verdict, [source]);
    if (validated !== null) {
      const content = `${validated}\n\n${evidenceFooter(verdict, [source])}`;
      return output("retrieved_evidence_follow_up", content, null);
    }
  }
  return null;
}

export function renderFixedFollowUp(
  templateId: "follow_up_out_of_plan" | "follow_up_no_evidence" | "follow_up_degraded",
  content: string,
  verdict: ClinicalVerdict,
  sources: readonly PlanDialogueSource[] = []
): ValidatedOutput {
  return output(templateId, `${content}\n\n${evidenceFooter(verdict, sources)}`, null);
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
