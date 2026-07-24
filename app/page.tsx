"use client";

import {
  captureOriginalValues,
  restoreAcceptedValues,
  type CandidateDecision,
} from "@/lib/agent/candidate-state";
import {
  FIRST_QUESTION_KEY,
  createAssessmentPayload,
  findNextQuestion,
  type AnswerMap,
  type QuestionKey,
  type TriState,
} from "@/lib/agent/conversation";
import { useMemo, useRef, useState } from "react";

type View = "home" | "learn" | "questions" | "review" | "submitting" | "result";

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
      nextQuestions?: string[];
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

const FIRST_QUESTION_INDEX = questions.findIndex(
  (question) => question.key === FIRST_QUESTION_KEY,
);

function MiniProgramHome({
  onLearn,
  onStart,
}: {
  onLearn: () => void;
  onStart: () => void;
}) {
  const [notice, setNotice] = useState("");

  const showPending = (feature: string) => {
    setNotice(`${feature}将在内容与数据通过审核后开放。`);
  };

  return (
    <main className="mini-program-shell">
      <section className="mini-program" aria-label="抗敏先锋小程序首页">
        <header className="mini-header">
          <button type="button" aria-label="返回" disabled>
            ‹
          </button>
          <strong>抗敏先锋</strong>
          <button className="mini-menu" type="button" aria-label="更多">
            ••• <i />
          </button>
        </header>

        <div className="mini-body">
          <div className="mini-brand-banner">
            {/* vinext does not provide Next image optimization in this worker. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand-banner.jpg" alt="抗敏先锋" />
          </div>

          <section className="home-modules" aria-label="鼻健康服务">
            <button className="diagnose-module" type="button" onClick={onStart}>
              <span className="module-icon">诊</span>
              <small>固定规则安全问诊</small>
              <strong>诊一诊</strong>
              <p>和小岐逐项确认症状，先完成高危筛查。</p>
              <b>
                开始了解 <i>→</i>
              </b>
            </button>
            <button className="learn-module" type="button" onClick={onLearn}>
              <span className="module-icon">学</span>
              <small>审核中的鼻健康内容</small>
              <strong>学一学</strong>
              <p>了解内容边界与日常记录方法。</p>
              <b>
                去学习 <i>→</i>
              </b>
            </button>
          </section>

          <aside className="mini-boundary">
            <span aria-hidden="true">据</span>
            <div>
              <strong>固定规则优先，内容审核后开放</strong>
              <p>本工具仅供内部测试，高危情况先提示就医，结果不能替代门诊诊断。</p>
            </div>
          </aside>

          <section className="mini-feature-grid" aria-label="常用功能">
            <button type="button" onClick={onStart}>
              <span className="mini-feature-icon">评</span>
              <small>今日待完成</small>
              <strong>症状评估</strong>
              <i>逐项确认实际情况</i>
            </button>
            <button type="button" onClick={onLearn}>
              <span className="mini-feature-icon">知</span>
              <small>内容审核中</small>
              <strong>换季为何反复？</strong>
              <i>查看科普边界</i>
            </button>
          </section>

          <section className="mini-status-card">
            <div>
              <small>健康记录</small>
              <h2>尚无可展示趋势</h2>
              <p>完成正式数据能力与授权后开放。</p>
            </div>
            <button type="button" onClick={() => showPending("健康记录")}>
              了解进度 ›
            </button>
          </section>

          <div className="mini-section-heading">
            <div>
              <small>为你推荐</small>
              <h2>今天读点什么</h2>
            </div>
            <button type="button" onClick={onLearn}>
              查看 ›
            </button>
          </div>

          <button
            className="mini-article-card"
            type="button"
            onClick={onLearn}
          >
            <span aria-hidden="true">知</span>
            <div>
              <small>内容审核中</small>
              <strong>换季鼻敏感，先从记录与防护开始</strong>
              <p>审核通过后再向用户展示，不由模型自由生成。</p>
            </div>
          </button>

          {notice && (
            <p className="mini-pending-notice" role="status">
              {notice}
            </p>
          )}
        </div>

        <nav className="mini-bottom-nav" aria-label="小程序主要功能">
          <button className="active" type="button">
            <span>⌂</span>首页
          </button>
          <button type="button" onClick={onStart}>
            <span>◌</span>问助手
          </button>
          <button className="mini-add" type="button" onClick={onStart}>
            <span>＋</span>
          </button>
          <button type="button" onClick={() => showPending("健康日历")}>
            <span>▦</span>日历
          </button>
          <button type="button" onClick={onLearn}>
            <span>□</span>科普
          </button>
        </nav>
      </section>
    </main>
  );
}

function LearningPage({
  onBack,
  onStart,
}: {
  onBack: () => void;
  onStart: () => void;
}) {
  return (
    <main className="mini-program-shell">
      <section className="mini-program" aria-label="鼻健康科普">
        <header className="mini-header">
          <button type="button" aria-label="返回首页" onClick={onBack}>
            ‹
          </button>
          <strong>学一学</strong>
          <button className="mini-menu" type="button" aria-label="更多">
            ••• <i />
          </button>
        </header>

        <div className="mini-body learning-body">
          <section className="learning-hero">
            <small>鼻健康科普</small>
            <h1>先了解，再决定怎么做</h1>
            <p>这里仅展示安全边界明确的基础内容，未经审核的调理方案不会开放。</p>
          </section>

          <aside className="mini-boundary">
            <span aria-hidden="true">安</span>
            <div>
              <strong>内容仍在审核</strong>
              <p>当前内容用于内部测试，不替代医生建议，也不提供个性化治疗方案。</p>
            </div>
          </aside>

          <section className="learning-list" aria-label="鼻健康学习内容">
            <article>
              <span>防</span>
              <div>
                <small>日常防护</small>
                <h2>换季鼻敏感，先从记录诱因开始</h2>
                <p>记录出现时间、环境变化和对睡眠的影响，就诊时更容易说明情况。</p>
              </div>
            </article>
            <article>
              <span>诊</span>
              <div>
                <small>安全提醒</small>
                <h2>出现哪些情况应及时就医？</h2>
                <p>呼吸困难、大量出血、持续高热或严重神经症状，应停止自助评估。</p>
              </div>
            </article>
            <article>
              <span>记</span>
              <div>
                <small>症状记录</small>
                <h2>每天记录哪些信息更有用？</h2>
                <p>如实记录鼻塞、喷嚏、流涕、鼻痒，以及是否影响睡眠和日常活动。</p>
              </div>
            </article>
          </section>

          <button className="learning-start" type="button" onClick={onStart}>
            进入“诊一诊”完成安全问诊
          </button>
        </div>

        <nav className="mini-bottom-nav" aria-label="小程序主要功能">
          <button type="button" onClick={onBack}>
            <span>⌂</span>首页
          </button>
          <button type="button" onClick={onStart}>
            <span>◌</span>问助手
          </button>
          <button className="mini-add" type="button" onClick={onStart}>
            <span>＋</span>
          </button>
          <button type="button" onClick={onBack}>
            <span>▦</span>日历
          </button>
          <button className="active" type="button">
            <span>□</span>科普
          </button>
        </nav>
      </section>
    </main>
  );
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

function resultCopy(assessment: Assessment, answers: AnswerMap) {
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
      const unansweredQuestions = assessment.nextQuestions.filter(
        (field) => answers[field as QuestionKey] === undefined,
      );
      return {
        tone: "warning",
        eyebrow: "信息不足",
        title: "需要补充或确认回答",
        body: "“不确定”不会被系统当作“否”。请返回问卷确认相关问题，或咨询专业人员。",
        detail:
          unansweredQuestions.length > 0
            ? `待确认：${unansweredQuestions
                .map((field) => fieldLabels[field as QuestionKey] ?? field)
                .join("；")}`
            : "相关问题均已明确选择“不确定”，本轮无法继续分类。",
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
  const [view, setView] = useState<View>("home");
  const [questionIndex, setQuestionIndex] = useState(FIRST_QUESTION_INDEX);
  const [questionHistory, setQuestionHistory] = useState<number[]>([]);
  const [navigating, setNavigating] = useState(false);
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
  const flowVersionRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);
  const navigationLockRef = useRef(false);

  const invalidatePendingRequests = () => {
    flowVersionRef.current += 1;
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    navigationLockRef.current = false;
    setNavigating(false);
    setExtracting(false);
  };

  const startRequest = () => {
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    return controller;
  };

  const finishRequest = (controller: AbortController) => {
    if (activeRequestRef.current === controller) {
      activeRequestRef.current = null;
    }
  };

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

  const requestAssessment = async (
    nextAnswers: AnswerMap,
    signal: AbortSignal,
  ) => {
    const response = await fetch("/api/v1/agent/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createAssessmentPayload(nextAnswers)),
      signal,
    });
    const result = (await response.json()) as
      | { ok: true; data: { assessment: Assessment } }
      | { ok: false; error: { code: string; message: string } };
    if (!response.ok || !result.ok) {
      throw new Error(
        result.ok ? "服务响应异常" : result.error.message,
      );
    }
    return result.data.assessment;
  };

  const answerQuestion = async (value: TriState) => {
    if (navigationLockRef.current) return;

    navigationLockRef.current = true;
    const requestVersion = flowVersionRef.current;
    const controller = startRequest();
    const timeoutId = window.setTimeout(() => controller.abort(), 10_000);
    const nextAnswers = { ...answers, [currentQuestion.key]: value };
    setAnswers(nextAnswers);
    setNavigating(true);
    setError("");
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

    try {
      const nextAssessment = await requestAssessment(
        nextAnswers,
        controller.signal,
      );
      if (flowVersionRef.current !== requestVersion) return;

      const nextQuestion = findNextQuestion(nextAssessment, nextAnswers);
      if (nextQuestion) {
        const nextIndex = questions.findIndex(
          (question) => question.key === nextQuestion,
        );
        if (nextIndex >= 0) {
          setQuestionHistory((history) => [...history, questionIndex]);
          setQuestionIndex(nextIndex);
          return;
        }
      }

      if (
        nextAssessment.status === "blocked" ||
        nextAssessment.status === "referred" ||
        nextAssessment.status === "need_more_information"
      ) {
        setAssessment(nextAssessment);
        setExplanation(null);
        setExplanationStatus("idle");
        setView("result");
        return;
      }

      setAssessment(null);
      setView("review");
    } catch (navigationError) {
      if (flowVersionRef.current !== requestVersion) return;
      setError(
        navigationError instanceof DOMException &&
          navigationError.name === "AbortError"
          ? "规则服务响应超时，请重试当前回答。"
          : navigationError instanceof Error
          ? navigationError.message
          : "暂时无法决定下一步，请重试当前回答。",
      );
    } finally {
      window.clearTimeout(timeoutId);
      finishRequest(controller);
      if (flowVersionRef.current === requestVersion) {
        navigationLockRef.current = false;
        setNavigating(false);
      }
    }
  };

  const extractFreeText = async () => {
    const text = freeText.trim();
    if (!text) return;

    const requestVersion = flowVersionRef.current;
    const controller = startRequest();
    const timeoutId = window.setTimeout(() => controller.abort(), 10_000);
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
        signal: controller.signal,
      });
      const result = (await response.json()) as
        | { ok: true; data: ExtractionData }
        | { ok: false; error: { code: string; message: string } };
      if (!response.ok || !result.ok) {
        throw new Error(result.ok ? "提取服务响应异常" : result.error.message);
      }
      if (flowVersionRef.current !== requestVersion) return;

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
      if (flowVersionRef.current !== requestVersion) return;
      setDescriptionHandled(false);
      setExtraction(null);
      setCandidateDecisions({});
      setCandidateOriginalAnswers({});
      setExtractionNotice(
        extractError instanceof DOMException &&
          extractError.name === "AbortError"
          ? "AI 提取响应超时，请重试或明确跳过这段描述。"
          : extractError instanceof Error
          ? `AI 提取失败：${extractError.message}`
          : "AI 提取失败，请重试或明确跳过这段描述。",
      );
    } finally {
      window.clearTimeout(timeoutId);
      finishRequest(controller);
      if (flowVersionRef.current === requestVersion) {
        setExtracting(false);
      }
    }
  };

  const skipFreeText = () => {
    invalidatePendingRequests();
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

  const loadExplanation = async (
    payload: ReturnType<typeof createAssessmentPayload>,
    requestVersion: number,
  ) => {
    if (flowVersionRef.current !== requestVersion) return;

    const controller = startRequest();
    const timeoutId = window.setTimeout(() => controller.abort(), 10_000);
    setExplanation(null);
    setExplanationStatus("loading");
    try {
      const response = await fetch("/api/v1/agent/explain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
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
      if (flowVersionRef.current !== requestVersion) return;

      if (!result.data.explanation) {
        throw new Error("当前结果不适用 AI 解释");
      }

      setExplanation(result.data.explanation);
      setExplanationStatus(
        result.data.model.used ? "ready" : "degraded",
      );
    } catch {
      if (flowVersionRef.current !== requestVersion) return;
      setExplanation({
        summary: "AI 解释暂时不可用，固定规则结果仍然有效。",
        disclaimer: "请勿把内部测试结果当作诊断或治疗建议。",
      });
      setExplanationStatus("error");
    } finally {
      window.clearTimeout(timeoutId);
      finishRequest(controller);
    }
  };

  const submitAssessment = async () => {
    const requestVersion = flowVersionRef.current;
    const controller = startRequest();
    const timeoutId = window.setTimeout(() => controller.abort(), 10_000);
    const payload = createAssessmentPayload(answers);
    setView("submitting");
    setError("");
    setExplanation(null);
    setExplanationStatus("idle");
    try {
      const nextAssessment = await requestAssessment(
        answers,
        controller.signal,
      );
      if (flowVersionRef.current !== requestVersion) return;

      setAssessment(nextAssessment);
      setView("result");
      if (nextAssessment.status === "classified") {
        void loadExplanation(payload, requestVersion);
      }
    } catch (submitError) {
      if (flowVersionRef.current !== requestVersion) return;
      setError(
        submitError instanceof DOMException &&
          submitError.name === "AbortError"
          ? "规则服务响应超时，请稍后重试。"
          : submitError instanceof Error
          ? submitError.message
          : "服务暂时不可用，请稍后重试。",
      );
      setView("review");
    } finally {
      window.clearTimeout(timeoutId);
      finishRequest(controller);
    }
  };

  const resetFlow = (nextView: "home" | "questions") => {
    invalidatePendingRequests();
    setView(nextView);
    setQuestionIndex(FIRST_QUESTION_INDEX);
    setQuestionHistory([]);
    setNavigating(false);
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

  const restart = () => resetFlow("home");
  const startAssessment = () => resetFlow("questions");
  const openLearning = () => setView("learn");

  const copy = assessment ? resultCopy(assessment, answers) : null;

  if (view === "home") {
    return (
      <MiniProgramHome onLearn={openLearning} onStart={startAssessment} />
    );
  }

  if (view === "learn") {
    return <LearningPage onBack={restart} onStart={startAssessment} />;
  }

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
        <button className="text-button" type="button" onClick={restart}>
          返回首页
        </button>
      </header>

      <aside className="prototype-notice" role="status">
        <strong>待临床确认，仅供内部测试</strong>
        <span>
          固定规则先行，模型不决定证型；结果不能替代门诊诊断。
        </span>
      </aside>

      {view === "questions" && currentQuestion && (
        <section className="screen question-screen" aria-labelledby="question-title">
          <div className="progress-copy">
            <span>{currentQuestion.section}</span>
            <b>已确认 {answeredCount} 项</b>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={questions.length}
            aria-valuenow={answeredCount}
          >
            <span
              style={{
                width: `${progress}%`,
              }}
            />
          </div>
          <h1 id="question-title">{currentQuestion.title}</h1>
          {currentQuestion.help && <p className="lead">{currentQuestion.help}</p>}

          <div className="answer-grid" aria-label="回答选项">
            {answerLabels.map((item) => (
              <button
                key={item.value}
                className={
                  answers[currentQuestion.key] === item.value ? "selected" : ""
                }
                type="button"
                disabled={navigating}
                onClick={() => void answerQuestion(item.value)}
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

          {navigating && (
            <p className="navigation-status" role="status">
              正在由服务端固定规则确定下一步…
            </p>
          )}

          {error && (
            <div className="api-error" role="alert">
              <strong>暂时无法继续</strong>
              <span>{error}</span>
              <small>当前回答已保留，请重新选择一次以重试。</small>
            </div>
          )}

          <button
            className="back-button"
            type="button"
            disabled={questionHistory.length === 0 || navigating}
            onClick={() => {
              const previousIndex =
                questionHistory[questionHistory.length - 1];
              if (previousIndex === undefined) return;
              setQuestionHistory((history) => history.slice(0, -1));
              setQuestionIndex(previousIndex);
              setError("");
            }}
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
              disabled={view === "submitting"}
              value={freeText}
              onChange={(event) => {
                invalidatePendingRequests();
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
                      invalidatePendingRequests();
                      setQuestionIndex(index);
                      setQuestionHistory([]);
                      setAssessment(null);
                      setExplanation(null);
                      setExplanationStatus("idle");
                      setError("");
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
              assessment.status === "no_match" ||
              assessment.status === "classified" ||
              assessment.status === "referred") && (
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  invalidatePendingRequests();
                  setAssessment(null);
                  setExplanation(null);
                  setExplanationStatus("idle");
                  setError("");
                  setView("review");
                }}
              >
                返回查看并修改回答
              </button>
            )}
            <button className="secondary-button" type="button" onClick={restart}>
              返回小程序首页
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
