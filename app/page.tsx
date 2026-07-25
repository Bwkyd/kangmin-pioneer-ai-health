"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import {
  AllergenExposure,
  AllergenExposureDraft,
  allergenGroups,
  deleteAllergenExposure,
  emptyHealthProfile,
  getHealthProfile,
  HealthProfile,
  HealthProfileDraft,
  listAllergenExposures,
  localDateValue,
  OTHER_ALLERGEN,
  saveAllergenExposure,
  saveHealthProfile,
  toggleAllergen,
  upsertExposure,
  validateExposureDraft,
} from "./health-records";

type Tab =
  | "home"
  | "chat"
  | "assessment"
  | "articles"
  | "profile"
  | "healthProfile"
  | "allergenRecord";
type Message =
  | { id: number; role: "ai" | "user"; kind: "text"; text: string }
  | { id: number; role: "ai"; kind: "thinking" }
  | { id: number; role: "ai"; kind: "source"; title: string; detail: string };

const symptomOptions = [
  "鼻塞、打喷嚏、流清鼻涕",
  "晚上鼻塞，睡眠受影响",
  "鼻涕黄稠，还有咽部不适",
];

const durationOptions = ["最近 3 天出现", "反复半年，换季加重", "已经持续两年以上"];
const warningOptions = ["以上情况都没有", "有高热或明显头痛", "呼吸不畅或胸闷"];

const knowledgeQuestions = [
  {
    question: "为什么换季容易反复？",
    answer:
      "换季时温度、湿度和空气中的过敏原可能发生变化，鼻部也可能更容易受到刺激。可以记录症状出现时间、诱因和严重程度，供就医时参考。",
    source: "内部演示内容 · 待医学审核",
  },
  {
    question: "鼻塞在家先怎么护理？",
    answer:
      "可以先减少冷空气和刺激物暴露，并记录鼻塞对睡眠的影响。若症状持续、加重或伴随高危信号，请及时咨询正规医疗机构。",
    source: "内部演示内容 · 待医学审核",
  },
  {
    question: "调理效果多久记录一次？",
    answer:
      "可以在固定时间做简短记录，关注喷嚏、流涕、鼻塞和鼻痒等变化。当前页面中的记录与趋势均为交互演示。",
    source: "内部演示内容 · 待医学审核",
  },
];

const articles = [
  {
    tag: "日常防护",
    title: "换季鼻敏感，先做好这 4 件小事",
    summary: "从温差、卧室环境到外出防护，用简单方法减少鼻部刺激。",
    read: "3 分钟",
    tone: "mint",
  },
  {
    tag: "安全提醒",
    title: "鼻塞时，哪些情况需要及时就医？",
    summary: "高热、剧烈头痛、呼吸困难等信号，不适合只靠居家调理。",
    read: "2 分钟",
    tone: "amber",
  },
  {
    tag: "亲子健康",
    title: "孩子总揉鼻子，家长该记录什么？",
    summary: "记下时间、诱因和睡眠影响，比只说“最近鼻炎犯了”更有用。",
    read: "4 分钟",
    tone: "blue",
  },
];

const scaleItems = ["喷嚏", "流涕", "鼻塞", "鼻痒"];
const symptomDates: Record<string, string> = {
  "2026-07-14": "轻度",
  "2026-07-15": "轻度",
  "2026-07-17": "中度",
  "2026-07-19": "轻度",
};
const calendarDays = [
  { day: 29, muted: true }, { day: 30, muted: true }, { day: 1 }, { day: 2 }, { day: 3 }, { day: 4 }, { day: 5 },
  { day: 6 }, { day: 7 }, { day: 8 }, { day: 9 }, { day: 10 }, { day: 11 }, { day: 12 },
  { day: 13 }, { day: 14, level: "mild" }, { day: 15, level: "mild" }, { day: 16 }, { day: 17, level: "moderate" }, { day: 18 }, { day: 19, level: "mild" },
  { day: 20, today: true }, { day: 21 }, { day: 22 }, { day: 23 }, { day: 24 }, { day: 25 }, { day: 26 },
  { day: 27 }, { day: 28 }, { day: 29 }, { day: 30 }, { day: 31 }, { day: 1, muted: true }, { day: 2, muted: true },
];

function calendarDateValue(day: number, index: number): string {
  const month = index < 2 ? "06" : index > 32 ? "08" : "07";
  return `2026-${month}-${String(day).padStart(2, "0")}`;
}

