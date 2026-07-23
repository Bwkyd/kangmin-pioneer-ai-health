"use client";

import {
  captureOriginalValues,
  restoreAcceptedValues,
  type CandidateDecision,
} from "@/lib/agent/candidate-state";
import { useMemo, useState } from "react";

type TriState = "yes" | "no" | "unknown";
type View = "consent" | "questions" | "review" | "submitting" | "result";

type QuestionKey =
  | "diagnosedAllergicRhinitis"
  | "respiratoryEmergency"
  | "persistentHighFever"
  | "severeNoseBleed"
  | "unilateralFoulDischarge"
  | "severeNeurologicalSymptoms"
  | "sleepAffected"
  | "activityAffected"
  | "workStudyAffected"
  | "symptomTroublesome"
  | "thirst"
  | "fatigue"
  | "limbsNotWarm"
  | "fearWind"
  | "coldIntolerance";

type AnswerMap = Partial<Record<QuestionKey, TriState>>;

interface ExtractionData {
  requiresConfirmation: true;
  candidates: {
    diagnosedAllergicRhinitis?: TriState;
    safety: Partial<Record<QuestionKey, TriState>>;
    severity: Partial<Record<QuestionKey, TriState>>;
    syndrome: Partial<Record<QuestionKey, TriState>>;
  };
  safetyGate: {
    status: "clear" | "confirmation_required";
    candidateFields: QuestionKey[];
  };
  model: {
    used: boolean;
    degradedReason?: "model_not_configured" | "model_unavailable";
  };
}

interface CandidateEntry {
  key: QuestionKey;
  value: TriState;
}

interface ExplanationData {
  summary: string;
  disclaimer: string;
}

type ExplanationStatus = "idle" | "loading" | "ready" | "degraded" | "error";

type Assessment =
  | {
      status: "classified";
      severity: "mild" | "moderate_severe";
      syndrome: { syndromeCode: string; ruleId: string };
      planStatus: "no_approved_plan";
      rulePackageVersion: string;
    }
  | {
      status: "blocked";
      safety: { matchedRuleIds: string[] };
      rulePackageVersion: string;
    }
  | {
      status: "conflict" | "no_match";
      severity: "mild" | "moderate_severe";
      syndrome: {
        candidateSyndromes?: string[];
        matchedRuleIds?: string[];
      };
      rulePackageVersion: string;
    }
  | {
      status: "need_more_information";
      stage: "safety" | "severity" | "syndrome";
      nextQuestions: string[];
      rulePackageVersion: string;
    }
  | {
      status: "referred";
      reason: "not_diagnosed_or_uncertain";
      rulePackageVersion: string;
    };

interface Question {
  key: QuestionKey;
  section: "就诊前提" | "高危筛查" | "严重程度" | "证型信息";
  title: string;
  help?: string;
}

const questions: Question[] = [
  {
    key: "diagnosedAllergicRhinitis",
    section: "就诊前提",
    title: "是否已由正规医疗机构确诊为过敏性鼻炎？",
    help: "未确诊或不确定时，本工具不会继续给出分类结果。",
  },
  {
    key: "respiratoryEmergency",
    section: "高危筛查",
    title: "目前是否有呼吸困难、喘不过气或口唇发紫？",
  },
  {
    key: "persistentHighFever",
    section: "高危筛查",
    title: "目前是否有持续高热？",
  },
  {
    key: "severeNoseBleed",
    section: "高危筛查",
    title: "目前是否有大量鼻出血或鼻血止不住？",
  },
  {
    key: "unilateralFoulDischarge",
    section: "高危筛查",
    title: "目前是否有单侧、带明显臭味的鼻腔分泌物？",
  },
  {
    key: "severeNeurologicalSymptoms",
    section: "高危筛查",
    title: "目前是否有剧烈头痛、意识模糊、抽搐等严重表现？",
  },
  {
    key: "sleepAffected",
    section: "严重程度",
    title: "鼻部不适是否影响睡眠？",
  },
  {
    key: "activityAffected",
    section: "严重程度",
    title: "鼻部不适是否影响日常活动？",
  },
  {
    key: "workStudyAffected",
    section: "严重程度",
    title: "鼻部不适是否影响工作或学习？",
  },
  {
    key: "symptomTroublesome",
    section: "严重程度",
    title: "这些症状是否让你明显困扰？",
  },
  {
    key: "thirst",
    section: "证型信息",
    title: "近期是否容易口渴？",
  },
  {
    key: "fatigue",
    section: "证型信息",
    title: "近期是否经常感到乏力？",
  },
  {
    key: "limbsNotWarm",
    section: "证型信息",
    title: "近期是否经常手脚不温？",
  },
  {
    key: "fearWind",
    section: "证型信息",
    title: "近期是否明显怕风？",
  },
  {
    key: "coldIntolerance",
    section: "证型信息",
    title: "近期是否明显怕冷？",
  },
];

