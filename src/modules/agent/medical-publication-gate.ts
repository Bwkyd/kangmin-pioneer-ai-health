/**
 * 患者可见自由文本的最小医学硬事实发布条件。
 *
 * 这里不判断文风，也不把关键词当医学知识；它只识别必须有确定依据的
 * claim（证型/期别/方案、穴位/方法、操作参数、药物动作、禁忌、明确
 * 医学因果和患者事实）。依据只来自当前规则结果、批准方案和本轮检索源。
 */

import type { ClinicalVerdict, ConfirmedFact } from "../clinical-rules/contracts.js";
import {
  FIELD_LABELS,
  SEVERITY_LABELS,
  SYNDROME_LABELS
} from "../clinical-rules/domain.js";
import type { PlanDialogueSource } from "./model-ports.js";

export interface MedicalPublicationContext {
  verdict?: ClinicalVerdict | undefined;
  sources?: readonly PlanDialogueSource[] | undefined;
  facts?: readonly ConfirmedFact[] | undefined;
  /** 代码渲染的确定性结果正文，例如现行 acute/remission 固定模板。 */
  approvedText?: string | undefined;
  /** 独立知识问答可发布非个体化的一般概念与病理解释。 */
  allowGeneralKnowledge?: boolean | undefined;
}

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
  ["温敷", "热敷", "冷敷"],
  ["贴敷"],
  ["熏洗"],
  ["放血", "刺络"],
  ["注射"],
  ["药物", "服药", "口服"],
  ["洗鼻", "冲洗鼻腔"],
  ["泡脚"],
  ["擦法", "指腹擦", "擦"]
] as const;

