"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import {
  AllergenExposure,
  AllergenExposureDraft,
  allergenGroups,
  deleteMedication,
  deleteAllergenExposure,
  emptyHealthProfile,
  emptyMedication,
  emptySymptomScores,
  getHealthProfile,
  hasCompleteSymptomScores,
  HealthProfile,
  HealthProfileDraft,
  listMedications,
  listAllergenExposures,
  listSymptoms,
  localDateValue,
  MedicationDraft,
  MedicationRecord,
  OTHER_ALLERGEN,
  saveAllergenExposure,
  saveHealthProfile,
  saveMedication,
  saveSymptom,
  SymptomRecord,
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

class RequestVersion {
  private value = 0;

  next(): number {
    this.value += 1;
    return this.value;
  }

  isCurrent(version: number): boolean {
    return this.value === version;
  }
}

const symptomOptions = [
  "鼻塞、打喷嚏、流清鼻涕",
  "晚上鼻塞，睡眠受影响",
  "鼻涕黄稠，还有咽部不适",
];

const durationOptions = ["最近 3 天出现", "反复半年，换季加重", "已经持续两年以上"];
const warningOptions = ["以上情况都没有", "有高热或明显头痛", "面部肿痛或鼻出血不止", "呼吸不畅或胸闷"];

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

function displayDate(value: string): string {
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function monthValue(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(value: string, offset: number): string {
  const [year, month] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function daysInMonth(value: string): number {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthLabel(value: string): string {
  const [year, month] = value.split("-").map(Number);
  return `${year}年${month}月`;
}

function calendarCells(value: string) {
  const [year, month] = value.split("-").map(Number);
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = firstDay.getUTCDay();
  const today = localDateValue();
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1, index - firstWeekday + 1));
    const dateValue = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    return {
      date: dateValue,
      day: date.getUTCDate(),
      muted: date.getUTCMonth() !== month - 1,
      today: dateValue === today,
    };
  });
}

function localDateTimeValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const pad = (item: number) => String(item).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function symptomLevel(totalScore: number): "good" | "mild" | "moderate" | "severe" {
  if (totalScore === 0) return "good";
  if (totalScore <= 4) return "mild";
  if (totalScore <= 8) return "moderate";
  return "severe";
}

