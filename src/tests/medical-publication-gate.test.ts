import assert from "node:assert/strict";
import test from "node:test";

import { validateMedicalHardFacts } from "@kangmin/core/intelligence/agent/medical-publication-gate";
import type { ClinicalVerdict, ConfirmedFact } from "@kangmin/core/intelligence/clinical-rules/contracts";

const plan = {
  planId: "plan-yingxiang",
  planRevision: 1,
  name: "急性期迎香调理方案",
  method: "指腹擦迎香",
  steps: JSON.stringify(["指腹轻擦迎香，以皮肤温热为度"]),
  precautions: "皮肤破损时暂停操作。",
  videoResourceId: null,
  attributes: {}
};

const verdict: ClinicalVerdict = {
  outcome: "classified",
  stage: "completed",
  severityCode: "mild",
  syndromeCode: "LUNG_HEAT",
  phaseCode: "acute",
  audience: "adult",
  nextQuestions: [],
  allQuestions: [],
  matchedRuleIds: ["T1"],
  message: null,
  planId: plan.planId,
  planRevision: plan.planRevision,
  planBundle: { acute: plan, constitution: null },
  rulePackageVersion: "clinical-rules-test",
  rulePackageHash: "hash"
};

const facts: ConfirmedFact[] = [{
  fieldCode: "pregnancy",
  state: "unknown",
  source: "patient_confirmation"
}];

const source = [{
  knowledgeId: "knowledge-cold-air",
  name: "冷空气与鼻部反应",
  source: "测试资料",
  text: "冷空气刺激鼻黏膜时，可能使鼻腔分泌增加，出现清水样鼻涕。艾灸是借助艾绒燃烧产生温热刺激的一种传统外治方法。"
}];

const context = {
  verdict,
  facts,
  sources: source,
  approvedText: "当前为急性发作期、肺经伏热、轻度、成人。急性期方案每日执行1次。"
};

test("医学硬事实发布条件：5条规则、方案与来源授权事实保持可回答", () => {
  const allowed = [
    "系统当前判定您处于急性发作期，证型为肺经伏热。",
    "当前采用【急性期迎香调理方案】。",
    "当前方案采用指腹轻擦迎香，以皮肤温热为度。",
    "急性期方案每日执行1次。",
    "冷空气刺激鼻黏膜时，可能使鼻腔分泌增加，出现清水样鼻涕。"
  ];
  for (const answer of allowed) {
    assert.equal(validateMedicalHardFacts(answer, context), answer);
  }
});

test("医学硬事实发布条件：truth 授权题 P01-P05 保持 5/5", () => {
  const truthText = [
    "急性期方案每日执行，直至症状明显缓解。",
    "调体方案每周执行2-3次，建议长期坚持。",
    "两种方案可同一天执行，互不冲突，建议先做急性期通窍，再做调体固本。"
  ].join("\n");
  const lungPlan = {
    ...plan,
    name: "肺经伏热调体方案",
    method: "肺俞穴点揉",
    steps: JSON.stringify(["肺俞穴点揉"])
  };
  const lungContext = {
    ...context,
    verdict: { ...verdict, planBundle: { acute: lungPlan, constitution: lungPlan } },
    approvedText: `${truthText}\n肺俞穴采用点揉，不灸。`
  };
  const childPlan = {
    ...plan,
    name: "儿童急性期快速通窍方案",
    method: "鼻炎手法；头面四大手法；鼻三线姜刮",
    steps: JSON.stringify(["鼻炎手法", "头面四大手法", "鼻三线姜刮"])
  };
  const childContext = {
    ...context,
    verdict: {
      ...verdict,
      audience: "child" as const,
      planBundle: { acute: childPlan, constitution: null }
    },
    approvedText: `${truthText}\n儿童急性期快速通窍方案包括鼻炎手法、头面四大手法、鼻三线姜刮。`
  };
  const cases = [
    ["急性期方案每日执行，直至症状明显缓解。", { ...context, approvedText: truthText }],
    ["调体方案每周执行2-3次，建议长期坚持。", { ...context, approvedText: truthText }],
    ["两种方案可同一天执行，建议先做急性期通窍，再做调体固本。", { ...context, approvedText: truthText }],
    ["肺俞穴采用点揉，不灸。", lungContext],
    ["系统允许推荐的儿童急性期快速通窍方案有：鼻炎手法、头面四大手法、鼻三线姜刮。", childContext]
  ] as const;
  for (const [answer, publicationContext] of cases) {
    assert.equal(validateMedicalHardFacts(answer, publicationContext), answer);
  }
});

