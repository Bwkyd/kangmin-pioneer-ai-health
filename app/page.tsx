"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type Tab = "home" | "chat" | "assessment" | "articles";
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
      "换季时温度、湿度和空气中的过敏原都会变化，鼻黏膜更容易受到刺激。资料库建议把症状出现时间、诱因和严重程度一起记录，便于后续判断变化规律。",
    source: "知识库依据：《抗敏先锋小程序》· 辨证症状项 / 症状评估日历",
  },
  {
    question: "鼻塞在家先怎么护理？",
    answer:
      "可以先减少冷空气和刺激物暴露，保持室内适宜湿度，并记录鼻塞对睡眠的影响。资料中的穴位、艾灸等操作需要经过适用性判断，儿童或操作不熟悉时应由专业人员指导。",
    source: "知识库依据：《抗敏先锋小程序》· 鼻塞方案 / 注意事项",
  },
  {
    question: "调理效果多久记录一次？",
    answer:
      "建议每天固定时间做一次简短记录，重点观察喷嚏、流涕、鼻塞和鼻痒。系统可用 TNSS 形成趋势，每周再回顾一次生活影响。",
    source: "知识库依据：《抗敏先锋小程序》· VAS、TNSS、RQLQ 量表",
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

export default function Home() {
  const [tab, setTab] = useState<Tab>("home");
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 1,
      role: "ai",
      kind: "text",
      text: "你好，我是小岐。你可以直接描述不舒服，也可以问我鼻炎护理方面的问题。我的回答会优先参考已审核的抗敏知识库。",
    },
  ]);
  const [step, setStep] = useState(0);
  const [input, setInput] = useState("");
  const [videoOpen, setVideoOpen] = useState(false);
  const [articleOpen, setArticleOpen] = useState<number | null>(null);
  const [scores, setScores] = useState([2, 2, 2, 1]);
  const [assessmentDone, setAssessmentDone] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLCanvasElement>(null);

  const totalScore = scores.reduce((sum, score) => sum + score, 0);

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

    const values = assessmentDone ? [10, 9, 8, 7, totalScore] : [10, 9, 8, 7, 6];
    const labels = ["7/16", "7/17", "7/18", "7/19", "今天"];
    const pad = { left: 24, right: 18, top: 18, bottom: 28 };
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;

    context.strokeStyle = "#dce8e2";
    context.lineWidth = 1;
    [0, 4, 8, 12].forEach((value) => {
      const y = pad.top + chartH - (value / 12) * chartH;
      context.beginPath();
      context.moveTo(pad.left, y);
      context.lineTo(width - pad.right, y);
      context.stroke();
    });

    const points = values.map((value, index) => ({
      x: pad.left + (chartW / 4) * index,
      y: pad.top + chartH - (value / 12) * chartH,
    }));
    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.strokeStyle = "#1c7560";
    context.lineWidth = 3;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.stroke();

    points.forEach((point, index) => {
      context.beginPath();
      context.arc(point.x, point.y, index === 4 ? 5 : 3.5, 0, Math.PI * 2);
      context.fillStyle = index === 4 ? "#d98b43" : "#1c7560";
      context.fill();
    });
    context.font = '10px "PingFang SC", sans-serif';
    context.fillStyle = "#87968f";
    context.textAlign = "center";
    labels.forEach((label, index) => context.fillText(label, points[index].x, height - 8));
  }, [tab, assessmentDone, totalScore]);

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
      "信息已收集完成。目前未发现需要立即就医的危险信号。结合换季反复、清涕和喷嚏等描述，系统为你匹配了温和护理与每日评估建议。",
      4,
      "客户方案库 · 肺气虚寒倾向；已通过安全规则过滤高风险操作",
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
        "我已记录。为了避免资料不足时自由猜测，演示版会先检索已审核知识库；没有可靠依据的问题会建议咨询专业人员。",
        step,
        "当前回答策略 · 知识库优先 / 无依据不扩写",
      );
  };

  const resetDemo = () => {
    setMessages([
      {
        id: Date.now(),
        role: "ai",
        kind: "text",
        text: "你好，我是小岐。你可以直接描述不舒服，也可以问我鼻炎护理方面的问题。我的回答会优先参考已审核的抗敏知识库。",
      },
    ]);
    setStep(0);
    setAssessmentDone(false);
    setScores([2, 2, 2, 1]);
    setTab("home");
  };

  const activeOptions =
    step === 1 ? symptomOptions : step === 2 ? durationOptions : step === 3 ? warningOptions : [];

  const headerTitle =
    tab === "home" ? "抗敏先锋" : tab === "chat" ? "小岐知识助手" : tab === "assessment" ? "症状评估" : "鼻健康科普";

  return (
    <main className="demo-shell">
      <section className="intro-panel" aria-labelledby="demo-title">
        <div className="brand-mark">敏</div>
        <p className="eyebrow">抗敏先锋 · AI 鼻健康管理</p>
        <h1 id="demo-title">一边回答问题，<br />一边看见变化。</h1>
        <p className="intro-copy">
          把客户已有方案做成可检索的知识库，让 AI 有依据地回答；再用科普内容和症状趋势，陪伴患者持续管理。
        </p>
        <div className="journey four">
          <div><span>01</span><strong>AI 对话</strong><small>自然交流采集症状</small></div>
          <div><span>02</span><strong>知识库</strong><small>回答有来源可追溯</small></div>
          <div><span>03</span><strong>量表趋势</strong><small>记录每日症状变化</small></div>
          <div><span>04</span><strong>科普推送</strong><small>持续健康教育</small></div>
        </div>
        <p className="demo-note">客户概念演示 · 内容不构成医疗诊断或处方</p>
      </section>

      <section className="phone-wrap" aria-label="抗敏先锋小程序演示">
        <div className="phone">
          <header className="phone-header">
            <button className="icon-button" aria-label="返回">‹</button>
            <div className="assistant-title">
              <div className="avatar">{tab === "chat" ? "岐" : "敏"}<i /></div>
              <div><strong>{headerTitle}</strong><span>{tab === "chat" ? "知识库已连接 · 6 类方案" : "陪你记录每一次变化"}</span></div>
            </div>
            <button className="icon-button dots" onClick={resetDemo} aria-label="重新开始演示">•••</button>
          </header>

          <div className="app-body">
            {tab === "home" && (
              <div className="home-view">
                <section className="welcome-card">
                  <small>下午好</small>
                  <h2>今天鼻子感觉怎么样？</h2>
                  <p>用两分钟告诉小岐，获得有依据的护理建议。</p>
                  <button onClick={startConsultation}><span>和小岐聊一聊</span><b>→</b></button>
                </section>

                <section className="today-grid">
                  <button onClick={() => setTab("assessment")}>
                    <span className="feature-icon chart-icon">↘</span>
                    <small>今日待完成</small><strong>症状评估</strong><i>约 1 分钟</i>
                  </button>
                  <button onClick={() => askKnowledge(0)}>
                    <span className="feature-icon book-icon">知</span>
                    <small>知识库问答</small><strong>换季为何反复？</strong><i>点击问 AI</i>
                  </button>
                </section>

                <section className="mini-trend" onClick={() => setTab("assessment")}>
                  <div><small>近 5 日 TNSS</small><h3>症状正在缓解</h3></div>
                  <div className="sparkline" aria-hidden="true">
                    <i style={{ height: "84%" }} /><i style={{ height: "73%" }} /><i style={{ height: "64%" }} />
                    <i style={{ height: "55%" }} /><i className="active" style={{ height: "42%" }} />
                  </div>
                  <span>查看趋势 ›</span>
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
                  <p><strong>答案来自已审核知识库</strong><small>高风险操作只作风险提示，不直接生成指导</small></p>
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
                        <div className="result-head"><div><small>AI 辅助分析</small><h2>换季敏感 · 肺气虚寒倾向</h2></div><span>已匹配</span></div>
                        <p>建议先以日常防护、温和鼻部护理和连续记录为主。涉及艾灸、敷贴等操作，需专业人员评估后再进行。</p>
                        <div className="evidence"><span>清水样鼻涕</span><span>换季加重</span><span>反复半年</span></div>
                        <div className="result-foot"><span>资料来源</span> 客户方案库 · 肺气虚寒型</div>
                      </article>
                      <article className="plan-card">
                        <div className="plan-title"><span>今日</span><div><small>第 1 天 · 安全版</small><h2>鼻部舒缓与症状记录</h2></div></div>
                        <ol>
                          <li><i>1</i><span><strong>减少冷空气刺激</strong><small>外出佩戴口罩，留意温差</small></span></li>
                          <li><i>2</i><span><strong>观看护理示范</strong><small>轻柔操作，不追求疼痛或出痧</small></span></li>
                          <li><i>3</i><span><strong>完成 TNSS 量表</strong><small>记录喷嚏、流涕、鼻塞、鼻痒</small></span></li>
                        </ol>
                      </article>
                      <button className="video-card" onClick={() => setVideoOpen(true)}>
                        <div className="video-cover"><span className="sun" /><div className="face-demo"><i /><b /></div><span className="play">▶</span><small>02:36</small></div>
                        <div className="video-copy"><small>配套示范视频</small><strong>鼻周轻柔舒缓</strong><span>专业老师示范 · 不含侵入操作</span></div>
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
                <div className="assessment-intro">
                  <span>TNSS</span><div><small>每日症状评估</small><h2>回想过去 24 小时</h2><p>0 表示没有，3 表示非常明显</p></div>
                </div>
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
                  <button className="submit-assessment" onClick={() => setAssessmentDone(true)}>
                    {assessmentDone ? "已保存今日评估" : "生成今日结果"}
                  </button>
                </div>

                <article className={`score-result ${assessmentDone ? "visible" : ""}`}>
                  <div><small>今日 TNSS 总分</small><strong>{assessmentDone ? totalScore : "--"}<i>/12</i></strong><span>{assessmentDone ? (totalScore <= 4 ? "轻度" : totalScore <= 8 ? "中度" : "较明显") : "完成后显示"}</span></div>
                  <p>{assessmentDone ? "较 5 天前下降 3 分，症状总体呈缓解趋势。" : "坚持每日记录，才能更清楚地看见变化。"}</p>
                </article>

                <article className="trend-card">
                  <div className="trend-title"><div><small>近 5 日趋势</small><h3>TNSS 症状总分</h3></div><span>分数越低越好</span></div>
                  <canvas ref={chartRef} aria-label="近五日 TNSS 症状总分趋势图" />
                  <div className="chart-legend"><span><i />症状总分</span><small>0 无症状 · 12 分最明显</small></div>
                </article>
              </div>
            )}

            {tab === "articles" && (
              <div className="articles-view">
                <div className="articles-hero"><small>本周健康专栏</small><h2>懂一点，鼻子舒服一点</h2><p>内容由团队撰写、审核后推送，AI 也可引用文章回答问题。</p></div>
                <div className="topic-chips"><button className="active">为你推荐</button><button>日常防护</button><button>亲子健康</button></div>
                <div className="article-list">
                  {articles.map((article, index) => (
                    <button key={article.title} onClick={() => setArticleOpen(index)}>
                      <div className={`article-thumb ${article.tone}`}><span>{index === 0 ? "护" : index === 1 ? "安" : "童"}</span></div>
                      <div><small>{article.tag} · {article.read}</small><strong>{article.title}</strong><p>{article.summary}</p></div>
                    </button>
                  ))}
                </div>
                <div className="push-note"><span>铃</span><div><strong>每周两篇，温和提醒</strong><small>可由运营人员在后台编辑、审核和定时推送</small></div></div>
              </div>
            )}
          </div>

          <nav className="bottom-nav" aria-label="主要功能">
            <button className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}><span>⌂</span>首页</button>
            <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}><span>◌</span>问助手</button>
            <button className={tab === "assessment" ? "active" : ""} onClick={() => setTab("assessment")}><span>⌁</span>评估</button>
            <button className={tab === "articles" ? "active" : ""} onClick={() => setTab("articles")}><span>□</span>科普</button>
          </nav>
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
            <footer>内容由抗敏先锋健康团队审核 · 2026-07-20</footer>
          </article>
        </div>
      )}
    </main>
  );
}