function symptomLabel(totalScore: number): string {
  if (totalScore === 0) return "无明显症状";
  if (totalScore <= 4) return "轻度";
  if (totalScore <= 8) return "中度";
  return "重度";
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
  const [articleOpen, setArticleOpen] = useState<number | null>(null);
  const [scores, setScores] = useState<Array<number | null>>([...emptySymptomScores]);
  const [assessmentDone, setAssessmentDone] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [calendarMode, setCalendarMode] = useState<"calendar" | "list">("calendar");
  const [calendarMonth, setCalendarMonth] = useState(() => monthValue());
  const [selectedDate, setSelectedDate] = useState(localDateValue);
  const [allergenReturnTab, setAllergenReturnTab] = useState<"assessment" | "healthProfile">("assessment");
  const [healthProfile, setHealthProfile] = useState<HealthProfile | null>(null);
  const [profileDraft, setProfileDraft] = useState<HealthProfileDraft>(emptyHealthProfile);
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileStatus, setProfileStatus] = useState<"idle" | "loading" | "saving" | "ready" | "error">("idle");
  const [profileNotice, setProfileNotice] = useState("");
  const [profileReload, setProfileReload] = useState(0);
  const [exposures, setExposures] = useState<AllergenExposure[]>([]);
  const [medications, setMedications] = useState<MedicationRecord[]>([]);
  const [medicationDraft, setMedicationDraft] = useState<MedicationDraft>(emptyMedication);
  const [editingMedicationId, setEditingMedicationId] = useState<string | null>(null);
  const [medicationEditing, setMedicationEditing] = useState(false);
  const [medicationStatus, setMedicationStatus] = useState<"idle" | "saving" | "ready" | "error">("idle");
  const [medicationNotice, setMedicationNotice] = useState("");
  const [medicationCreateKey, setMedicationCreateKey] = useState<string | null>(null);
  const [symptoms, setSymptoms] = useState<SymptomRecord[]>([]);
  const [symptomStatus, setSymptomStatus] = useState<"idle" | "loading" | "saving" | "ready" | "error">("idle");
  const [symptomNotice, setSymptomNotice] = useState("");
  const [assessmentReload, setAssessmentReload] = useState(0);
  const [exposureDraft, setExposureDraft] = useState<AllergenExposureDraft>({
    date: localDateValue(),
    factors: [],
    otherDescription: "",
  });
  const [editingExposureId, setEditingExposureId] = useState<string | null>(null);
  const [exposureStatus, setExposureStatus] = useState<"idle" | "loading" | "saving" | "ready" | "error">("idle");
  const [exposureNotice, setExposureNotice] = useState("");
  const [exposureCreateKey, setExposureCreateKey] = useState<string | null>(null);
  const [profileLoadError, setProfileLoadError] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLCanvasElement>(null);
  const [profileRequest] = useState(() => new RequestVersion());
  const [symptomRequest] = useState(() => new RequestVersion());
  const [medicationRequest] = useState(() => new RequestVersion());
  const [exposureRequest] = useState(() => new RequestVersion());

  const scoresComplete = hasCompleteSymptomScores(scores);
  const totalScore = scores.reduce<number>((sum, score) => sum + (score ?? 0), 0);
  const exposureValidation = validateExposureDraft(exposureDraft);
  const symptomsByDate = new Map(symptoms.map((record) => [record.date, record]));
  const medicationValidation = !medicationDraft.takenAt
    ? "请选择用药时间"
    : !medicationDraft.medicationName.trim()
      ? "请填写药物名称"
      : !medicationDraft.dosageUnknown && (!medicationDraft.dosageValue.trim() || !medicationDraft.dosageUnit.trim())
        ? "请填写药物剂量和单位，或勾选剂量不详"
        : !medicationDraft.actualUseUnknown && !medicationDraft.actualUseDescription.trim()
          ? "请填写实际用量情况，或勾选实际用量不详"
          : null;

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

    const records = symptoms.filter((record) => record.date.startsWith(calendarMonth)).sort((left, right) => left.date.localeCompare(right.date));
    const values = records.map((record) => Math.min(3, Math.ceil(record.totalScore / 4)));
    const days = records.map((record) => Number(record.date.slice(-2)));
    const monthDays = daysInMonth(calendarMonth);
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
      x: pad.left + ((days[index] - 1) / Math.max(1, monthDays - 1)) * chartW,
      y: pad.top + chartH - (value / 3) * chartH,
    }));
    if (points.length > 0) {
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

      points.forEach((point) => {
        context.beginPath();
        context.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
        context.fillStyle = "#1E5AA3";
        context.fill();
      });
    }
    context.font = '9px "PingFang SC", sans-serif';
    context.fillStyle = "#87968f";
    context.textAlign = "center";
    [1, 10, 20, monthDays].forEach((day) => {
      const x = pad.left + ((day - 1) / Math.max(1, monthDays - 1)) * chartW;
      context.fillText(String(day), x, height - 8);
    });
  }, [tab, assessmentDone, totalScore, symptoms, calendarMonth]);

  useEffect(() => {
    if (tab !== "healthProfile") return;
    let cancelled = false;
    const requestVersion = profileRequest.next();
    Promise.all([getHealthProfile(), listAllergenExposures(), listMedications()])
      .then(([profile, items, medicationItems]) => {
        if (cancelled || !profileRequest.isCurrent(requestVersion)) return;
        setHealthProfile(profile);
        setProfileDraft(profile ? {
          basicInfo: profile.basicInfo,
          allergyHistory: profile.allergyHistory,
          allergyHistoryEntries: profile.allergyHistoryEntries,
        } : emptyHealthProfile);
        setExposures(items);
        setMedications(medicationItems);
        setProfileLoadError(false);
        setProfileStatus("ready");
        setProfileNotice(profile ? "已读取服务端健康档案" : "暂无健康档案，请填写后保存");
      })
      .catch((error: unknown) => {
        if (cancelled || !profileRequest.isCurrent(requestVersion)) return;
        setProfileLoadError(true);
        setProfileStatus("error");
        setProfileNotice(error instanceof Error ? error.message : "健康档案暂时无法读取");
      });
    return () => { cancelled = true; };
  }, [tab, profileReload, profileRequest]);

  useEffect(() => {
    if (tab !== "assessment") return;
    let cancelled = false;
    const requestVersion = symptomRequest.next();
    listSymptoms()
      .then((items) => {
        if (cancelled || !symptomRequest.isCurrent(requestVersion)) return;
        setSymptoms(items);
        setSymptomStatus("ready");
        setSymptomNotice(items.length > 0 ? "已读取服务端症状记录" : "暂无服务端症状记录，请选择日期开始记录");
      })
      .catch((error: unknown) => {
        if (cancelled || !symptomRequest.isCurrent(requestVersion)) return;
        setSymptoms([]);
        setSymptomStatus("error");
        setSymptomNotice(error instanceof Error ? error.message : "症状历史暂时无法读取");
      });
    return () => { cancelled = true; };
  }, [tab, assessmentReload, symptomRequest]);

  useEffect(() => {
    if (tab !== "allergenRecord") return;
    let cancelled = false;
    const requestVersion = exposureRequest.next();
    listAllergenExposures()
      .then((items) => {
        if (cancelled || !exposureRequest.isCurrent(requestVersion)) return;
        setExposures(items);
        setExposureStatus("ready");
        setExposureNotice(items.length > 0 ? "已读取服务端患者自述记录" : "该账户暂无过敏原记录");
        const sameDay = editingExposureId
          ? items.find((item) => item.id === editingExposureId)
          : items.find((item) => item.date === selectedDate);
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
        if (cancelled || !exposureRequest.isCurrent(requestVersion)) return;
        setExposureStatus("error");
        setExposureNotice(error instanceof Error ? error.message : "过敏原历史暂时无法读取");
      });
    return () => { cancelled = true; };
  }, [tab, selectedDate, editingExposureId, exposureRequest]);

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
    exposureRequest.next();
    setExposureCreateKey(null);
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
    exposureRequest.next();
    setExposureCreateKey(crypto.randomUUID());
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
    profileRequest.next();
    setProfileLoadError(false);
    setProfileReload((current) => current + 1);
    setProfileStatus("loading");
    setProfileNotice("正在读取健康档案…");
    setTab("healthProfile");
  };

  const openSymptomDate = (date: string) => {
    const wasSaving = symptomStatus === "saving";
    symptomRequest.next();
    if (wasSaving) {
      setSymptomStatus("loading");
      setAssessmentReload((current) => current + 1);
    }
    setSelectedDate(date);
    setCalendarMonth(date.slice(0, 7));
    const existing = symptomsByDate.get(date);
    setScores(existing ? [existing.scores.sneezing, existing.scores.rhinorrhea, existing.scores.congestion, existing.scores.itching] : [...emptySymptomScores]);
    setSymptomNotice(existing ? "已读取该日期的服务端症状记录" : "填写后保存到服务端症状记录");
    setEntryOpen(true);
  };

  const selectExposureDate = (date: string) => {
    exposureRequest.next();
    setExposureCreateKey(crypto.randomUUID());
    setSelectedDate(date);
    setEditingExposureId(null);
    setExposureDraft({ date, factors: [], otherDescription: "" });
    setExposureStatus("loading");
    setExposureNotice("正在读取该日期的患者自述记录…");
  };

  const submitProfile = async (event: FormEvent) => {
    event.preventDefault();
    const requestVersion = profileRequest.next();
    const draft = profileDraft;
    const expectedVersion = healthProfile?.version ?? 0;
    setProfileStatus("saving");
    setProfileNotice("正在保存到服务端健康档案…");
    try {
      const saved = await saveHealthProfile(draft, expectedVersion);
      if (!profileRequest.isCurrent(requestVersion)) return;
      setHealthProfile(saved);
      setProfileDraft({
        basicInfo: saved.basicInfo,
        allergyHistory: saved.allergyHistory,
        allergyHistoryEntries: saved.allergyHistoryEntries,
      });
      setProfileEditing(false);
      setProfileStatus("ready");
      setProfileNotice("健康档案已由服务端确认保存");
    } catch (error) {
      if (!profileRequest.isCurrent(requestVersion)) return;
      setProfileStatus("error");
      setProfileNotice(error instanceof Error ? error.message : "健康档案保存失败，填写内容仍保留在本页");
    }
  };

  const submitSymptom = async () => {
    if (!hasCompleteSymptomScores(scores)) {
      setSymptomStatus("error");
      setSymptomNotice("请先完成喷嚏、流涕、鼻塞和鼻痒四项评分");
      return;
    }
    const requestVersion = symptomRequest.next();
    const date = selectedDate;
    const scoresSnapshot = { sneezing: scores[0], rhinorrhea: scores[1], congestion: scores[2], itching: scores[3] };
    const current = symptomsByDate.get(date) ?? null;
    setSymptomStatus("saving");
    setSymptomNotice("正在保存症状记录…");
    try {
      const saved = await saveSymptom({
        date,
        scores: scoresSnapshot,
      }, current);
      if (!symptomRequest.isCurrent(requestVersion)) return;
      setSymptoms((current) => current.some((item) => item.id === saved.id) ? current.map((item) => item.id === saved.id ? saved : item) : [saved, ...current]);
      setAssessmentDone(true);
      setSymptomStatus("ready");
      setSymptomNotice("症状记录已由服务端确认保存");
      setEntryOpen(false);
    } catch (error) {
      if (!symptomRequest.isCurrent(requestVersion)) return;
      setSymptomStatus("error");
      setSymptomNotice(error instanceof Error ? error.message : "症状记录保存失败，当前评分仍保留");
    }
  };

  const beginMedication = (record: MedicationRecord | null = null) => {
    medicationRequest.next();
    setMedicationCreateKey(record ? null : crypto.randomUUID());
    setEditingMedicationId(record?.id ?? null);
    setMedicationDraft(record ? {
      takenAt: localDateTimeValue(record.takenAt),
      medicationName: record.medicationName,
      dosageValue: record.dosage.status === "known" ? record.dosage.value : "",
      dosageUnit: record.dosage.status === "known" ? record.dosage.unit : "",
      dosageUnknown: record.dosage.status === "unknown",
      actualUseDescription: record.actualUse.status === "known" ? record.actualUse.description : "",
      actualUseUnknown: record.actualUse.status === "unknown",
    } : { ...emptyMedication, takenAt: localDateTimeValue(new Date().toISOString()) });
    setMedicationStatus("idle");
    setMedicationNotice("");
    setMedicationEditing(true);
  };

  const submitMedication = async (event: FormEvent) => {
    event.preventDefault();
    if (medicationValidation) {
      setMedicationStatus("error");
      setMedicationNotice(medicationValidation);
      return;
    }
    const requestVersion = medicationRequest.next();
    const draft = medicationDraft;
    const editingId = editingMedicationId;
    const current = editingId ? medications.find((item) => item.id === editingId) ?? null : null;
    const createKey = medicationCreateKey ?? crypto.randomUUID();
    if (!editingId && !medicationCreateKey) setMedicationCreateKey(createKey);
    setMedicationStatus("saving");
    setMedicationNotice("正在保存用药记录…");
    try {
      const saved = await saveMedication(draft, current, fetch, createKey);
      if (!medicationRequest.isCurrent(requestVersion)) return;
      setMedications((items) => items.some((item) => item.id === saved.id) ? items.map((item) => item.id === saved.id ? saved : item) : [saved, ...items]);
      setMedicationEditing(false);
      setEditingMedicationId(null);
      setMedicationCreateKey(null);
      setMedicationStatus("ready");
      setMedicationNotice("用药记录已由服务端确认保存");
    } catch (error) {
      if (!medicationRequest.isCurrent(requestVersion)) return;
      setMedicationStatus("error");
      setMedicationNotice(error instanceof Error ? error.message : "用药记录保存失败，填写内容仍保留");
    }
  };

  const removeMedication = async (record: MedicationRecord) => {
    const requestVersion = medicationRequest.next();
    setMedicationStatus("saving");
    setMedicationNotice("正在删除用药记录…");
    try {
      await deleteMedication(record);
      if (!medicationRequest.isCurrent(requestVersion)) return;
      setMedications((items) => items.filter((item) => item.id !== record.id));
      setMedicationStatus("ready");
      setMedicationNotice("用药记录已由服务端确认删除");
    } catch (error) {
      if (!medicationRequest.isCurrent(requestVersion)) return;
      setMedicationStatus("error");
      setMedicationNotice(error instanceof Error ? error.message : "删除失败，原记录未变更");
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
    const requestVersion = exposureRequest.next();
    const draft = exposureDraft;
    const editingId = editingExposureId;
    const currentRecord = editingId ? exposures.find((record) => record.id === editingId) ?? null : null;
    const createKey = exposureCreateKey ?? crypto.randomUUID();
    if (!editingId && !exposureCreateKey) setExposureCreateKey(createKey);
    setExposureStatus("saving");
    setExposureNotice("正在保存患者自述记录…");
    try {
      const saved = await saveAllergenExposure(draft, currentRecord, fetch, createKey);
      if (!exposureRequest.isCurrent(requestVersion)) return;
      setExposures((current) => upsertExposure(current, saved));
      setEditingExposureId(saved.id);
      setExposureCreateKey(null);
      setExposureStatus("ready");
      setExposureNotice("过敏原患者自述已由服务端确认保存");
    } catch (error) {
      if (!exposureRequest.isCurrent(requestVersion)) return;
      setExposureStatus("error");
      setExposureNotice(error instanceof Error ? error.message : "保存失败，当前选择仍保留在本页");
    }
  };

  const removeExposure = async (record: AllergenExposure) => {
    const requestVersion = exposureRequest.next();
    setExposureStatus("saving");
    setExposureNotice("正在删除服务端记录…");
    try {
      await deleteAllergenExposure(record);
      if (!exposureRequest.isCurrent(requestVersion)) return;
      setExposures((current) => current.filter((item) => item.id !== record.id));
      if (editingExposureId === record.id) {
        setEditingExposureId(null);
        setExposureDraft({ date: record.date, factors: [], otherDescription: "" });
      }
      setExposureStatus("ready");
      setExposureNotice("记录已由服务端确认删除");
    } catch (error) {
      if (!exposureRequest.isCurrent(requestVersion)) return;
      setExposureStatus("error");
      setExposureNotice(error instanceof Error ? error.message : "删除失败，原记录未变更");
    }
  };

  const navigateTo = (next: Tab) => {
    profileRequest.next();
    symptomRequest.next();
    medicationRequest.next();
    exposureRequest.next();
    setProfileStatus((current) => current === "saving" ? "idle" : current);
    setSymptomStatus((current) => current === "saving" ? "idle" : current);
    setMedicationStatus((current) => current === "saving" ? "idle" : current);
    setExposureStatus((current) => current === "saving" ? "idle" : current);
    if (next === "assessment") setSymptomStatus("loading");
    if (next === "allergenRecord") setExposureStatus("loading");
    setTab(next);
  };

  const goBack = () => {
    if (tab === "healthProfile") { profileRequest.next(); setProfileStatus("idle"); setProfileNotice(""); setProfileLoadError(false); setTab("profile"); }
    else if (tab === "allergenRecord") { exposureRequest.next(); setExposureStatus("idle"); setExposureNotice(""); setTab(allergenReturnTab); }
    else if (tab !== "home") setTab("home");
  };

  const resetDemo = () => {
    profileRequest.next();
    symptomRequest.next();
    medicationRequest.next();
    exposureRequest.next();
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
    setScores([...emptySymptomScores]);
    setEntryOpen(false);
    setProfileStatus("idle");
    setProfileNotice("");
    setMedicationStatus("idle");
    setMedicationNotice("");
    setSymptomStatus("idle");
    setSymptomNotice("");
    setExposureStatus("idle");
    setExposureNotice("");
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
                  <button onClick={() => startAllergenRecord(localDateValue())}>
                    <span className="feature-icon chart-icon">↘</span>
                    <small>今日待完成</small><strong>过敏原记录</strong><i>记录今天</i>
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
                      <div className="plan-pending-notice" role="status">
                        <strong>正式康复方案暂未开放</strong>
                        <span>相关内容需完成临床负责人审核后，才会进入用户端。</span>
                      </div>
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
                    <div><small>症状评估日历 · 服务端记录</small><h2>过敏日历</h2></div>
                    <button onClick={() => setCalendarMode((mode) => mode === "calendar" ? "list" : "calendar")}>
                      {calendarMode === "calendar" ? "☷ 列表" : "▦ 日历"}
                    </button>
                  </div>
                  {symptomStatus === "error" && <div className="record-notice error" role="alert"><strong>症状记录读取失败</strong><span>{symptomNotice}</span><button type="button" onClick={() => { setSymptomStatus("loading"); setAssessmentReload((current) => current + 1); }}>重试</button></div>}

                  {calendarMode === "calendar" ? (
                    <>
                      <div className="month-switch"><button type="button" aria-label="上个月" onClick={() => setCalendarMonth((current) => shiftMonth(current, -1))}>‹</button><strong>{monthLabel(calendarMonth)}</strong><button type="button" aria-label="下个月" onClick={() => setCalendarMonth((current) => shiftMonth(current, 1))}>›</button></div>
                      <div className="week-row">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}</div>
                      <div className="calendar-grid">
                        {calendarCells(calendarMonth).map((item) => (
                          (() => {
                            const canReadSymptoms = symptomStatus === "ready";
                            const record = canReadSymptoms ? symptomsByDate.get(item.date) : null;
                            const level = record ? symptomLevel(record.totalScore) : "";
                            return <button
                            key={item.date}
                            className={`${item.muted ? "muted" : ""} ${level} ${item.today ? "today" : ""}`}
                            onClick={() => canReadSymptoms && !item.muted && openSymptomDate(item.date)}
                            disabled={item.muted || !canReadSymptoms}
                            aria-label={`${item.day}日${symptomStatus === "error" ? "无法读取" : symptomStatus === "loading" ? "读取中" : record ? `已记录${record.totalScore}分` : "未记录"}`}
                          >
                            {item.day}
                          </button>;
                          })()
                        ))}
                      </div>
                      <div className="calendar-legend"><span><i className="good" />良好</span><span><i className="mild" />轻度</span><span><i className="moderate" />中度</span><span><i className="severe" />重度</span></div>
                    </>
                  ) : (
                    <div className="calendar-list">
                      {symptomStatus === "error" ? <p className="record-empty">读取失败，不能判断当前是否没有记录。</p> : symptoms.length > 0 ? symptoms.map((record) => <button key={record.id} onClick={() => openSymptomDate(record.date)}><time>{displayDate(record.date)}</time><span className={symptomLevel(record.totalScore)}>{symptomLabel(record.totalScore)}</span><strong>喷嚏 {record.scores.sneezing} · 流涕 {record.scores.rhinorrhea} · 鼻塞 {record.scores.congestion} · 鼻痒 {record.scores.itching}</strong><b>查看症状记录 ›</b></button>) : <p className="record-empty">{symptomStatus === "loading" ? "正在读取服务端记录…" : "暂无真实症状记录；选择日期后保存，才会出现在这里。"}</p>}
                    </div>
                  )}
                </section>

                <section className="date-link-card" aria-label="症状与过敏原日期关联">
                  <div>
                    <small>按同一天关联患者自述</small>
                    <strong>{displayDate(selectedDate)}</strong>
                    <p>{symptomStatus === "error" ? "服务端记录读取失败" : symptomsByDate.has(selectedDate) ? "该日期已有服务端症状记录" : "该日期暂无真实症状记录"}</p>
                  </div>
                  <button onClick={() => startAllergenRecord(selectedDate)}>记录当天过敏原</button>
                  <p>这里只关联记录日期，不会把接触因素自动判定为症状病因。</p>
                </section>

                <article className="trend-card">
                  <div className="trend-title"><div><small>服务端记录趋势</small><h3>过敏趋势</h3></div><span>{symptomStatus === "error" ? "读取失败" : symptoms.length > 0 ? "真实记录" : "暂无数据"}</span></div>
                  {symptomStatus === "error" ? <p className="record-empty error-text">服务端记录读取失败，请先重试。</p> : symptoms.length > 0 ? <canvas ref={chartRef} aria-label="本月过敏严重程度趋势图" /> : <p className="record-empty">保存症状记录后，这里显示你的记录趋势。</p>}
                  <div className="chart-legend"><span><i />过敏严重程度</span><small>仅根据用户主动保存的症状记录展示，不代表诊断。</small></div>
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
                  <strong>{profileStatus === "loading" || profileStatus === "saving" ? "处理中" : profileLoadError ? "后端依赖待接入" : profileStatus === "error" ? "保存未完成" : "档案状态"}</strong>
                  <span>{profileNotice || "进入本页后从服务端读取健康档案"}</span>
                </div>

                {profileLoadError ? (
                  <section className="record-notice error" role="alert"><strong>健康档案暂时无法读取</strong><span>{profileNotice}</span><button type="button" onClick={openHealthProfile}>重试</button></section>
                ) : profileEditing ? (
                  <form className="profile-edit-form" onSubmit={submitProfile}>
                    <section className="health-record-card">
                      <div className="record-card-title"><span>基</span><div><h3>基础信息</h3><small>由用户本人填写</small></div></div>
                      <label>姓名或称呼<input value={profileDraft.basicInfo.displayName} onChange={(event) => setProfileDraft((current) => ({ ...current, basicInfo: { ...current.basicInfo, displayName: event.target.value } }))} placeholder="待填写" /></label>
                      <label>出生日期<input type="date" value={profileDraft.basicInfo.birthDate} onChange={(event) => setProfileDraft((current) => ({ ...current, basicInfo: { ...current.basicInfo, birthDate: event.target.value } }))} onInput={(event) => { const value = event.currentTarget.value; setProfileDraft((current) => ({ ...current, basicInfo: { ...current.basicInfo, birthDate: value } })); }} /></label>
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
                    {profileStatus === "error" && <p className="form-validation error-text" role="alert">{profileNotice}</p>}
                    <div className="record-form-actions"><button type="button" onClick={() => { profileRequest.next(); setProfileEditing(false); setProfileStatus("ready"); setProfileNotice(""); }}>取消</button><button type="submit" disabled={profileStatus === "saving"}>{profileStatus === "saving" ? "保存中…" : "保存健康档案"}</button></div>
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
                      {healthProfile?.legacyCommonTriggers?.length ? <p className="record-notice"><strong>历史诱因待迁移</strong><span>{healthProfile.legacyCommonTriggers.join("、")} 是旧版档案字段，暂不作为患者自述或当前投影；请重新填写过敏原记录确认。</span></p> : null}
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
                    <section className="health-record-card medication-card">
                      <div className="record-card-title"><span>药</span><div><h3>用药记录</h3><small>记录时间、药物名称、剂量和实际用量</small></div><button type="button" onClick={() => beginMedication()}>新增记录</button></div>
                      {medicationEditing && (
                        <form className="medication-form" onSubmit={submitMedication}>
                          <label>使用时间<input type="datetime-local" value={medicationDraft.takenAt} onChange={(event) => setMedicationDraft((current) => ({ ...current, takenAt: event.target.value }))} /></label>
                          <label>药物名称<input value={medicationDraft.medicationName} onChange={(event) => setMedicationDraft((current) => ({ ...current, medicationName: event.target.value }))} placeholder="例如：氯雷他定" /></label>
                          <div className="medication-inline"><label>剂量<input value={medicationDraft.dosageValue} disabled={medicationDraft.dosageUnknown} onChange={(event) => setMedicationDraft((current) => ({ ...current, dosageValue: event.target.value }))} placeholder="例如：10" /></label><label>单位<input value={medicationDraft.dosageUnit} disabled={medicationDraft.dosageUnknown} onChange={(event) => setMedicationDraft((current) => ({ ...current, dosageUnit: event.target.value }))} placeholder="mg、片…" /></label></div>
                          <label className="checkbox-line"><input type="checkbox" checked={medicationDraft.dosageUnknown} onChange={(event) => setMedicationDraft((current) => ({ ...current, dosageUnknown: event.target.checked }))} />剂量不详</label>
                          <label>实际用量情况<textarea value={medicationDraft.actualUseDescription} disabled={medicationDraft.actualUseUnknown} onChange={(event) => setMedicationDraft((current) => ({ ...current, actualUseDescription: event.target.value }))} placeholder="例如：按医嘱服用一次，未记录具体用量" /></label>
                          <label className="checkbox-line"><input type="checkbox" checked={medicationDraft.actualUseUnknown} onChange={(event) => setMedicationDraft((current) => ({ ...current, actualUseUnknown: event.target.checked }))} />实际用量不详</label>
                          {medicationNotice && <p className={`form-validation ${medicationStatus === "error" ? "error-text" : ""}`} role="status">{medicationNotice}</p>}
                          <div className="record-form-actions"><button type="button" disabled={medicationStatus === "saving"} onClick={() => { medicationRequest.next(); setMedicationCreateKey(null); setMedicationEditing(false); }}>取消</button><button type="submit" disabled={medicationStatus === "saving"}>{medicationStatus === "saving" ? "保存中…" : editingMedicationId ? "保存修改" : "保存记录"}</button></div>
                        </form>
                      )}
                      {medications.length > 0 ? <div className="medication-history">{medications.map((record) => <article key={record.id}><time>{new Date(record.takenAt).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })}</time><strong>{record.medicationName}</strong><span>{record.dosage.status === "known" ? `${record.dosage.value} ${record.dosage.unit}` : "剂量不详"}</span><small>{record.actualUse.status === "known" ? record.actualUse.description : "实际用量不详"}</small><div><button type="button" onClick={() => beginMedication(record)}>编辑</button><button type="button" onClick={() => removeMedication(record)} disabled={medicationStatus === "saving"}>删除</button></div></article>)}</div> : <p className="record-empty">暂无已保存的用药记录。</p>}
                    </section>
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
                  <div><span>关联症状日期</span><strong>{displayDate(exposureDraft.date)}</strong><small>{symptomsByDate.has(exposureDraft.date) ? "已有服务端症状记录" : "暂无真实症状记录"}</small></div>
                  <button type="button" onClick={() => openSymptomDate(exposureDraft.date)}>查看当天症状</button>
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

                <p className="profile-disclaimer">未完成服务端身份认证时不会保存健康历史；已保存的记录仅供本人回顾，不能替代门诊诊断。</p>
              </div>
            )}
          </div>

          <nav className="bottom-nav" aria-label="主要功能">
            <button className={tab === "home" ? "active" : ""} onClick={() => navigateTo("home")}><span className="nav-glyph nav-home">⌂</span>首页</button>
            <button className={tab === "chat" ? "active" : ""} onClick={() => navigateTo("chat")}><span className="nav-glyph nav-chat">◌</span>问助手</button>
            <button className="nav-add" onClick={() => { navigateTo("assessment"); openSymptomDate(localDateValue()); }} aria-label="新增症状记录"><span>＋</span></button>
            <button className={tab === "assessment" || tab === "allergenRecord" ? "active" : ""} onClick={() => navigateTo("assessment")}><span className="nav-glyph nav-calendar">▦</span>日历</button>
            <button className={tab === "profile" || tab === "healthProfile" ? "active" : ""} onClick={() => navigateTo("profile")}><span className="nav-glyph nav-profile">人</span>我的</button>
          </nav>

          {entryOpen && (
            <div className="entry-sheet-backdrop" role="dialog" aria-modal="true" aria-label="填写所选日期症状量表">
              <div className="entry-sheet">
                <div className="sheet-handle" />
                <div className="sheet-title"><div><small>症状记录 · {displayDate(selectedDate)}</small><h2>记录当天的症状</h2><p>保存后会与同一天的过敏原患者自述记录关联展示，不自动判断因果。</p></div><button onClick={() => setEntryOpen(false)}>×</button></div>
                <div className="scale-card">
                  {scaleItems.map((item, itemIndex) => (
                    <div className="scale-row" key={item}>
                      <div><strong>{item}</strong><span>{scores[itemIndex] === null ? "未选择" : ["无", "轻微", "明显", "严重"][scores[itemIndex]!]}</span></div>
                      <div className="score-options">
                        {[0, 1, 2, 3].map((score) => (
                          <button className={scores[itemIndex] === score ? "selected" : ""} key={score} onClick={() => setScores((current) => current.map((value, index) => index === itemIndex ? score : value))}>{score}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div className="sheet-score"><span>TNSS 总分</span><strong>{scoresComplete ? totalScore : "--"}<i>/12</i></strong><b>{scoresComplete ? symptomLabel(totalScore) : "请完成评分"}</b></div>
                  <p className="assessment-disclaimer">量表结果仅供参考，最终方案请以门诊诊断为准。</p>
                  <div className="sheet-allergen-link">
                    <div><strong>当天过敏原暴露</strong><small>与本次症状使用同一记录日期</small></div>
                    <button type="button" onClick={() => startAllergenRecord(selectedDate)}>去记录</button>
                    <p>过敏原仅为患者自述，不自动判定医学因果。</p>
                  </div>
                  {symptomNotice && <p className={`assessment-disclaimer ${symptomStatus === "error" ? "error-text" : ""}`} role="status">{symptomNotice}</p>}
                  <button className="submit-assessment" onClick={submitSymptom} disabled={symptomStatus === "saving" || !scoresComplete}>
                    {symptomStatus === "saving" ? "保存中…" : "保存症状记录"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

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