test("医学硬事实发布条件：5条普通表达不因措辞白名单被压制", () => {
  const allowed = [
    "我换一种简单说法：鼻子会对周围环境作出反应。",
    "艾灸是借助艾绒燃烧产生温热刺激的一种传统外治方法。",
    "当前方案未包含艾灸，我不能把它新增为你的操作建议。",
    "这些表现不代表您就是过敏性鼻炎，还需要结合更多信息。",
    "当前依据不足。你最近是换季时加重，还是全年都这样？"
  ];
  for (const answer of allowed) {
    assert.equal(validateMedicalHardFacts(answer, context), answer);
  }
});

test("独立知识问答允许一般病理解释，但不放行个人因果或孕期禁忌", () => {
  for (const general of [
    "过敏性鼻炎鼻塞是因为鼻黏膜发生炎症和肿胀。",
    "组胺等炎症介质会导致打喷嚏、流鼻涕和鼻塞。",
    "冷空气刺激可能引起打喷嚏，但不等于过敏性鼻炎。"
  ]) {
    assert.equal(
      validateMedicalHardFacts(general, { allowGeneralKnowledge: true }),
      general
    );
  }
  for (const answer of [
    "你的鼻塞就是因为过敏性鼻炎。",
    "孕期按合谷会导致流产。"
  ]) {
    assert.equal(
      validateMedicalHardFacts(answer, { allowGeneralKnowledge: true }),
      null,
      answer
    );
  }
});

test("来源原文可解释专业方法概念，但不能借概念句携带操作参数", () => {
  const definition = "热敏灸是采用艾热针对热敏腧穴施灸的一种专业中医适宜技术。";
  const conceptSource = [{
    knowledgeId: "knowledge-concept",
    name: "专业概念",
    source: "测试资料",
    text: `${definition}热敏灸进针深度为2寸。`
  }];
  assert.equal(validateMedicalHardFacts(definition, { sources: conceptSource }), definition);
  assert.equal(
    validateMedicalHardFacts("热敏灸是采用艾热施灸，每次操作20分钟。", { sources: conceptSource }),
    null
  );
});

test("医学硬事实发布条件：10类未获依据硬事实全部拒绝", () => {
  const blocked = [
    "您肯定就是过敏性鼻炎。",
    "您现在属于肺气虚寒。",
    "您目前处于缓解期。",
    "系统推荐【神奇通窍调理方案】。",
    "可以配合足三里按揉。",
    "可以增加艾灸。",
    "迎香每天按揉3次，每次5分钟。",
    "可以把通鼻喷剂加量使用。",
    "孕妇不能按合谷，否则会导致流产。",
    "您没有怀孕，所以可以继续操作。"
  ];
  for (const answer of blocked) {
    assert.equal(validateMedicalHardFacts(answer, context), null, answer);
  }
});

test("医学硬事实发布条件：不带标准疗法名的侵入性动作变式仍被拒绝", () => {
  for (const answer of [
    "可以把苍耳子粉塞进鼻腔。",
    "可以把苍耳子粉涂在鼻腔。",
    "可以往鼻子里抹药粉。",
    "可以把苍耳子粉的剂量减半。",
    "可以在迎香埋皮内针。",
    "操作通常需要经面部、口腔或鼻腔特定路径进入。"
  ]) {
    assert.equal(validateMedicalHardFacts(answer, context), null, answer);
  }
  assert.equal(validateMedicalHardFacts(
    "可以针刺迎香。",
    { sources: [{ ...source[0]!, text: "针刺迎香属于专业操作。" }] }
  ), null);
  assert.equal(validateMedicalHardFacts(
    "灸迎香即可。",
    { sources: [{ ...source[0]!, text: "艾灸是借助温热刺激的一种传统外治方法。" }] }
  ), null);
});

test("医学硬事实发布条件：相似片段不能冒充同一条因果依据", () => {
  for (const answer of [
    "冷空气刺激鼻黏膜，所以一定是肺气虚寒导致清水样鼻涕。",
    "冷空气会诱发肺气虚寒。",
    "清水样鼻涕源于肺气虚寒。",
    "您的表现考虑为过敏性鼻炎。"
  ]) {
    assert.equal(validateMedicalHardFacts(answer, { sources: source }), null, answer);
  }
});