const GENERIC_ACUPOINT = /[\p{Script=Han}]{1,10}穴/gu;
const ACUPOINT_REFERENCES = [
  "该穴", "此穴", "本穴", "其他穴", "其它穴", "各穴", "上述穴", "这些穴"
] as const;
const APPROVED_ACUPOINT_PREFIX = /(?:在|于|取|用|按|压|揉|擦|找|含|选|为|是|的|里|中|问|讲|说|看|供)$/u;
const NUMBER_WITH_UNIT = /(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半]+)(?:\s*[～~—–\-至]\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半]+))?\s*(?:次|分钟|小时|天|周|个月|厘米|毫米|cm|mm|寸|壮|毫升|ml|克|毫克|mg)/giu;
const EFFICACY_CLAIMS = /(?:保证|确保|一定|彻底)(?:治愈|根治|有效)|包治|永不复发|药到病除/u;
const CAUSAL_CLAIM = /(?:因为|由于|所以|因此|会导致|可导致|能够导致|导致|引起|诱发|造成|使得|从而|源于|根源在|归因于|是[^。！？；\n]{0,18}(?:原因|病因))/u;
const CONTRAINDICATION_CLAIM = /(?:(?:孕妇|孕期|怀孕|儿童|未满\s*12\s*周岁|老人|老年人|皮肤破损|高热|出血)[^。！？；\n]{0,24}(?:禁用|禁忌|不宜|慎用|不能|不可|不建议)|(?:禁用|禁忌|不宜|慎用|不能|不可|不建议)[^。！？；\n]{0,24}(?:孕妇|孕期|怀孕|儿童|老人|老年人|皮肤破损|高热|出血))/u;
const DRUG_ACTION = /(?:药|喷剂|滴剂|激素|抗组胺|减充血剂|抗生素)[^。！？；\n]{0,18}(?:服用|口服|使用|喷|滴|注射|加量|减量|停用|停药|换药)|(?:服用|口服|使用|喷|滴|注射|加量|减量|停用|停药|换药)[^。！？；\n]{0,18}(?:药|喷剂|滴剂|激素|抗组胺|减充血剂|抗生素)/u;
const MEDICATION_CHANGE_ACTION = /(?:加量|减量|增加剂量|减少剂量|剂量减半|停药|换药|自行停用|自行换用)/u;
const INVASIVE_OR_INGESTION_ACTION = /(?:进针|扎入|刺入|埋针|皮内针|塞进|塞入|放入鼻腔|滴入鼻腔|涂入鼻腔|涂在鼻腔|抹入鼻腔|抹在鼻腔|往鼻(?:子|腔)(?:里|内)[^。！？；\n]{0,8}(?:塞|放|滴|涂|抹)|经(?:面部|口腔|鼻腔)[^。！？；\n]{0,12}进入|吞服|煎服)/u;
const HIGH_RISK_PROCEDURE_ACTION = /(?:针刺|针灸|毫针|皮内针|直刺|斜刺|平刺|透刺|注射|放血|刺络|[\p{Script=Han}]{0,6}灸|拔罐|贴敷)/u;
const HIGH_RISK_PROCEDURE_IMPERATIVE = /(?:灸|针刺?|扎|刺|贴敷?|拔罐|放血|刺络)(?:在|于)?[\p{Script=Han}]{1,12}(?:穴|迎香|鼻|面|皮肤)/u;
const OPERATION_PARAMETER = /(?:力度|强度|深度|角度|方向|酸胀|麻胀|温热|发红|疼痛|轻柔|用力|留针|疗程)/u;
const OPERATION_VALUE = /(?:酸胀|麻胀|温热|发红|疼痛|轻柔|用力|留针|疗程)/gu;
const PRESCRIPTIVE_ACTION = /(?:可以|可用|建议|推荐|应当|应该|需要|请按|采用|改用|增加|配合|每日|每天|每周|每次|进行|操作|服用|口服|喷|滴|注射|加量|减量|停药)/u;
const PERSONALIZED_OR_ACTIONABLE_CLAIM = /(?:您|你|孩子|儿童|孕妇|孕期|怀孕|建议|推荐|应当|应该|请|可以|可用|需要|每日|每天|每周|每次|服用|口服|使用|加量|减量|停药|换药)/u;
const SAFE_REFUSAL = /(?:不能提供|无法确认|依据不足|不建议自行|不要自行|请勿自行|不得自行|不采用|不用|不灸|不针刺|应咨询|请咨询|及时就医|立即就医|前往急诊|联系急救|(?:当前|现有)方案(?:中)?(?:未|不)(?:包含|提供|允许))/u;
const DIAGNOSIS_ASSERTION = /(?:您|你)(?:目前|现在)?[^。！？；\n]{0,12}(?:肯定|一定|可能)?(?:就是|属于|患有|得了|诊断为|确诊为|考虑为|提示为|符合|证型为|是(?=肺经|肺气|脾气|肾阳|寒热|过敏性鼻炎|鼻窦炎|哮喘|感冒))/u;
const DIAGNOSIS_NEGATION = /(?:不能确定|无法判断|不能说明|不代表|不等于|并不意味着)[^。！？；\n]{0,18}(?:您|你)/u;
const PERSONAL_STATE_ASSERTION = /(?:您|你|目前|当前)[^。！？；\n]{0,16}(?:处于|属于|判定为|结果为|是)/u;
const PROFESSIONAL_OPERATION_TOPIC = /(?:针刺|针灸|毫针|皮内针|进针|注射|放血|刺络|[\p{Script=Han}]{0,6}灸|拔罐|刮痧|推拿|按摩|按揉|穴位按压|穴位贴敷|塞鼻|鼻腔[^。！？；\n]{0,8}(?:塞|滴|涂|抹)|药物配制)/u;
const OPERATION_GUIDANCE_REQUEST = /(?:怎么|如何|具体|多深|多大力度|多用力|多少次|几次|几分钟|几小时|几天|几周|多久|多长时间|离[^。！？；\n]{0,8}多远|距离|角度|方向|深度|剂量|用量|配制|操作步骤|进针路径)/u;
const SPECIAL_POPULATION_ACTION_REQUEST = /(?:孕妇|孕期|怀孕|儿童|孩子|未满\s*12\s*周岁)[^。！？；\n]{0,24}(?:可以|能否|能不能|怎么|如何|要不要|适合)[^。！？；\n]{0,18}(?:按|揉|灸|针|刺|贴|拔罐|刮痧|推拿|塞|滴|涂|抹|服药|用药)|(?:可以|能否|能不能|怎么|如何|要不要|适合)[^。！？；\n]{0,18}(?:按|揉|灸|针|刺|贴|拔罐|刮痧|推拿|塞|滴|涂|抹|服药|用药)[^。！？；\n]{0,24}(?:孕妇|孕期|怀孕|儿童|孩子)/u;
const SOURCE_BACKED_CONCEPT = /^[^。！？；\n]{1,36}(?:是指|指的是|是|属于|称为)[^。！？；\n]+/u;
const CONCEPT_OPERATION_DETAIL = /(?:\d+(?:\.\d+)?\s*(?:次|分钟|小时|天|周|厘米|毫米|cm|mm|寸|壮|毫升|ml|克|毫克|mg)|进针|刺入|扎入|剂量|用量|力度|强度|深度|角度|方向|疗程|留针)/iu;