function displayDate(value: string): string {
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return `${year}年${Number(month)}月${Number(day)}日`;
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("home");
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 1,
      role: "ai",
      kind: "text",
      text: "你好，我是小岐。这是内部交互演示，你可以体验描述症状和查看鼻健康内容；当前不会输出诊断、证型或个性化治疗方案。",
    },
  ]);
  const [step, setStep] = useState(0);
  const [input, setInput] = useState("");
  const [videoOpen, setVideoOpen] = useState(false);
  const [articleOpen, setArticleOpen] = useState<number | null>(null);
  const [scores, setScores] = useState([2, 2, 2, 1]);
  const [assessmentDone, setAssessmentDone] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [calendarMode, setCalendarMode] = useState<"calendar" | "list">("calendar");
  const [selectedDate, setSelectedDate] = useState(localDateValue);
  const [allergenReturnTab, setAllergenReturnTab] = useState<"assessment" | "healthProfile">("assessment");
  const [healthProfile, setHealthProfile] = useState<HealthProfile | null>(null);
  const [profileDraft, setProfileDraft] = useState<HealthProfileDraft>(emptyHealthProfile);
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileStatus, setProfileStatus] = useState<"idle" | "loading" | "saving" | "ready" | "error">("idle");
  const [profileNotice, setProfileNotice] = useState("");
  const [exposures, setExposures] = useState<AllergenExposure[]>([]);
  const [exposureDraft, setExposureDraft] = useState<AllergenExposureDraft>({
    date: localDateValue(),
    factors: [],
    otherDescription: "",
  });
  const [editingExposureId, setEditingExposureId] = useState<string | null>(null);
  const [exposureStatus, setExposureStatus] = useState<"idle" | "loading" | "saving" | "ready" | "error">("idle");
  const [exposureNotice, setExposureNotice] = useState("");
  const chatEnd = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLCanvasElement>(null);

  const totalScore = scores.reduce((sum, score) => sum + score, 0);
  const exposureValidation = validateExposureDraft(exposureDraft);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, step]);

  useEffect(() => {
    const canvas = chartRef.current;
    if (!canvas || tab !== "assessment") return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);

    const values = assessmentDone ? [1, 1, 2, 1, 2, 2, 1, Math.min(3, Math.ceil(totalScore / 4))] : [1, 1, 2, 1, 2, 2, 1];
    const days = assessmentDone ? [14, 15, 17, 19, 22, 23, 25, 20] : [14, 15, 17, 19, 22, 23, 25];
    const pad = { left: 42, right: 15, top: 15, bottom: 27 };
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;

    context.font = '9px "PingFang SC", sans-serif';
    context.textAlign = "right";
    context.strokeStyle = "#dce8e2";
    context.lineWidth = 1;
    ["良好", "轻度", "中度", "重度"].forEach((label, level) => {
      const y = pad.top + chartH - (level / 3) * chartH;
      context.beginPath();
      context.moveTo(pad.left, y);
      context.lineTo(width - pad.right, y);
      context.stroke();
      context.fillStyle = "#87968f";
      context.fillText(label, pad.left - 7, y + 3);
    });

    const points = values.map((value, index) => ({
      x: pad.left + ((days[index] - 1) / 30) * chartW,
      y: pad.top + chartH - (value / 3) * chartH,
    }));
    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.strokeStyle = "#1E5AA3";
    context.lineWidth = 3;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.stroke();

    points.forEach((point, index) => {
      context.beginPath();
      context.arc(point.x, point.y, index === 4 ? 5 : 3.5, 0, Math.PI * 2);
      context.fillStyle = index === 4 ? "#E2A33A" : "#1E5AA3";
      context.fill();
    });
    context.font = '9px "PingFang SC", sans-serif';
    context.fillStyle = "#87968f";
    context.textAlign = "center";
    [1, 10, 20, 31].forEach((day) => {
      const x = pad.left + ((day - 1) / 30) * chartW;
      context.fillText(String(day), x, height - 8);
    });
  }, [tab, assessmentDone, totalScore]);

  useEffect(() => {
    if (tab !== "healthProfile") return;
    let cancelled = false;
    Promise.all([getHealthProfile(), listAllergenExposures()])
      .then(([profile, items]) => {
        if (cancelled) return;
        setHealthProfile(profile);
        setProfileDraft(profile ? {
          basicInfo: profile.basicInfo,
          allergyHistory: profile.allergyHistory,
        } : emptyHealthProfile);
        setExposures(items);
        setProfileStatus("ready");
        setProfileNotice(profile ? "已读取服务端健康档案" : "暂无健康档案，请填写后保存");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProfileStatus("error");
        setProfileNotice(error instanceof Error ? error.message : "健康档案暂时无法读取");
      });
    return () => { cancelled = true; };
  }, [tab]);

  useEffect(() => {
    if (tab !== "allergenRecord") return;
    let cancelled = false;
    listAllergenExposures()
      .then((items) => {
        if (cancelled) return;
        setExposures(items);
        setExposureStatus("ready");
        setExposureNotice(items.length > 0 ? "已读取服务端患者自述记录" : "该账户暂无过敏原记录");
        const sameDay = items.find((item) => item.date === selectedDate);
        if (sameDay) {
          setEditingExposureId(sameDay.id);
          setExposureDraft({
            date: sameDay.date,
            factors: sameDay.factors,
            otherDescription: sameDay.otherDescription,
          });
          setExposureNotice("已回显该日期的患者自述记录，可继续编辑");
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setExposureStatus("error");
        setExposureNotice(error instanceof Error ? error.message : "过敏原历史暂时无法读取");
      });
    return () => { cancelled = true; };
  }, [tab, selectedDate]);

  const addExchange = (answer: string, reply: string, nextStep: number, source?: string) => {
    setMessages((current) => [
      ...current,
      { id: Date.now(), role: "user", kind: "text", text: answer },
      { id: Date.now() + 1, role: "ai", kind: "thinking" },
    ]);
    window.setTimeout(() => {
      setMessages((current) => [
        ...current.filter((message) => message.kind !== "thinking"),
        { id: Date.now() + 2, role: "ai", kind: "text", text: reply },
        ...(source
          ? [{ id: Date.now() + 3, role: "ai" as const, kind: "source" as const, title: "回答依据", detail: source }]
          : []),
      ]);
      setStep(nextStep);
    }, 550);
  };

  const startConsultation = () => {
    setTab("chat");
    if (step === 0) {
      addExchange("开始了解", "好的。你现在最明显的不舒服是什么？可以直接描述，也可以点击常见情况。", 1);
    }
  };

  const selectSymptom = (answer: string) =>
    addExchange(answer, "了解了。这个情况大概持续多久？是否在换季、遇冷空气或早晨起床时更明显？", 2);

  const selectDuration = (answer: string) =>
    addExchange(
      answer,
      "收到。我先做安全确认：目前有没有高热、明显头痛、面部肿痛、呼吸困难，或者鼻出血不止？",
      3,
    );

  const selectWarning = (answer: string) => {
    if (answer !== warningOptions[0]) {
      addExchange(answer, "这种情况不适合只在家调理。建议尽快前往耳鼻喉科就诊；如果呼吸困难，请立即寻求急诊帮助。", 5);
      return;
    }
    addExchange(
      answer,
      "信息已收集完成。当前交互演示不会输出诊断、证型或个性化调理方案；如需判断，请咨询正规医疗机构。",
      4,
      "演示流程 · 未接入正式临床规则与审核内容",
    );
  };

  const askKnowledge = (index: number) => {
    const item = knowledgeQuestions[index];
    setTab("chat");
    addExchange(item.question, item.answer, step || 0, item.source);
  };

  const sendCustom = (event: FormEvent) => {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;
    setInput("");
    if (step === 1) selectSymptom(value);
    else if (step === 2) selectDuration(value);
    else if (step === 3) selectWarning(value);
    else
      addExchange(
        value,
        "我已记录。这是内部交互演示，当前不会根据自由输入生成诊断或治疗建议。",
        step,
        "内部演示 · 内容待审核",
      );
  };

  const editExposure = (record: AllergenExposure) => {
    setSelectedDate(record.date);
    setEditingExposureId(record.id);
    setExposureDraft({
      date: record.date,
      factors: record.factors,
      otherDescription: record.otherDescription,
    });
    setExposureNotice("正在编辑这条患者自述记录，保存后才会更新服务端");
  };

  const startAllergenRecord = (
    date: string,
    returnTab: "assessment" | "healthProfile" = "assessment",
  ) => {
    setSelectedDate(date);
    setAllergenReturnTab(returnTab);
    setEditingExposureId(null);
    setExposureDraft({ date, factors: [], otherDescription: "" });
    setExposureStatus("loading");
    setExposureNotice("正在读取过敏原历史…");
    setEntryOpen(false);
    setTab("allergenRecord");
  };

  const openHealthProfile = () => {
    setProfileStatus("loading");
    setProfileNotice("正在读取健康档案…");
    setTab("healthProfile");
  };

  const openSymptomDate = (date: string) => {
    setSelectedDate(date);
    setEntryOpen(true);
  };

  const selectExposureDate = (date: string) => {
    setSelectedDate(date);
    setEditingExposureId(null);
    setExposureDraft({ date, factors: [], otherDescription: "" });
    setExposureStatus("loading");
    setExposureNotice("正在读取该日期的患者自述记录…");
  };

  const submitProfile = async (event: FormEvent) => {
    event.preventDefault();
    setProfileStatus("saving");
    setProfileNotice("正在保存到服务端健康档案…");
    try {
      const saved = await saveHealthProfile(profileDraft, healthProfile?.version ?? 0);
      setHealthProfile(saved);
      setProfileDraft({
        basicInfo: saved.basicInfo,
        allergyHistory: saved.allergyHistory,
      });
      setProfileEditing(false);
      setProfileStatus("ready");
      setProfileNotice("健康档案已由服务端确认保存");
    } catch (error) {
      setProfileStatus("error");
      setProfileNotice(error instanceof Error ? error.message : "健康档案保存失败，填写内容仍保留在本页");
    }
  };

  const submitExposure = async (event: FormEvent) => {
    event.preventDefault();
    const validation = validateExposureDraft(exposureDraft);
    if (validation) {
      setExposureStatus("error");
      setExposureNotice(validation);
      return;
    }
    setExposureStatus("saving");
    setExposureNotice("正在保存患者自述记录…");
    try {
      const currentRecord = editingExposureId
        ? exposures.find((record) => record.id === editingExposureId) ?? null
        : null;
      const saved = await saveAllergenExposure(exposureDraft, currentRecord);
      setExposures((current) => upsertExposure(current, saved));
      setEditingExposureId(saved.id);
      setExposureStatus("ready");
      setExposureNotice("过敏原患者自述已由服务端确认保存");
    } catch (error) {
      setExposureStatus("error");
      setExposureNotice(error instanceof Error ? error.message : "保存失败，当前选择仍保留在本页");
    }
  };

  const removeExposure = async (record: AllergenExposure) => {
    setExposureStatus("saving");
    setExposureNotice("正在删除服务端记录…");
    try {
      await deleteAllergenExposure(record);
      setExposures((current) => current.filter((item) => item.id !== record.id));
      if (editingExposureId === record.id) {
        setEditingExposureId(null);
        setExposureDraft({ date: record.date, factors: [], otherDescription: "" });
      }
      setExposureStatus("ready");
      setExposureNotice("记录已由服务端确认删除");
    } catch (error) {
      setExposureStatus("error");
      setExposureNotice(error instanceof Error ? error.message : "删除失败，原记录未变更");
    }
  };

  const goBack = () => {
    if (tab === "healthProfile") setTab("profile");
    else if (tab === "allergenRecord") setTab(allergenReturnTab);
    else if (tab !== "home") setTab("home");
  };

  const resetDemo = () => {
    setMessages([
      {
        id: Date.now(),
        role: "ai",
        kind: "text",
        text: "你好，我是小岐。这是内部交互演示，你可以体验描述症状和查看鼻健康内容；当前不会输出诊断、证型或个性化治疗方案。",
      },
    ]);
    setStep(0);
    setAssessmentDone(false);
    setScores([2, 2, 2, 1]);
    setEntryOpen(false);
    setProfileEditing(false);
    setExposureNotice("");
    setTab("home");
  };

  const activeOptions =
    step === 1 ? symptomOptions : step === 2 ? durationOptions : step === 3 ? warningOptions : [];

  const headerTitle =
    tab === "home"
      ? "抗敏先锋"
      : tab === "chat"
        ? "小岐知识助手"
        : tab === "assessment"
          ? "过敏日历"
          : tab === "healthProfile"
            ? "健康档案"
            : tab === "allergenRecord"
              ? "过敏原记录"
          : tab === "articles"
            ? "鼻健康科普"
            : "我的";

  return (
    <main className="demo-shell">
      <section className="phone-wrap" aria-label="抗敏先锋小程序">
        <div className="phone">
          <header className="phone-header real-header">
            <button className="icon-button" onClick={goBack} aria-label="返回">‹</button>
            <div className="real-title">
              <strong>{headerTitle}</strong>
              {tab === "chat" && <span>内部交互演示</span>}
            </div>
            <button className="mini-program-menu" onClick={resetDemo} aria-label="更多">
              <span>•••</span><i />
            </button>
          </header>

          <div className="app-body">
            {tab === "home" && (
              <div className="home-view">
                <div className="brand-banner" aria-label="抗敏先锋">
                  <img src="/brand-banner.jpg" alt="抗敏先锋" />
                </div>
                <section className="home-modules" aria-label="鼻健康服务">
                  <button className="diagnose-module" onClick={startConsultation}>
                    <span className="module-icon">诊</span>
                    <small>交互流程演示</small>
                    <strong>诊一诊</strong>
                    <p>和小岐聊聊症状，体验问答与安全提示。</p>
                    <b>开始了解 <i>→</i></b>
                  </button>
                  <button className="learn-module" onClick={() => setTab("articles")}>
                    <span className="module-icon">学</span>
                    <small>内容审核中</small>
                    <strong>学一学</strong>
                    <p>了解鼻健康知识，掌握日常防护方法。</p>
                    <b>去学习 <i>→</i></b>
                  </button>
                </section>

                <aside className="basis-card" aria-label="方案依据与使用说明">
                  <span>据</span>
                  <div>
                    <strong>抗敏先锋鼻健康交互 Demo</strong>
                    <p>用于演示小程序页面与操作流程，不输出诊断、证型或个性化治疗方案。</p>
                    <small>正式内容、规则与数据仍待审核接入</small>
                    <em>结果仅供参考，最终方案请以门诊诊断为准。</em>
                  </div>
                </aside>

                <section className="today-grid">
                  <button onClick={() => setTab("assessment")}>
                    <span className="feature-icon chart-icon">↘</span>
                    <small>今日待完成</small><strong>症状评估</strong><i>约 1 分钟</i>
                  </button>
                  <button onClick={() => askKnowledge(0)}>
                    <span className="feature-icon book-icon">知</span>
                    <small>科普内容演示</small><strong>换季为何反复？</strong><i>查看示例</i>
                  </button>
                </section>

                <section className="mini-trend" onClick={() => setTab("assessment")}>
                  <div><small>趋势展示占位</small><h3>暂无真实健康记录</h3></div>
                  <div className="sparkline" aria-hidden="true">
                    <i style={{ height: "84%" }} /><i style={{ height: "73%" }} /><i style={{ height: "64%" }} />
                    <i style={{ height: "55%" }} /><i className="active" style={{ height: "42%" }} />
                  </div>
                  <span>查看演示 ›</span>
                </section>

                <div className="section-heading"><div><small>为你推荐</small><h3>今天读点什么</h3></div><button onClick={() => setTab("articles")}>全部 ›</button></div>
                <button className="article-feature" onClick={() => setArticleOpen(0)}>
                  <div className="article-art"><span /><i>4</i></div>
                  <div><small>日常防护 · 3 分钟</small><strong>换季鼻敏感，先做好这 4 件小事</strong><span>温差、卧室环境与外出防护</span></div>
                </button>
              </div>
            )}

            {tab === "chat" && (
              <div className="chat-view">
                <div className="safety-banner">
                  <span>库</span>
                  <p><strong>内部交互演示</strong><small>当前内容待审核 · 不替代门诊诊断</small></p>
                </div>
                <div className="chat" aria-live="polite">
                  <div className="time-label">今天 14:20</div>
                  {messages.map((message) => {
                    if (message.kind === "thinking") {
                      return <div className="message-row ai-row" key={message.id}><div className="mini-avatar">岐</div><div className="bubble ai-bubble typing"><b /><b /><b /></div></div>;
                    }
                    if (message.kind === "source") {
                      return <div className="source-card" key={message.id}><span>✓</span><div><strong>{message.title}</strong><small>{message.detail}</small></div><b>›</b></div>;
                    }
                    return (
                      <div className={`message-row ${message.role}-row`} key={message.id}>
                        {message.role === "ai" && <div className="mini-avatar">岐</div>}
                        <div className={`bubble ${message.role}-bubble`}>{message.text}</div>
                      </div>
                    );
                  })}

                  {step === 0 && messages.length === 1 && (
                    <>
                      <div className="quick-ask-label">你可以这样问</div>
                      <div className="knowledge-options">
                        {knowledgeQuestions.map((item, index) => <button key={item.question} onClick={() => askKnowledge(index)}><span>问</span>{item.question}<b>›</b></button>)}
                      </div>
                      <button className="start-card" onClick={startConsultation}>
                        <span className="start-icon">聊</span><span><strong>开始了解我的情况</strong><small>约 2 分钟 · 随时可以退出</small></span><b>›</b>
                      </button>
                    </>
                  )}

                  {activeOptions.length > 0 && (
                    <div className="quick-options">
                      {activeOptions.map((option) => (
                        <button key={option} onClick={() => step === 1 ? selectSymptom(option) : step === 2 ? selectDuration(option) : selectWarning(option)}>
                          {option}<span>›</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {step === 4 && (
                    <>
                      <article className="result-card">
                        <div className="result-head"><div><small>交互演示已完成</small><h2>未输出诊断或证型</h2></div><span>仅作演示</span></div>
                        <p>当前版本仅展示交互流程，不依据本次回答生成个性化调理方案。</p>
                        <div className="evidence"><span>症状已记录</span><span>安全项已确认</span><span>建议线下咨询</span></div>
                        <div className="result-foot"><span>内容状态</span> 内部演示，待正式规则与医学审核</div>
                        <div className="result-disclaimer">结果仅供参考，最终方案请以门诊诊断为准。</div>
                      </article>
                      <article className="plan-card">
                        <div className="plan-title"><span>演示</span><div><small>功能未开放</small><h2>正式方案待审核后接入</h2></div></div>
                        <ol>
                          <li><i>1</i><span><strong>保留症状记录入口</strong><small>当前记录仅用于界面演示</small></span></li>
                          <li><i>2</i><span><strong>出现高危信号及时就医</strong><small>呼吸困难等情况请立即寻求帮助</small></span></li>
                          <li><i>3</i><span><strong>等待正式内容开放</strong><small>规则与医学内容审核完成后再接入</small></span></li>
                        </ol>
                      </article>
                      <button className="video-card" onClick={() => setVideoOpen(true)}>
                        <div className="video-cover"><span className="sun" /><div className="face-demo"><i /><b /></div><span className="play">▶</span><small>02:36</small></div>
                        <div className="video-copy"><small>示范内容未开放</small><strong>护理视频待审核</strong><span>审核通过后再展示</span></div>
                      </button>
                      <button className="feedback-button" onClick={() => setTab("assessment")}>去记录今天的症状</button>
                    </>
                  )}
                  <div ref={chatEnd} />
                </div>
                <form className="composer" onSubmit={sendCustom}>
                  <button type="button" aria-label="语音输入">⌁</button>
                  <input aria-label="输入症状或问题" value={input} onChange={(event) => setInput(event.target.value)} placeholder="问问题或描述症状…" />
                  <button className="send-button" type="submit" aria-label="发送">↑</button>
                </form>
              </div>
            )}

            {tab === "assessment" && (
              <div className="assessment-view">
                <section className="allergy-calendar">
                  <div className="calendar-top">
                    <div><small>症状评估日历 · 演示数据</small><h2>过敏日历</h2></div>
                    <button onClick={() => setCalendarMode((mode) => mode === "calendar" ? "list" : "calendar")}>
                      {calendarMode === "calendar" ? "☷ 列表" : "▦ 日历"}
                    </button>
                  </div>

                  {calendarMode === "calendar" ? (
                    <>
                      <div className="month-switch"><button aria-label="上个月">‹</button><strong>2026年7月</strong><button aria-label="下个月">›</button></div>
                      <div className="week-row">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}</div>
                      <div className="calendar-grid">
                        {calendarDays.map((item, index) => (
                          <button
                            key={`${item.day}-${index}`}
                            className={`${item.muted ? "muted" : ""} ${item.level ?? ""} ${item.today ? "today" : ""}`}
                            onClick={() => !item.muted && openSymptomDate(calendarDateValue(item.day, index))}
                            aria-label={`${item.day}日${item.level === "mild" ? "轻度" : item.level === "moderate" ? "中度" : ""}`}
                          >
                            {item.day}
                          </button>
                        ))}
                      </div>
                      <div className="calendar-legend"><span><i className="good" />良好</span><span><i className="mild" />轻度</span><span><i className="moderate" />中度</span><span><i className="severe" />重度</span></div>
                    </>
                  ) : (
                    <div className="calendar-list">
                      <button onClick={() => openSymptomDate("2026-07-19")}><time>7月19日</time><span className="mild">轻度</span><strong>喷嚏 1 · 流涕 1 · 鼻塞 1 · 鼻痒 0</strong><b>关联过敏原 ›</b></button>
                      <button onClick={() => openSymptomDate("2026-07-17")}><time>7月17日</time><span className="moderate">中度</span><strong>喷嚏 2 · 流涕 2 · 鼻塞 2 · 鼻痒 1</strong><b>关联过敏原 ›</b></button>
                      <button onClick={() => openSymptomDate("2026-07-15")}><time>7月15日</time><span className="mild">轻度</span><strong>喷嚏 1 · 流涕 1 · 鼻塞 1 · 鼻痒 1</strong><b>关联过敏原 ›</b></button>
                    </div>
                  )}
                </section>

                <section className="date-link-card" aria-label="症状与过敏原日期关联">
                  <div>
                    <small>按同一天关联患者自述</small>
                    <strong>{displayDate(selectedDate)}</strong>
                    <p>{symptomDates[selectedDate] ? `该日期有${symptomDates[selectedDate]}症状演示记录` : "该日期暂无真实症状记录"}</p>
                  </div>
                  <button onClick={() => startAllergenRecord(selectedDate)}>记录当天过敏原</button>
                  <p>这里只关联记录日期，不会把接触因素自动判定为症状病因。</p>
                </section>

                <article className="trend-card">
                  <div className="trend-title"><div><small>演示趋势</small><h3>过敏趋势</h3></div><span>非真实数据</span></div>
                  <canvas ref={chartRef} aria-label="本月过敏严重程度趋势图" />
                  <div className="chart-legend"><span><i />过敏严重程度</span><small>仅用于展示界面，不代表个人数据</small></div>
                </article>

                <button className="calendar-add-inline" onClick={() => openSymptomDate(localDateValue())}>＋ 记录今天的症状</button>
              </div>
            )}

            {tab === "healthProfile" && (
              <div className="health-profile-view">
                <section className="record-page-intro">
                  <small>独立健康档案</small>
                  <h2>我的健康档案</h2>
                  <p>这里只展示和保存用户主动填写的记录，不推断诊断、病因或治疗方案。</p>
                </section>

                <div className={`record-notice ${profileStatus === "error" ? "error" : ""}`} role="status">
                  <strong>{profileStatus === "loading" || profileStatus === "saving" ? "处理中" : profileStatus === "error" ? "后端依赖待接入" : "档案状态"}</strong>
                  <span>{profileNotice || "进入本页后从服务端读取健康档案"}</span>
                </div>

                {profileEditing ? (
                  <form className="profile-edit-form" onSubmit={submitProfile}>
                    <section className="health-record-card">
                      <div className="record-card-title"><span>基</span><div><h3>基础信息</h3><small>由用户本人填写</small></div></div>
                      <label>姓名或称呼<input value={profileDraft.basicInfo.displayName} onChange={(event) => setProfileDraft((current) => ({ ...current, basicInfo: { ...current.basicInfo, displayName: event.target.value } }))} placeholder="待填写" /></label>
                      <label>出生日期<input type="date" value={profileDraft.basicInfo.birthDate} onChange={(event) => setProfileDraft((current) => ({ ...current, basicInfo: { ...current.basicInfo, birthDate: event.target.value } }))} /></label>
                      <label>性别<select value={profileDraft.basicInfo.sex} onChange={(event) => setProfileDraft((current) => ({ ...current, basicInfo: { ...current.basicInfo, sex: event.target.value as HealthProfileDraft["basicInfo"]["sex"] } }))}><option value="unspecified">暂不填写</option><option value="female">女</option><option value="male">男</option></select></label>
                    </section>
                    <section className="health-record-card">
                      <div className="record-card-title"><span>史</span><div><h3>过敏史</h3><small>既往检查或本人已知情况</small></div></div>
                      <label>过敏史<textarea value={profileDraft.allergyHistory} onChange={(event) => setProfileDraft((current) => ({ ...current, allergyHistory: event.target.value }))} placeholder="如无记录可留空，请勿自行下诊断" /></label>
                    </section>
                    <section className="health-record-card">
                      <div className="record-card-title"><span>因</span><div><h3>常见诱因</h3><small>用户主动维护的档案内容</small></div></div>
                      <p className="record-empty">常见诱因由已保存的患者过敏原暴露记录自动汇总；请通过“过敏原记录”新增或修改，健康档案保存请求不会直接改写该投影。</p>
                    </section>
                    <div className="record-form-actions"><button type="button" onClick={() => setProfileEditing(false)}>取消</button><button type="submit" disabled={profileStatus === "saving"}>{profileStatus === "saving" ? "保存中…" : "保存健康档案"}</button></div>
                  </form>
                ) : (
                  <>
                    <section className="health-record-card">
                      <div className="record-card-title"><span>基</span><div><h3>基础信息</h3><small>姓名、出生日期与性别</small></div><button onClick={() => setProfileEditing(true)}>编辑</button></div>
                      <div className="record-values">
                        <p><span>姓名或称呼</span><strong>{healthProfile?.basicInfo.displayName || "待填写"}</strong></p>
                        <p><span>出生日期</span><strong>{healthProfile?.basicInfo.birthDate || "待填写"}</strong></p>
                        <p><span>性别</span><strong>{healthProfile?.basicInfo.sex === "female" ? "女" : healthProfile?.basicInfo.sex === "male" ? "男" : "待填写"}</strong></p>
                      </div>
                    </section>
                    <section className="health-record-card">
                      <div className="record-card-title"><span>史</span><div><h3>过敏史</h3><small>用户记录，不替代医疗诊断</small></div><button onClick={() => setProfileEditing(true)}>编辑</button></div>
                      <p className="record-empty">{healthProfile?.allergyHistory || "暂无已保存的过敏史"}</p>
                    </section>
                    <section className="health-record-card trigger-card">
                      <div className="record-card-title"><span>因</span><div><h3>常见诱因</h3><small>区分档案内容与患者每日自述</small></div><button onClick={() => startAllergenRecord(localDateValue(), "healthProfile")}>新增记录</button></div>
                      {healthProfile?.commonTriggers.length ? <div className="record-tags">{healthProfile.commonTriggers.map((item) => <span key={item.code}>{item.label}<small>患者自述 · 最近 {displayDate(item.latestDate)}</small></span>)}</div> : <p className="record-empty">暂无已持久化暴露记录生成的常见诱因</p>}
                      <div className="patient-records">
                        <strong>患者自述暴露记录</strong>
                        <p>按日期同步展示，仅供回顾，不代表已确定病因。</p>
                        {exposures.length > 0 ? exposures.map((record) => (
                          <button key={record.id} onClick={() => { editExposure(record); setAllergenReturnTab("healthProfile"); setExposureStatus("loading"); setTab("allergenRecord"); }}>
                            <span>{displayDate(record.date)} · 患者记录</span>
                            <strong>{record.factors.join("、")}{record.otherDescription ? `：${record.otherDescription}` : ""}</strong>
                            <b>查看原记录 ›</b>
                          </button>
                        )) : <small>暂无可追溯的患者自述记录</small>}
                      </div>
                    </section>
                    <button className="medication-entry" onClick={() => { setProfileStatus("error"); setProfileNotice("用药记录为独立后端依赖；接口完成前本页不会伪造保存状态"); }}>
                      <span>药</span><div><strong>用药记录</strong><small>记录正在使用或曾使用的药物</small></div><b>进入 ›</b>
                    </button>
                  </>
                )}

                <p className="profile-disclaimer">健康档案与过敏原暴露均为用户记录，不能替代医生诊断；结果请以正规医疗机构意见为准。</p>
              </div>
            )}

            {tab === "allergenRecord" && (
              <div className="allergen-record-view">
                <section className="record-page-intro allergen-intro">
                  <small>关联当天症状</small>
                  <h2>记录接触过的因素</h2>
                  <p>请选择当天回忆到的暴露。这是患者自述，不会自动判定为症状病因。</p>
                </section>

                <section className="linked-date-card" aria-label="关联日期">
                  <label>记录日期<input type="date" value={exposureDraft.date} onChange={(event) => selectExposureDate(event.target.value)} /></label>
                  <div><span>关联症状日期</span><strong>{displayDate(exposureDraft.date)}</strong><small>{symptomDates[exposureDraft.date] ? `${symptomDates[exposureDraft.date]}症状演示记录` : "暂无真实症状记录"}</small></div>
                  <button onClick={() => { setSelectedDate(exposureDraft.date); setEntryOpen(true); setTab("assessment"); }}>查看当天症状</button>
                </section>

                <div className={`record-notice ${exposureStatus === "error" ? "error" : ""}`} role="status">
                  <strong>{exposureStatus === "loading" || exposureStatus === "saving" ? "处理中" : exposureStatus === "error" ? "保存边界" : "记录状态"}</strong>
                  <span>{exposureNotice || "真实历史与保存结果均由服务端返回"}</span>
                </div>

                <form className="allergen-form" onSubmit={submitExposure}>
                  {allergenGroups.map((group) => (
                    <fieldset key={group.name}>
                      <legend>{group.name}</legend>
                      <div className="allergen-options">
                        {group.options.map((option) => (
                          <label className={exposureDraft.factors.includes(option) ? "selected" : ""} key={option}>
                            <input type="checkbox" checked={exposureDraft.factors.includes(option)} onChange={() => setExposureDraft((current) => ({ ...current, factors: toggleAllergen(current.factors, option) }))} />
                            <span>{option}</span><i aria-hidden="true">✓</i>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                  {exposureDraft.factors.includes(OTHER_ALLERGEN) && (
                    <label className="other-description">其它描述<textarea value={exposureDraft.otherDescription} onChange={(event) => setExposureDraft((current) => ({ ...current, otherDescription: event.target.value }))} placeholder="请简要描述当天接触的其它因素" /></label>
                  )}
                  <p className="form-boundary">所选内容只表示患者对当天暴露的回忆，不会生成病因、诊断或治疗建议。</p>
                  {exposureValidation && <p className="form-validation">{exposureValidation}</p>}
                  <button className="save-exposure" type="submit" disabled={Boolean(exposureValidation) || exposureStatus === "saving"}>{exposureStatus === "saving" ? "保存中…" : editingExposureId ? "保存修改" : "保存记录"}</button>
                </form>

                <section className="exposure-history">
                  <div><small>服务端记录</small><h3>历史记录</h3></div>
                  {exposures.length > 0 ? exposures.map((record) => (
                    <article key={record.id}>
                      <time>{displayDate(record.date)}</time><span>患者自述</span>
                      <strong>{record.factors.join("、")}</strong>
                      {record.otherDescription && <p>{record.otherDescription}</p>}
                      <div><button onClick={() => editExposure(record)}>编辑</button><button onClick={() => removeExposure(record)} disabled={exposureStatus === "saving"}>删除</button></div>
                    </article>
                  )) : <p className="record-empty">暂无服务端返回的历史记录；本页不会使用假记录填充。</p>}
                </section>
              </div>
            )}

            {tab === "articles" && (
              <div className="articles-view">
                <div className="articles-hero"><small>健康专栏演示</small><h2>懂一点，鼻子舒服一点</h2><p>内容处于内部演示与审核阶段，不由模型自由生成。</p></div>
                <div className="topic-chips"><button className="active">为你推荐</button><button>日常防护</button><button>亲子健康</button></div>
                <div className="article-list">
                  {articles.map((article, index) => (
                    <button key={article.title} onClick={() => setArticleOpen(index)}>
                      <div className={`article-thumb ${article.tone}`}><span>{index === 0 ? "护" : index === 1 ? "安" : "童"}</span></div>
                      <div><small>{article.tag} · {article.read}</small><strong>{article.title}</strong><p>{article.summary}</p></div>
                    </button>
                  ))}
                </div>
                <div className="push-note"><span>铃</span><div><strong>内容提醒演示</strong><small>审核通过后再开放正式提醒</small></div></div>
              </div>
            )}

            {tab === "profile" && (
              <div className="profile-view">
                <section className="profile-hero">
                  <div className="profile-avatar" aria-hidden="true">访</div>
                  <div>
                    <small>演示账户</small>
                    <h2>尚未登录</h2>
                    <p>暂无真实健康记录</p>
                  </div>
                  <button aria-label="编辑个人资料">编辑</button>
                </section>

                <section className="profile-summary" aria-label="健康数据摘要">
                  <div><strong>--</strong><span>连续记录/天</span></div>
                  <div><strong>--</strong><span>本月记录/次</span></div>
                  <div><strong>暂无</strong><span>最近评估</span></div>
                </section>

                <section className="profile-section">
                  <h3>我的健康</h3>
                  <button onClick={openHealthProfile}>
                    <span className="profile-item-icon blue">档</span>
                    <div><strong>健康档案</strong><small>基础信息、过敏史与常见诱因</small></div>
                    <b>›</b>
                  </button>
                  <button onClick={() => setTab("assessment")}>
                    <span className="profile-item-icon amber">记</span>
                    <div><strong>症状记录</strong><small>查看日历、趋势与 TNSS 评估</small></div>
                    <b>›</b>
                  </button>
                  <button onClick={() => setTab("articles")}>
                    <span className="profile-item-icon mint">科</span>
                    <div><strong>鼻健康科普</strong><small>查看待审核的演示内容</small></div>
                    <b>›</b>
                  </button>
                </section>

                <section className="profile-section">
                  <h3>设置与服务</h3>
                  <button>
                    <span className="profile-item-icon violet">铃</span>
                    <div><strong>提醒设置</strong><small>每日记录与健康内容提醒</small></div>
                    <b>›</b>
                  </button>
                  <button>
                    <span className="profile-item-icon gray">盾</span>
                    <div><strong>隐私与授权</strong><small>查看和管理健康数据授权</small></div>
                    <b>›</b>
                  </button>
                  <button>
                    <span className="profile-item-icon gray">关</span>
                    <div><strong>关于抗敏先锋</strong><small>团队介绍、使用说明与意见反馈</small></div>
                    <b>›</b>
                  </button>
                </section>

                <p className="profile-disclaimer">当前为交互 Demo，不保存真实健康档案或趋势数据；结果不能替代门诊诊断。</p>
              </div>
            )}
          </div>

          <nav className="bottom-nav" aria-label="主要功能">
            <button className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}><span className="nav-glyph nav-home">⌂</span>首页</button>
            <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}><span className="nav-glyph nav-chat">◌</span>问助手</button>
            <button className="nav-add" onClick={() => { setTab("assessment"); openSymptomDate(localDateValue()); }} aria-label="新增症状记录"><span>＋</span></button>
            <button className={tab === "assessment" || tab === "allergenRecord" ? "active" : ""} onClick={() => setTab("assessment")}><span className="nav-glyph nav-calendar">▦</span>日历</button>
            <button className={tab === "profile" || tab === "healthProfile" ? "active" : ""} onClick={() => setTab("profile")}><span className="nav-glyph nav-profile">人</span>我的</button>
          </nav>

          {entryOpen && (
            <div className="entry-sheet-backdrop" role="dialog" aria-modal="true" aria-label="填写所选日期症状量表">
              <div className="entry-sheet">
                <div className="sheet-handle" />
                <div className="sheet-title"><div><small>症状记录 · {displayDate(selectedDate)}</small><h2>记录当天的症状</h2><p>仅用于界面演示，不会保存真实健康数据</p></div><button onClick={() => setEntryOpen(false)}>×</button></div>
                <div className="scale-card">
                  {scaleItems.map((item, itemIndex) => (
                    <div className="scale-row" key={item}>
                      <div><strong>{item}</strong><span>{["无", "轻微", "明显", "严重"][scores[itemIndex]]}</span></div>
                      <div className="score-options">
                        {[0, 1, 2, 3].map((score) => (
                          <button className={scores[itemIndex] === score ? "selected" : ""} key={score} onClick={() => setScores((current) => current.map((value, index) => index === itemIndex ? score : value))}>{score}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div className="sheet-score"><span>TNSS 总分</span><strong>{totalScore}<i>/12</i></strong><b>{totalScore <= 4 ? "轻度" : totalScore <= 8 ? "中度" : "重度"}</b></div>
                  <p className="assessment-disclaimer">量表结果仅供参考，最终方案请以门诊诊断为准。</p>
                  <div className="sheet-allergen-link">
                    <div><strong>当天过敏原暴露</strong><small>与本次症状使用同一记录日期</small></div>
                    <button type="button" onClick={() => startAllergenRecord(selectedDate)}>去记录</button>
                    <p>过敏原仅为患者自述，不自动判定医学因果。</p>
                  </div>
                  <button className="submit-assessment" onClick={() => { setAssessmentDone(true); setEntryOpen(false); }}>
                    保存演示记录
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {videoOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="操作视频演示">
          <div className="video-modal">
            <button onClick={() => setVideoOpen(false)} aria-label="关闭视频">×</button>
            <div className="video-stage"><div className="video-person"><span>请用指腹轻柔按揉鼻翼两侧</span><i /><b /></div><div className="video-progress"><span /></div></div>
            <h2>鼻周轻柔舒缓</h2><p>力度以轻柔、舒适为准。如出现疼痛、出血或其他不适，请立即停止。</p>
          </div>
        </div>
      )}

      {articleOpen !== null && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="科普文章">
          <article className="article-modal">
            <button onClick={() => setArticleOpen(null)} aria-label="关闭文章">×</button>
            <small>{articles[articleOpen].tag} · {articles[articleOpen].read}</small>
            <h2>{articles[articleOpen].title}</h2>
            <p className="lead">{articles[articleOpen].summary}</p>
            <h3>先观察，再行动</h3>
            <p>记录症状出现的时间、持续多久，以及是否影响睡眠和学习。连续记录比一次性的感受更有参考价值。</p>
            <h3>减少常见刺激</h3>
            <p>留意温差、冷空气、粉尘和气味刺激。保持居室清洁通风，外出时根据环境做好防护。</p>
            <div className="article-warning"><strong>需要就医的情况</strong><span>如果伴随高热、剧烈头痛、呼吸困难或反复鼻出血，请及时前往正规医疗机构。</span></div>
            <footer>内部演示内容 · 待团队与医学审核 · 不替代门诊诊断</footer>
          </article>
        </div>
      )}
    </main>
  );
}