const answerLabels: Array<{ value: TriState; label: string }> = [
  { value: "yes", label: "是" },
  { value: "no", label: "否" },
  { value: "unknown", label: "不确定" },
];

const fieldLabels = Object.fromEntries(
  questions.map((question) => [question.key, question.title]),
) as Record<QuestionKey, string>;

function toPayload(answers: AnswerMap) {
  return {
    diagnosedAllergicRhinitis: answers.diagnosedAllergicRhinitis,
    safety: {
      respiratoryEmergency: answers.respiratoryEmergency,
      persistentHighFever: answers.persistentHighFever,
      severeNoseBleed: answers.severeNoseBleed,
      unilateralFoulDischarge: answers.unilateralFoulDischarge,
      severeNeurologicalSymptoms: answers.severeNeurologicalSymptoms,
    },
    severity: {
      sleepAffected: answers.sleepAffected,
      activityAffected: answers.activityAffected,
      workStudyAffected: answers.workStudyAffected,
      symptomTroublesome: answers.symptomTroublesome,
    },
    syndrome: {
      thirst: answers.thirst,
      fatigue: answers.fatigue,
      limbsNotWarm: answers.limbsNotWarm,
      fearWind: answers.fearWind,
      coldIntolerance: answers.coldIntolerance,
    },
  };
}

function flattenCandidates(data: ExtractionData | null): CandidateEntry[] {
  if (!data) return [];

  const entries: CandidateEntry[] = [];
  if (data.candidates.diagnosedAllergicRhinitis) {
    entries.push({
      key: "diagnosedAllergicRhinitis",
      value: data.candidates.diagnosedAllergicRhinitis,
    });
  }

  for (const group of [
    data.candidates.safety,
    data.candidates.severity,
    data.candidates.syndrome,
  ]) {
    for (const [key, value] of Object.entries(group)) {
      if (value) {
        entries.push({ key: key as QuestionKey, value });
      }
    }
  }

  return entries;
}

