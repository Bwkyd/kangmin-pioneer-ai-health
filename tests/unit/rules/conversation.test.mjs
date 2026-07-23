import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_QUESTION_KEY,
  createAssessmentPayload,
  findNextQuestion,
} from "../../../lib/agent/conversation.ts";
import { evaluateAssessment } from "../../../lib/agent/rules.ts";

test("未回答字段统一作为 unknown 提交，不把缺失误当作否", () => {
  const payload = createAssessmentPayload({
    respiratoryEmergency: "no",
    thirst: "yes",
  });

  assert.equal(FIRST_QUESTION_KEY, "respiratoryEmergency");
  assert.equal(payload.safety.respiratoryEmergency, "no");
  assert.equal(payload.safety.persistentHighFever, "unknown");
  assert.equal(payload.diagnosedAllergicRhinitis, "unknown");
  assert.equal(payload.severity.sleepAffected, "unknown");
  assert.equal(payload.syndrome.thirst, "yes");
  assert.equal(payload.syndrome.fatigue, "unknown");
});

test("下一题只采用服务端 nextQuestions 且跳过已明确回答项", () => {
  const assessment = {
    status: "need_more_information",
    nextQuestions: ["respiratoryEmergency", "persistentHighFever"],
  };

  assert.equal(
    findNextQuestion(assessment, { respiratoryEmergency: "unknown" }),
    "persistentHighFever",
  );
  assert.equal(
    findNextQuestion(assessment, {
      respiratoryEmergency: "unknown",
      persistentHighFever: "no",
    }),
    null,
  );
});

test("确诊前提完全来自服务端 nextQuestions，用户明确回答后允许转诊结束", () => {
  const eligibility = {
    status: "referred",
    nextQuestions: ["diagnosedAllergicRhinitis"],
  };

  assert.equal(findNextQuestion(eligibility, {}), "diagnosedAllergicRhinitis");
  assert.equal(
    findNextQuestion(eligibility, { diagnosedAllergicRhinitis: "unknown" }),
    null,
  );
  assert.equal(
    findNextQuestion({ status: "referred" }, {
      diagnosedAllergicRhinitis: "no",
    }),
    null,
  );
});

test("终态、未知字段名和已明确 unknown 都不会形成重复追问", () => {
  assert.equal(findNextQuestion({ status: "blocked" }, {}), null);
  assert.equal(findNextQuestion({ status: "classified" }, {}), null);
  assert.equal(
    findNextQuestion(
      {
        status: "need_more_information",
        nextQuestions: ["untrustedField", "sleepAffected"],
      },
      { sleepAffected: "unknown" },
    ),
    null,
  );
});

function answerAndNavigate(answers, key, value) {
  const nextAnswers = { ...answers, [key]: value };
  const assessment = evaluateAssessment(createAssessmentPayload(nextAnswers));
  return {
    answers: nextAnswers,
    assessment,
    nextQuestion: findNextQuestion(assessment, nextAnswers),
  };
}

test("真实规则顺序先完成安全筛查，再问确诊前提并进入后续阶段", () => {
  let state = {
    answers: {},
    assessment: null,
    nextQuestion: FIRST_QUESTION_KEY,
  };

  for (const safetyQuestion of [
    "respiratoryEmergency",
    "persistentHighFever",
    "severeNoseBleed",
    "unilateralFoulDischarge",
    "severeNeurologicalSymptoms",
  ]) {
    assert.equal(state.nextQuestion, safetyQuestion);
    state = answerAndNavigate(state.answers, safetyQuestion, "no");
  }

  assert.equal(state.assessment.status, "referred");
  assert.equal(state.nextQuestion, "diagnosedAllergicRhinitis");

  state = answerAndNavigate(
    state.answers,
    "diagnosedAllergicRhinitis",
    "yes",
  );
  assert.equal(state.assessment.status, "need_more_information");
  assert.equal(state.assessment.stage, "severity");
  assert.equal(state.nextQuestion, "sleepAffected");
});

test("高危肯定立即终止，全部显式不确定则明确结束而不重复", () => {
  const blocked = answerAndNavigate(
    {},
    "respiratoryEmergency",
    "yes",
  );
  assert.equal(blocked.assessment.status, "blocked");
  assert.equal(blocked.nextQuestion, null);

  let state = {
    answers: {},
    assessment: null,
    nextQuestion: FIRST_QUESTION_KEY,
  };
  for (const safetyQuestion of [
    "respiratoryEmergency",
    "persistentHighFever",
    "severeNoseBleed",
    "unilateralFoulDischarge",
    "severeNeurologicalSymptoms",
  ]) {
    state = answerAndNavigate(state.answers, safetyQuestion, "unknown");
  }
  assert.equal(state.assessment.status, "need_more_information");
  assert.equal(state.assessment.stage, "safety");
  assert.equal(state.nextQuestion, null);
});

test("已有严重度肯定项和唯一证型时跳过不影响结论的剩余问题", () => {
  let answers = {
    respiratoryEmergency: "no",
    persistentHighFever: "no",
    severeNoseBleed: "no",
    unilateralFoulDischarge: "no",
    severeNeurologicalSymptoms: "no",
    diagnosedAllergicRhinitis: "yes",
  };

  let state = answerAndNavigate(answers, "sleepAffected", "yes");
  assert.equal(state.assessment.status, "need_more_information");
  assert.equal(state.assessment.stage, "syndrome");
  assert.equal(state.nextQuestion, "thirst");
  assert.equal(state.answers.activityAffected, undefined);

  state = answerAndNavigate(state.answers, "thirst", "yes");
  state = answerAndNavigate(state.answers, state.nextQuestion, "no");
  state = answerAndNavigate(state.answers, state.nextQuestion, "no");

  assert.equal(state.assessment.status, "classified");
  assert.equal(state.assessment.severity, "moderate_severe");
  assert.equal(state.assessment.syndrome.syndromeCode, "LUNG_HEAT");
  assert.equal(state.nextQuestion, null);
  assert.equal(state.answers.activityAffected, undefined);
  assert.equal(state.answers.fearWind, undefined);
  assert.equal(state.answers.coldIntolerance, undefined);
});