/**
 * 独立知识问答中的专业自操作请求。只识别明确索要做法/参数或特殊人群
 * 个体动作；“艾灸是什么”“某穴在哪里”等概念问题不在此处预拒绝。
 */
export function requestsProfessionalOperationGuidance(question: string): boolean {
  return (
    PROFESSIONAL_OPERATION_TOPIC.test(question) &&
    OPERATION_GUIDANCE_REQUEST.test(question)
  ) || SPECIAL_POPULATION_ACTION_REQUEST.test(question);
}

function compact(value: string): string {
  return value
    .replace(/\s+/gu, "")
    .replace(/[～~—–至]/gu, "-")
    .replace(/(?:孕妇|怀孕期间|怀孕时|怀孕|孕期)/gu, "孕期")
    .replace(/(?:不得|不能|不可|不宜|禁用|慎用)/gu, "限制")
    .toLowerCase();
}

function planText(verdict: ClinicalVerdict | undefined): string {
  if (verdict === undefined) return "";
  return [verdict.planBundle?.acute, verdict.planBundle?.constitution]
    .filter((plan) => plan !== null && plan !== undefined)
    .map((plan) => [plan.name, plan.method, plan.steps, plan.precautions].join("\n"))
    .join("\n");
}

function ruleLabels(verdict: ClinicalVerdict | undefined): string[] {
  if (verdict === undefined) return [];
  const syndrome = verdict.syndromeCode === null
    ? null
    : (SYNDROME_LABELS[verdict.syndromeCode] ?? verdict.syndromeCode);
  const severity = verdict.severityCode === null
    ? null
    : (SEVERITY_LABELS[verdict.severityCode] ?? verdict.severityCode);
  const phase = verdict.phaseCode === "acute"
    ? "急性期 急性发作期"
    : verdict.phaseCode === "remission"
      ? "缓解期"
      : null;
  const audience = verdict.audience === "child"
    ? "儿童"
    : verdict.audience === "adult"
      ? "成人"
      : null;
  return [syndrome, severity, phase, audience, verdict.message]
    .filter((value): value is string => typeof value === "string" && value !== "");
}

function evidenceSegments(context: MedicalPublicationContext): string[] {
  return [
    context.approvedText,
    planText(context.verdict),
    ...ruleLabels(context.verdict),
    ...(context.sources ?? []).map((source) => source.text)
  ].filter((value): value is string => typeof value === "string" && value.trim() !== "");
}

function methodAllowed(term: string, allowed: string): boolean {
  const group = METHOD_ALIASES.find((aliases) => aliases.includes(term as never));
  return group === undefined
    ? allowed.includes(term)
    : group.some((alias) => allowed.includes(alias));
}