function resultCopy(assessment: Assessment) {
  switch (assessment.status) {
    case "blocked":
      return {
        tone: "danger",
        eyebrow: "高危筛查已拦截",
        title: "请停止自助评估并尽快就医",
        body: "你确认的信息触发了高危规则。若正在呼吸困难或症状快速加重，请立即寻求急诊帮助。",
        detail: `触发规则：${assessment.safety.matchedRuleIds.join("、")}`,
      };
    case "referred":
      return {
        tone: "warning",
        eyebrow: "不满足评估前提",
        title: "请先到正规医疗机构明确诊断",
        body: "当前未确认已经确诊过敏性鼻炎，本工具不继续输出分类结果。",
        detail: "系统未进行证型判断。",
      };
    case "need_more_information":
      return {
        tone: "warning",
        eyebrow: "信息不足",
        title: "需要补充或确认回答",
        body: "“不确定”不会被系统当作“否”。请返回问卷确认相关问题，或咨询专业人员。",
        detail: `待确认：${assessment.nextQuestions
          .map((field) => fieldLabels[field as QuestionKey] ?? field)
          .join("；")}`,
      };
    case "conflict":
      return {
        tone: "warning",
        eyebrow: "规则结果冲突",
        title: "本轮不输出单一证型",
        body: "多条固定规则同时命中，系统没有自行猜测。请由临床人员复核。",
        detail: `候选代码：${assessment.syndrome.candidateSyndromes?.join("、") || "未提供"}`,
      };
    case "no_match":
      return {
        tone: "warning",
        eyebrow: "无匹配结果",
        title: "当前回答未命中固定规则",
        body: "系统不会为了给出结果而扩写或猜测，请由临床人员复核。",
        detail: `严重程度代码：${assessment.severity}`,
      };
    case "classified":
      return {
        tone: "success",
        eyebrow: "固定规则已完成分类",
        title: `证型代码：${assessment.syndrome.syndromeCode}`,
        body: "这是待临床确认的内部测试输出，不是诊断。当前没有经审核的个性化调理方案。",
        detail: `严重程度：${assessment.severity} · 规则：${assessment.syndrome.ruleId} · no_approved_plan`,
      };
  }
}

