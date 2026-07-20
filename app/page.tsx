"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type Message =
  | { id: number; role: "ai" | "user"; kind: "text"; text: string }
  | { id: number; role: "ai"; kind: "thinking" };

const symptomOptions = [
  "鼻塞、打喷嚏、流清鼻涕",
  "晚上鼻塞，睡眠受影响",
  "鼻涕黄稠，还有咽部不适",
];

const durationOptions = [
  "最近 3 天出现",
  "反复半年，换季加重",
  "已经持续两年以上",
];

const warningOptions = [
  "以上情况都没有",
  "有高热或明显头痛",
  "呼吸不畅或胸闷",
];

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 1,
      role: "ai",
      kind: "text",
      text: "你好，我是小岐，你的鼻炎居家调理助手。接下来我会通过几轮对话了解你的情况，再为你匹配适合的调理建议。",
    },
  ]);
  const [step, setStep] = useState(0);
  const [input, setInput] = useState("");
  const [videoOpen, setVideoOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, step, videoOpen]);

  const addExchange = (answer: string, reply: string, nextStep: number) => {
    setMessages((current) => [
      ...current,
      { id: Date.now(), role: "user", kind: "text", text: answer },
      { id: Date.now() + 1, role: "ai", kind: "thinking" },
    ]);
    window.setTimeout(() => {
      setMessages((current) => [
        ...current.filter((message) => message.kind !== "thinking"),
        { id: Date.now() + 2, role: "ai", kind: "text", text: reply },
      ]);
      setStep(nextStep);
    }, 650);
  };

  const startConsultation = () => {
    setStarted(true);
    addExchange(
      "开始了解",
      "好的。你现在最明显的不舒服是什么？可以直接描述，也可以点击下面的常见情况。",
      1,
    );
  };

  const selectSymptom = (answer: string) => {
    addExchange(
      answer,
      "了解了。这个情况大概持续多久了？是否在换季、遇冷空气或早晨起床时更明显？",
      2,
    );
  };

  const selectDuration = (answer: string) => {
    addExchange(
      answer,
      "收到，我再确认一下安全情况：目前有没有高热、明显头痛、面部肿痛、呼吸困难，或者鼻出血不止？",
      3,
    );
  };

  const selectWarning = (answer: string) => {
    if (answer !== warningOptions[0]) {
      addExchange(
        answer,
        "这种情况不适合只在家调理。建议尽快前往耳鼻喉科就诊；如果出现呼吸困难，请立即寻求急诊帮助。",
        5,
      );
      return;
    }

    addExchange(
      answer,
      "信息已经收集完成。从目前描述看，没有发现需要立即就医的危险信号。我为你匹配了一套温和的 3 日居家调理建议。",
      4,
    );
  };

  const sendCustom = (event: FormEvent) => {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;
    setInput("");
    if (step === 1) selectSymptom(value);
    else if (step === 2) selectDuration(value);
    else if (step === 3) selectWarning(value);
    else {
      addExchange(
        value,
        "已记录你的反馈。调理期间如果症状加重或出现新的不适，请暂停操作并及时就医。",
        step,
      );
    }
  };

  const resetDemo = () => {
    setMessages([
      {
        id: Date.now(),
        role: "ai",
        kind: "text",
        text: "你好，我是小岐，你的鼻炎居家调理助手。接下来我会通过几轮对话了解你的情况，再为你匹配适合的调理建议。",
      },
    ]);
    setStep(0);
    setStarted(false);
    setVideoOpen(false);
  };

  const activeOptions =
    step === 1
      ? symptomOptions
      : step === 2
        ? durationOptions
        : step === 3
          ? warningOptions
          : [];

  return (
    <main className="demo-shell">
      <section className="intro-panel" aria-labelledby="demo-title">
        <div className="brand-mark">岐</div>
        <p className="eyebrow">中医鼻炎 · AI 居家调理</p>
        <h1 id="demo-title">不是填表，<br />是一次有温度的对话。</h1>
        <p className="intro-copy">
          AI 逐步了解症状、识别风险，再从已有内容库中匹配调理方案和操作视频。
        </p>
        <div className="journey">
          <div><span>01</span><strong>自然对话</strong><small>边聊边了解情况</small></div>
          <div><span>02</span><strong>安全筛查</strong><small>异常情况及时就医</small></div>
          <div><span>03</span><strong>调理随访</strong><small>方案、视频与反馈</small></div>
        </div>
        <p className="demo-note">客户概念演示 · 页面内容不构成医疗诊断</p>
      </section>

      <section className="phone-wrap" aria-label="鼻炎调理助手对话演示">
        <div className="phone">
          <header className="phone-header">
            <button className="icon-button" aria-label="返回">‹</button>
            <div className="assistant-title">
              <div className="avatar">岐<i /></div>
              <div><strong>小岐调理助手</strong><span>AI 在线 · 隐私保护中</span></div>
            </div>
            <button className="icon-button dots" onClick={resetDemo} aria-label="重新开始演示">•••</button>
          </header>

          <div className="safety-banner">
            <span>+</span>
            <p><strong>先筛查风险，再推荐调理</strong><small>急重症请及时前往正规医疗机构</small></p>
          </div>

          <div className="chat" aria-live="polite">
            <div className="time-label">今天 14:20</div>
            {messages.map((message) =>
              message.kind === "thinking" ? (
                <div className="message-row ai-row" key={message.id}>
                  <div className="mini-avatar">岐</div>
                  <div className="bubble ai-bubble typing"><b /><b /><b /></div>
                </div>
              ) : (
                <div className={`message-row ${message.role}-row`} key={message.id}>
                  {message.role === "ai" && <div className="mini-avatar">岐</div>}
                  <div className={`bubble ${message.role}-bubble`}>{message.text}</div>
                </div>
              ),
            )}

            {step === 0 && !started && (
              <button className="start-card" onClick={startConsultation}>
                <span className="start-icon">聊</span>
                <span><strong>开始了解我的情况</strong><small>约 2 分钟 · 随时可以退出</small></span>
                <b>›</b>
              </button>
            )}

            {activeOptions.length > 0 && (
              <div className="quick-options">
                {activeOptions.map((option) => (
                  <button
                    key={option}
                    onClick={() => {
                      if (step === 1) selectSymptom(option);
                      if (step === 2) selectDuration(option);
                      if (step === 3) selectWarning(option);
                    }}
                  >
                    {option}<span>›</span>
                  </button>
                ))}
              </div>
            )}

            {step === 4 && (
              <>
                <article className="result-card">
                  <div className="result-head">
                    <div><small>AI 辅助分析</small><h2>换季敏感 · 肺卫不固倾向</h2></div>
                    <span>已匹配</span>
                  </div>
                  <p>根据你描述的清涕、喷嚏和换季反复表现，建议先以温和疏通、日常防护为主。</p>
                  <div className="evidence">
                    <span>清水样鼻涕</span><span>换季加重</span><span>反复半年</span>
                  </div>
                  <div className="result-foot"><span>安全提示</span> 本结果仅作健康调理参考，不替代医生诊断。</div>
                </article>

                <article className="plan-card">
                  <div className="plan-title"><span>今日</span><div><small>第 1 天 · 约 8 分钟</small><h2>温通鼻窍舒缓练习</h2></div></div>
                  <ol>
                    <li><i>1</i><span><strong>热敷鼻周</strong><small>温热毛巾轻敷 2 分钟</small></span></li>
                    <li><i>2</i><span><strong>迎香穴轻按</strong><small>跟随视频，左右各 1 分钟</small></span></li>
                    <li><i>3</i><span><strong>记录感受</strong><small>完成后反馈鼻塞变化</small></span></li>
                  </ol>
                </article>

                <button className="video-card" onClick={() => setVideoOpen(true)}>
                  <div className="video-cover">
                    <span className="sun" />
                    <div className="face-demo"><i /><b /></div>
                    <span className="play">▶</span>
                    <small>02:36</small>
                  </div>
                  <div className="video-copy"><small>配套跟练视频</small><strong>迎香穴舒缓手法</strong><span>专业老师示范 · 可反复观看</span></div>
                </button>

                <div className="message-row ai-row">
                  <div className="mini-avatar">岐</div>
                  <div className="bubble ai-bubble">建议每天早晚各练习一次。明天我会回来问问你的鼻塞有没有改善。</div>
                </div>
                <button className="feedback-button">完成今日调理</button>
              </>
            )}
            <div ref={chatEnd} />
          </div>

          <form className="composer" onSubmit={sendCustom}>
            <button type="button" aria-label="语音输入">⌁</button>
            <input
              aria-label="输入症状或反馈"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={step >= 4 ? "输入今天的感受…" : "描述你的情况…"}
            />
            <button className="send-button" type="submit" aria-label="发送">↑</button>
          </form>
        </div>
      </section>

      {videoOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="操作视频演示">
          <div className="video-modal">
            <button onClick={() => setVideoOpen(false)} aria-label="关闭视频">×</button>
            <div className="video-stage">
              <div className="video-person"><span>请用食指轻按鼻翼两侧</span><i /><b /></div>
              <div className="video-progress"><span /></div>
            </div>
            <h2>迎香穴舒缓手法</h2>
            <p>操作力度以轻柔、舒适为准。如有明显疼痛或不适，请立即停止。</p>
          </div>
        </div>
      )}
    </main>
  );
}