function containsUnsupportedAcupoint(text: string, allowed: string): boolean {
  for (const point of KNOWN_ACUPOINTS) {
    if (text.includes(point) && !allowed.includes(point)) return true;
  }
  const genericPoints = [...text.matchAll(GENERIC_ACUPOINT)];
  GENERIC_ACUPOINT.lastIndex = 0;
  return genericPoints.some((match) => {
    const point = match[0];
    const nextCharacter = text[(match.index ?? 0) + point.length];
    if (
      nextCharacter === "位" &&
      /(?:例如|详细|具体|相关|上述|这些|其他|其它|各个|所有).*穴$/u.test(point)
    ) return false;
    if (ACUPOINT_REFERENCES.some((reference) => point.endsWith(reference))) return false;
    const approvedCompound = KNOWN_ACUPOINTS.find((knownPoint) => {
      const holeIndex = knownPoint.indexOf("穴");
      if (holeIndex < 0 || holeIndex === knownPoint.length - 1) return false;
      const prefixThroughHole = knownPoint.slice(0, holeIndex + 1);
      return text.includes(knownPoint) && allowed.includes(knownPoint) &&
        point.endsWith(prefixThroughHole);
    });
    if (approvedCompound !== undefined) {
      const prefix = point.slice(0, -approvedCompound.slice(
        0,
        approvedCompound.indexOf("穴") + 1
      ).length);
      if (prefix === "" || APPROVED_ACUPOINT_PREFIX.test(prefix)) return false;
    }
    const approvedSuffix = KNOWN_ACUPOINTS
      .flatMap((knownPoint) => [knownPoint, `${knownPoint}穴`])
      .find((candidate) =>
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

function sentences(text: string): string[] {
  return text.match(/[^。！？；\n]+[。！？；\n]?/gu) ?? [];
}

function evidenceSupportsSentence(sentence: string, segments: readonly string[]): boolean {
  const claim = compact(sentence)
    .replace(/^(?:根据|依据)(?:当前|本轮|上述)?(?:资料|来源|方案|规则)(?:可知|显示|说明|记载|认为)?[，,:：]?/u, "")
    .replace(/^(?:资料|来源|方案|规则)(?:显示|说明|记载|认为)[，,:：]?/u, "");
  const normalized = segments.map(compact);
  return claim !== "" && normalized.some((segment) => segment.includes(claim));
}

function isSourceBackedConcept(
  sentence: string,
  sources: readonly PlanDialogueSource[]
): boolean {
  return SOURCE_BACKED_CONCEPT.test(sentence) &&
    !CONCEPT_OPERATION_DETAIL.test(sentence) &&
    !KNOWN_ACUPOINTS.some((point) => sentence.includes(point)) &&
    !/(?:取穴|主穴|配穴)/u.test(sentence) &&
    evidenceSupportsSentence(sentence, sources.map((source) => source.text));
}

function currentRuleClaimAllowed(sentence: string, verdict: ClinicalVerdict | undefined): boolean {
  if (verdict === undefined) return false;
  return ruleLabels(verdict).some((label) => sentence.includes(label)) &&
    !/(?:过敏性鼻炎|鼻窦炎|哮喘|感冒|疾病|病症)/u.test(sentence);
}

function unsupportedPatientFact(
  sentence: string,
  facts: readonly ConfirmedFact[]
): boolean {
  if (!/(?:您|你)/u.test(sentence) || /(?:如果|若|是否|尚不清楚|无法确认)/u.test(sentence)) {
    return false;
  }
  const guardedFields = [
    "pregnancy", "child_under_12", "urgent_help", "high_fever",
    "epistaxis_foul_discharge", "severe_neuro_symptoms", "skin_lesion",
    "diagnosed_confirmed"
  ] as const;
  for (const fieldCode of guardedFields) {
    const label = FIELD_LABELS[fieldCode];
    if (label === undefined || !sentence.includes(label)) continue;
    const fact = facts.find((entry) => entry.fieldCode === fieldCode);
    const negative = /(?:没有|未|不是|并非|否认)/u.test(sentence);
    const positive = /(?:有|正在|已经|是|属于|出现)/u.test(sentence);
    if (negative && fact?.state !== "no") return true;
    if (positive && fact?.state !== "yes") return true;
  }
  return false;
}

function unsupportedPlanName(sentence: string, evidence: string): boolean {
  const candidates = [
    ...sentence.matchAll(/【([^】\n]{2,30}方案)】/gu),
    ...sentence.matchAll(/(?:推荐|采用|改用|调整为|方案是)([^，。；\n]{2,30}方案)/gu)
  ].map((match) => match[1]
    ?.replace(/[【】「」]/gu, "")
    .replace(/^(?:的|当前|本次)/u, ""))
    .filter((value): value is string => value !== undefined);
  return candidates.some((candidate) => !evidence.includes(candidate));
}

/** 返回 null 表示候选不得发布；普通措辞不在本函数裁决范围。 */
export function validateMedicalHardFacts(
  generated: string | null,
  context: MedicalPublicationContext = {}
): string | null {
  const text = generated?.trim() ?? "";
  if (text === "" || text.length > 800 || EFFICACY_CLAIMS.test(text)) return null;

  const segments = evidenceSegments(context);
  const evidence = segments.join("\n");
  const approvedPlan = planText(context.verdict);
  const facts = context.facts ?? [];

  const numericDetails = text.match(NUMBER_WITH_UNIT) ?? [];
  NUMBER_WITH_UNIT.lastIndex = 0;
  const normalizedEvidence = compact(evidence);
  if (numericDetails.some((detail) => !normalizedEvidence.includes(compact(detail)))) return null;

  for (const sentence of sentences(text)) {
    const safeRefusal = SAFE_REFUSAL.test(sentence);
    SAFE_REFUSAL.lastIndex = 0;

    if (
      DIAGNOSIS_ASSERTION.test(sentence) &&
      !DIAGNOSIS_NEGATION.test(sentence) &&
      !currentRuleClaimAllowed(sentence, context.verdict)
    ) return null;
    DIAGNOSIS_ASSERTION.lastIndex = 0;
    DIAGNOSIS_NEGATION.lastIndex = 0;

    if (unsupportedPatientFact(sentence, facts)) return null;
    if (unsupportedPlanName(sentence, evidence)) return null;

    for (const label of Object.values(SYNDROME_LABELS)) {
      if (
        sentence.includes(label) &&
        !ruleLabels(context.verdict).some((current) => current.includes(label)) &&
        !safeRefusal &&
        !evidenceSupportsSentence(sentence, context.sources?.map((source) => source.text) ?? [])
      ) return null;
    }

    const governedStates = [
      "急性期", "急性发作期", "缓解期", "轻度", "中重度", "儿童", "成人"
    ];
    if (PERSONAL_STATE_ASSERTION.test(sentence)) {
      const current = ruleLabels(context.verdict).join(" ");
      if (governedStates.some((label) => sentence.includes(label) && !current.includes(label))) {
        return null;
      }
    }
    PERSONAL_STATE_ASSERTION.lastIndex = 0;

    if (CONTRAINDICATION_CLAIM.test(sentence) && !evidenceSupportsSentence(sentence, segments)) {
      return null;
    }
    CONTRAINDICATION_CLAIM.lastIndex = 0;

    const generalKnowledgeCausality = context.allowGeneralKnowledge === true &&
      !PERSONALIZED_OR_ACTIONABLE_CLAIM.test(sentence);
    if (
      CAUSAL_CLAIM.test(sentence) &&
      !generalKnowledgeCausality &&
      !evidenceSupportsSentence(sentence, segments)
    ) return null;
    CAUSAL_CLAIM.lastIndex = 0;

    if (DRUG_ACTION.test(sentence) && !safeRefusal && !evidenceSupportsSentence(sentence, segments)) {
      return null;
    }
    DRUG_ACTION.lastIndex = 0;

    if (
      MEDICATION_CHANGE_ACTION.test(sentence) &&
      !safeRefusal &&
      !evidenceSupportsSentence(sentence, [approvedPlan])
    ) return null;
    MEDICATION_CHANGE_ACTION.lastIndex = 0;

    if (
      INVASIVE_OR_INGESTION_ACTION.test(sentence) &&
      !safeRefusal &&
      !evidenceSupportsSentence(sentence, [approvedPlan])
    ) return null;
    INVASIVE_OR_INGESTION_ACTION.lastIndex = 0;

    if (OPERATION_PARAMETER.test(sentence) && !safeRefusal) {
      const values = sentence.match(OPERATION_VALUE) ?? [];
      OPERATION_VALUE.lastIndex = 0;
      if (
        !evidenceSupportsSentence(sentence, segments) &&
        (values.length === 0 || values.some((value) => !evidence.includes(value)))
      ) return null;
    }
    OPERATION_PARAMETER.lastIndex = 0;

    if (!safeRefusal && containsUnsupportedAcupoint(sentence, evidence)) return null;

    for (const aliases of METHOD_ALIASES) {
      for (const term of aliases) {
        if (sentence.includes(term) && !safeRefusal && !methodAllowed(term, evidence)) return null;
      }
    }

    if (PRESCRIPTIVE_ACTION.test(sentence) && !safeRefusal) {
      if (DRUG_ACTION.test(sentence) && !evidenceSupportsSentence(sentence, [approvedPlan])) {
        return null;
      }
      if (context.verdict === undefined) {
        if (
          (HIGH_RISK_PROCEDURE_ACTION.test(sentence) ||
            HIGH_RISK_PROCEDURE_IMPERATIVE.test(sentence)) &&
          !isSourceBackedConcept(sentence, context.sources ?? [])
        ) return null;
      } else {
        if (containsUnsupportedAcupoint(sentence, approvedPlan)) return null;
        for (const aliases of METHOD_ALIASES) {
          for (const term of aliases) {
            if (sentence.includes(term) && !methodAllowed(term, approvedPlan)) return null;
          }
        }
      }
    }
    HIGH_RISK_PROCEDURE_ACTION.lastIndex = 0;
    HIGH_RISK_PROCEDURE_IMPERATIVE.lastIndex = 0;
    DRUG_ACTION.lastIndex = 0;
    PRESCRIPTIVE_ACTION.lastIndex = 0;
  }
  return text;
}