export default function Home() {
  const [view, setView] = useState<View>("consent");
  const [consented, setConsented] = useState(false);
  const [ageGroup, setAgeGroup] = useState<"" | "adult" | "minor">("");
  const [guardianConfirmed, setGuardianConfirmed] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [freeText, setFreeText] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [descriptionHandled, setDescriptionHandled] = useState(false);
  const [extraction, setExtraction] = useState<ExtractionData | null>(null);
  const [candidateDecisions, setCandidateDecisions] = useState<
    Partial<Record<QuestionKey, CandidateDecision>>
  >({});
  const [candidateOriginalAnswers, setCandidateOriginalAnswers] =
    useState<AnswerMap>({});
  const [extractionNotice, setExtractionNotice] = useState("");
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [explanation, setExplanation] = useState<ExplanationData | null>(null);
  const [explanationStatus, setExplanationStatus] =
    useState<ExplanationStatus>("idle");
  const [error, setError] = useState("");

  const canStart =
    consented &&
    ageGroup !== "" &&
    (ageGroup === "adult" || guardianConfirmed);
  const answeredCount = Object.keys(answers).length;
  const progress = Math.round((answeredCount / questions.length) * 100);
  const currentQuestion = questions[questionIndex];
  const summary = useMemo(
    () =>
      questions.map((question) => ({
        ...question,
        answer: answers[question.key],
      })),
    [answers],
  );
  const extractedCandidates = useMemo(
    () => flattenCandidates(extraction),
    [extraction],
  );
  const unresolvedCandidateCount = extractedCandidates.filter(
    (candidate) => !candidateDecisions[candidate.key],
  ).length;
  const descriptionReady =
    freeText.trim().length === 0 ||
    (descriptionHandled && unresolvedCandidateCount === 0);

  const begin = () => {
    if (!canStart) return;
    setView("questions");
  };

  const answerQuestion = (value: TriState) => {
    const nextAnswers = { ...answers, [currentQuestion.key]: value };
    setAnswers(nextAnswers);
    if (
      extractedCandidates.some(
        (candidate) => candidate.key === currentQuestion.key,
      )
    ) {
      setCandidateOriginalAnswers((current) => ({
        ...current,
        [currentQuestion.key]: value,
      }));
      setCandidateDecisions((current) => ({
        ...current,
        [currentQuestion.key]: "ignored",
      }));
    }
    if (questionIndex < questions.length - 1) {
      setQuestionIndex((index) => index + 1);
      return;
    }
    setView("review");
  };

  const extractFreeText = async () => {
    const text = freeText.trim();
    if (!text) return;

    const baselineAnswers = restoreAcceptedValues(
      answers,
      extractedCandidates.map((candidate) => candidate.key),
      candidateDecisions,
      candidateOriginalAnswers,
    ) as AnswerMap;
    setAnswers(baselineAnswers);
    setExtracting(true);
    setExtractionNotice("");
    setCandidateDecisions({});
    setCandidateOriginalAnswers({});
    try {
      const response = await fetch("/api/v1/agent/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const result = (await response.json()) as
        | { ok: true; data: ExtractionData }
        | { ok: false; error: { code: string; message: string } };
      if (!response.ok || !result.ok) {
        throw new Error(result.ok ? "提取服务响应异常" : result.error.message);
      }

      setExtraction(result.data);
      setDescriptionHandled(true);
      const candidates = flattenCandidates(result.data);
      const count = candidates.length;
      setCandidateOriginalAnswers(
        captureOriginalValues(
          candidates.map((candidate) => candidate.key),
          baselineAnswers,
        ),
      );
      if (count > 0) {
        setExtractionNotice(
          `发现 ${count} 项待确认候选；系统不会自动改写回答，请逐项采用或忽略。`,
        );
      } else if (result.data.model.degradedReason) {
        setExtractionNotice(
          "AI 提取当前不可用，已安全降级。原有手工回答不受影响，可继续运行固定规则。",
        );
      } else {
        setExtractionNotice(
          "没有提取到明确候选。原有手工回答不受影响，可继续运行固定规则。",
        );
      }
    } catch (extractError) {
      setDescriptionHandled(false);
      setExtraction(null);
      setCandidateOriginalAnswers({});
      setExtractionNotice(
        extractError instanceof Error
          ? `AI 提取失败：${extractError.message}`
          : "AI 提取失败，请重试或明确跳过这段描述。",
      );
    } finally {
      setExtracting(false);
    }
  };

  const skipFreeText = () => {
    setAnswers((current) =>
      restoreAcceptedValues(
        current,
        extractedCandidates.map((candidate) => candidate.key),
        candidateDecisions,
        candidateOriginalAnswers,
      ) as AnswerMap,
    );
    setDescriptionHandled(true);
    setExtraction(null);
    setCandidateDecisions({});
    setCandidateOriginalAnswers({});
    setExtractionNotice(
      "已选择不使用这段描述。固定规则只读取你逐项确认的结构化回答。",
    );
  };

  const acceptCandidate = (candidate: CandidateEntry) => {
    setAnswers((current) => ({
      ...current,
      [candidate.key]: candidate.value,
    }));
    setCandidateDecisions((current) => ({
      ...current,
      [candidate.key]: "accepted",
    }));
  };

  const ignoreCandidate = (candidate: CandidateEntry) => {
    setAnswers((current) => {
      const restored = { ...current };
      const original = candidateOriginalAnswers[candidate.key];
      if (original === undefined) {
        delete restored[candidate.key];
      } else {
        restored[candidate.key] = original;
      }
      return restored;
    });
    setCandidateDecisions((current) => ({
      ...current,
      [candidate.key]: "ignored",
    }));
  };

  const loadExplanation = async (payload: ReturnType<typeof toPayload>) => {
    setExplanation(null);
    setExplanationStatus("loading");
    try {
      const response = await fetch("/api/v1/agent/explain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as
        | {
            ok: true;
            data: {
              explanation: ExplanationData | null;
              model: { used: boolean; degradedReason?: string };
            };
          }
        | { ok: false; error: { code: string; message: string } };
      if (!response.ok || !result.ok) {
        throw new Error(result.ok ? "解释服务响应异常" : result.error.message);
      }

      if (!result.data.explanation) {
        throw new Error("当前结果不适用 AI 解释");
      }

      setExplanation(result.data.explanation);
      setExplanationStatus(
        result.data.model.used ? "ready" : "degraded",
      );
    } catch {
      setExplanation({
        summary: "AI 解释暂时不可用，固定规则结果仍然有效。",
        disclaimer: "请勿把内部测试结果当作诊断或治疗建议。",
      });
      setExplanationStatus("error");
    }
  };

  const submitAssessment = async () => {
    const payload = toPayload(answers);
    setView("submitting");
    setError("");
    setExplanation(null);
    setExplanationStatus("idle");
    try {
      const response = await fetch("/api/v1/agent/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as
        | { ok: true; data: { assessment: Assessment } }
        | { ok: false; error: { code: string; message: string } };
      if (!response.ok || !result.ok) {
        throw new Error(
          result.ok ? "服务响应异常" : result.error.message,
        );
      }
      setAssessment(result.data.assessment);
      setView("result");
      if (result.data.assessment.status === "classified") {
        void loadExplanation(payload);
      }
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "服务暂时不可用，请稍后重试。",
      );
      setView("review");
    }
  };

  const restart = () => {
    setView("consent");
    setConsented(false);
    setAgeGroup("");
    setGuardianConfirmed(false);
    setQuestionIndex(0);
    setAnswers({});
    setFreeText("");
    setExtracting(false);
    setDescriptionHandled(false);
    setExtraction(null);
    setCandidateDecisions({});
    setCandidateOriginalAnswers({});
    setExtractionNotice("");
    setAssessment(null);
    setExplanation(null);
    setExplanationStatus("idle");
    setError("");
  };

  const copy = assessment ? resultCopy(assessment) : null;

  return (
    <main className="agent-shell">
      <header className="agent-header">
        <div className="brand-mark" aria-hidden="true">
          岐
        </div>
        <div>
          <strong>抗敏先锋 · 小岐</strong>
          <span>AI 鼻健康管理内部测试</span>
        </div>
        {view !== "consent" && (
          <button className="text-button" type="button" onClick={restart}>
            重新开始
          </button>
        )}
      </header>

      <aside className="prototype-notice" role="status">
        <strong>待临床确认，仅供内部测试</strong>
        <span>
          固定规则先行，模型不决定证型；结果不能替代门诊诊断。
        </span>
      </aside>

      {view === "consent" && (
        <section className="screen consent-screen" aria-labelledby="consent-title">
          <span className="step-label">开始前确认</span>
          <h1 id="consent-title">先确认使用边界</h1>
          <p className="lead">
            本轮仅验证问诊流程和固定规则。不会保存健康数据，也不会提供未经审核的知识、趋势或调理方案。
          </p>

          <label className="consent-row">
            <input
              type="checkbox"
              checked={consented}
              onChange={(event) => setConsented(event.target.checked)}
            />
            <span>我已阅读并同意按内部测试边界使用</span>
          </label>

          <fieldset className="choice-fieldset">
            <legend>使用者年龄</legend>
            <div className="segmented">
              <button
                className={ageGroup === "adult" ? "selected" : ""}
                type="button"
                onClick={() => {
                  setAgeGroup("adult");
                  setGuardianConfirmed(false);
                }}
              >
                18 岁及以上
              </button>
              <button
                className={ageGroup === "minor" ? "selected" : ""}
                type="button"
                onClick={() => setAgeGroup("minor")}
              >
                未满 18 岁
              </button>
            </div>
          </fieldset>

          {ageGroup === "minor" && (
            <label className="consent-row guardian-row">
              <input
                type="checkbox"
                checked={guardianConfirmed}
                onChange={(event) =>
                  setGuardianConfirmed(event.target.checked)
                }
              />
              <span>监护人已知情并陪同完成本次内部测试</span>
            </label>
          )}

          <button
            className="primary-button"
            type="button"
            disabled={!canStart}
            onClick={begin}
          >
            开始安全问诊
          </button>
          <p className="emergency-note">
            如已出现呼吸困难、意识异常或大量出血，请立即就医，不要等待本工具结果。
          </p>
        </section>
      )}

      {view === "questions" && currentQuestion && (
        <section className="screen question-screen" aria-labelledby="question-title">
          <div className="progress-copy">
            <span>{currentQuestion.section}</span>
            <b>
              {questionIndex + 1} / {questions.length}
            </b>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={questions.length}
            aria-valuenow={questionIndex + 1}
          >
            <span
              style={{
                width: `${((questionIndex + 1) / questions.length) * 100}%`,
              }}
            />
          </div>
          <h1 id="question-title">{currentQuestion.title}</h1>
          {currentQuestion.help && <p className="lead">{currentQuestion.help}</p>}

          <div className="answer-grid" aria-label="回答选项">
            {answerLabels.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => answerQuestion(item.value)}
              >
                <span>{item.label}</span>
                <small>
                  {item.value === "unknown"
                    ? "需要后续确认"
                    : "按当前实际情况选择"}
                </small>
              </button>
            ))}
          </div>

          <button
            className="back-button"
            type="button"
            disabled={questionIndex === 0}
            onClick={() =>
              setQuestionIndex((index) => Math.max(0, index - 1))
            }
          >
            返回上一题
          </button>
        </section>
      )}

      {(view === "review" || view === "submitting") && (
        <section className="screen review-screen" aria-labelledby="review-title">
          <span className="step-label">提交前确认 · 已回答 {progress}%</span>
          <h1 id="review-title">确认信息后运行固定规则</h1>
          <p className="lead">
            自由描述可交给 AI 提取为待确认候选，但不会自动改写答案，也不会直接参与规则判断。
          </p>

          <label className="free-text">
            <span>补充描述（选填）</span>
            <textarea
              maxLength={1000}
              value={freeText}
              onChange={(event) => {
                setAnswers((current) =>
                  restoreAcceptedValues(
                    current,
                    extractedCandidates.map((candidate) => candidate.key),
                    candidateDecisions,
                    candidateOriginalAnswers,
                  ) as AnswerMap,
                );
                setFreeText(event.target.value);
                setDescriptionHandled(event.target.value.trim().length === 0);
                setExtraction(null);
                setCandidateDecisions({});
                setCandidateOriginalAnswers({});
                setExtractionNotice("");
              }}
              placeholder="例如：什么时候开始、什么情况下更明显……"
            />
            <small>
              {freeText.length} / 1000 · 仅用于本次候选提取，不保存
            </small>
          </label>

          {freeText.trim() && (
            <div className="extraction-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={extracting || view === "submitting"}
                onClick={extractFreeText}
              >
                {extracting ? "正在提取候选…" : "提取待确认候选"}
              </button>
              <button
                className="text-button"
                type="button"
                disabled={extracting || view === "submitting"}
                onClick={skipFreeText}
              >
                不使用这段描述
              </button>
            </div>
          )}

          {extractionNotice && (
            <div
              className={`extraction-notice ${
                extraction?.safetyGate.status === "confirmation_required"
                  ? "danger"
                  : ""
              }`}
              role="status"
            >
              <strong>
                {extraction?.safetyGate.status === "confirmation_required"
                  ? "文字中可能含高危信号"
                  : "AI 候选提取状态"}
              </strong>
              <span>{extractionNotice}</span>
            </div>
          )}

          {extractedCandidates.length > 0 && (
            <section
              className="candidate-panel"
              aria-labelledby="candidate-title"
            >
              <h2 id="candidate-title">逐项确认 AI 候选</h2>
              <p>每项都必须明确采用或忽略；AI 不能替你决定。</p>
              <ul>
                {extractedCandidates.map((candidate) => {
                  const decision = candidateDecisions[candidate.key];
                  const label =
                    answerLabels.find(
                      (answer) => answer.value === candidate.value,
                    )?.label ?? candidate.value;
                  const currentLabel =
                    answerLabels.find(
                      (answer) => answer.value === answers[candidate.key],
                    )?.label ?? "未答";
                  return (
                    <li key={candidate.key}>
                      <div>
                        <strong>{fieldLabels[candidate.key]}</strong>
                        <span>
                          当前：{currentLabel} · 候选：{label}
                        </span>
                      </div>
                      <div className="candidate-actions">
                        <button
                          className={
                            decision === "accepted" ? "selected" : ""
                          }
                          type="button"
                          onClick={() => acceptCandidate(candidate)}
                        >
                          {decision === "accepted" ? "已采用" : "采用候选"}
                        </button>
                        <button
                          className={
                            decision === "ignored" ? "selected" : ""
                          }
                          type="button"
                          onClick={() => ignoreCandidate(candidate)}
                        >
                          {decision === "ignored" ? "已忽略" : "忽略"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <details className="answer-summary">
            <summary>查看并修改 15 项回答</summary>
            <ol>
              {summary.map((item, index) => (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setQuestionIndex(index);
                      setView("questions");
                    }}
                  >
                    <span>{item.title}</span>
                    <b>
                      {answerLabels.find((answer) => answer.value === item.answer)
                        ?.label ?? "未答"}
                    </b>
                  </button>
                </li>
              ))}
            </ol>
          </details>

          {error && (
            <div className="api-error" role="alert">
              <strong>提交失败</strong>
              <span>{error}</span>
              <small>回答仍保留在本页，可直接重试。</small>
            </div>
          )}

          <button
            className="primary-button"
            type="button"
            disabled={view === "submitting" || extracting || !descriptionReady}
            onClick={submitAssessment}
          >
            {view === "submitting" ? "正在运行规则…" : "确认并查看结果"}
          </button>
          {!descriptionReady && (
            <p className="review-hint">
              请先提取并处理全部候选，或明确选择“不使用这段描述”。
            </p>
          )}
        </section>
      )}

      {view === "result" && assessment && copy && (
        <section className="screen result-screen" aria-labelledby="result-title">
          <span className="step-label">规则包 {assessment.rulePackageVersion}</span>
          <article className={`result-card ${copy.tone}`}>
            <span>{copy.eyebrow}</span>
            <h1 id="result-title">{copy.title}</h1>
            <p>{copy.body}</p>
            <small>{copy.detail}</small>
          </article>

          {assessment.status === "classified" && (
            <article
              className={`explanation-card ${explanationStatus}`}
              aria-live="polite"
            >
              <strong>AI 解释（不改变规则结果）</strong>
              {explanationStatus === "loading" && (
                <p>固定规则结果已先展示，正在获取安全解释…</p>
              )}
              {explanation && (
                <>
                  <p>{explanation.summary}</p>
                  <small>{explanation.disclaimer}</small>
                </>
              )}
              {(explanationStatus === "degraded" ||
                explanationStatus === "error") && (
                <span>
                  已使用固定降级文案；没有生成诊断或调理方案。
                </span>
              )}
            </article>
          )}

          {assessment.status === "classified" && (
            <article className="empty-plan">
              <strong>暂无经审核的适用方案</strong>
              <p>
                no_approved_plan：客户方案、知识内容与操作素材未通过发布门禁，因此不展示。
              </p>
            </article>
          )}

          <div className="result-actions">
            {(assessment.status === "need_more_information" ||
              assessment.status === "conflict" ||
              assessment.status === "no_match") && (
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  const nextField =
                    assessment.status === "need_more_information"
                      ? assessment.nextQuestions[0]
                      : undefined;
                  const nextIndex = questions.findIndex(
                    (question) => question.key === nextField,
                  );
                  setQuestionIndex(nextIndex >= 0 ? nextIndex : 0);
                  setView("questions");
                }}
              >
                返回核对回答
              </button>
            )}
            <button className="secondary-button" type="button" onClick={restart}>
              清空并重新开始
            </button>
          </div>

          <p className="final-disclaimer">
            结果仅供内部流程测试，不能替代医生诊断或个体化治疗建议。
          </p>
        </section>
      )}
    </main>
  );
}
