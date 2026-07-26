"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { filterVideoItems, normalizeVideoTopicType, uniqueVideoCategories, VIDEO_TOPIC_LABELS, VIDEO_TOPIC_TYPES, type VideoTopicFilter, type VideoTopicType } from "@/lib/content/video-topics";
import "./discover.css";

type Content = { id: string; title: string; category: string; summary: string; body?: string; mediaId?: string | null; topicType?: VideoTopicType; methodCode?: string | null; risks?: string; contraindications?: string; steps?: Array<{ title: string; instruction: string }> };
type Message = { id: string; title: string; body: string; isRead: number };

export default function DiscoverPage() {
  const [tab, setTab] = useState<"article" | "video" | "plan" | "messages">("article");
  const [items, setItems] = useState<Content[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Content | null>(null);
  const [videoTopic, setVideoTopic] = useState<VideoTopicFilter>("all");
  const [videoCategory, setVideoCategory] = useState("all");
  const contentRequest = useRef(0);

  useEffect(() => {
    void Promise.resolve().then(() => {
      const requestedTab = new URLSearchParams(window.location.search).get("type");
      if (requestedTab === "video") setTab("video");
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const requestVersion = contentRequest.current + 1;
    contentRequest.current = requestVersion;
    void Promise.resolve().then(() => {
      setSelected(null);
      if (tab !== "video") {
        setVideoTopic("all");
        setVideoCategory("all");
      }
      setNotice("");
      setLoading(true);
      setItems([]);
    });
    if (tab === "messages") {
      fetch("/api/messages", { signal: controller.signal }).then((response) => { if (!response.ok) throw new Error("messages"); return response.json(); }).then((payload) => { if (contentRequest.current === requestVersion) setMessages(payload.items || []); }).catch((error: unknown) => { if (error instanceof DOMException && error.name === "AbortError") return; if (contentRequest.current !== requestVersion) return; setMessages([]); setNotice("消息暂时无法加载，请稍后重试"); }).finally(() => { if (contentRequest.current === requestVersion) setLoading(false); });
      return () => controller.abort();
    }
    fetch(`/api/content?type=${tab}`, { signal: controller.signal }).then(async (response) => {
      const payload = await response.json().catch(() => null) as { items?: Content[]; error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || (response.status === 404 ? "该类内容正在临床审核" : "内容服务暂时不可用"));
      if (contentRequest.current === requestVersion) setItems(Array.isArray(payload?.items) ? payload.items : []);
    }).catch((error: unknown) => { if (error instanceof DOMException && error.name === "AbortError") return; if (contentRequest.current !== requestVersion) return; setItems([]); setNotice(error instanceof Error ? error.message : "内容暂时无法加载，请稍后重试"); }).finally(() => { if (contentRequest.current === requestVersion) setLoading(false); });
    return () => controller.abort();
  }, [tab]);

  async function openContent(item: Content) {
    const requestVersion = contentRequest.current + 1;
    contentRequest.current = requestVersion;
    try {
      const response = await fetch(`/api/content?type=${tab}&id=${encodeURIComponent(item.id)}`);
      if (!response.ok) throw new Error("内容详情暂时无法加载");
      const payload = await response.json() as { item?: Content };
      if (contentRequest.current !== requestVersion) return;
      setSelected(payload.item ?? item);
    } catch { if (contentRequest.current === requestVersion) setNotice("内容详情暂时无法加载，请稍后重试"); }
  }

  async function markRead(id: string) {
    await fetch("/api/messages", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    setMessages((current) => current.map((item) => item.id === id ? { ...item, isRead: 1 } : item));
  }

  const visibleItems = tab === "video" ? filterVideoItems(items, videoTopic, videoCategory) : items;
  const videoCategories = uniqueVideoCategories(items, videoTopic);
  const visibleCount = tab === "messages" ? messages.length : visibleItems.length;

  return <main className="discover-shell">
    <header><Link href="/">‹ 返回首页</Link><div><small>抗敏先锋</small><h1>学一学</h1><p>来自后台已发布、可追溯的鼻健康内容</p></div></header>
    <nav aria-label="内容类型"><button className={tab === "article" ? "active" : ""} onClick={() => setTab("article")}>科普文章</button><button className={tab === "video" ? "active" : ""} onClick={() => setTab("video")}>操作视频</button><button className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>调理方案</button><button className={tab === "messages" ? "active" : ""} onClick={() => setTab("messages")}>站内消息</button></nav>
    {tab === "video" && <section className="video-filters" aria-label="视频分类导航">
      <div className="video-filter-row"><strong>视频分类</strong>{(["all", ...VIDEO_TOPIC_TYPES] as VideoTopicFilter[]).map((topic) => <button type="button" key={topic} className={videoTopic === topic ? "active" : ""} aria-pressed={videoTopic === topic} onClick={() => { setVideoTopic(topic); setVideoCategory("all"); }}>{topic === "all" ? "全部视频" : VIDEO_TOPIC_LABELS[topic]}</button>)}</div>
      <div className="video-filter-row video-category-row"><strong>具体主题</strong><button type="button" className={videoCategory === "all" ? "active" : ""} aria-pressed={videoCategory === "all"} onClick={() => setVideoCategory("all")}>全部</button>{videoCategories.map((category) => <button type="button" key={category} className={videoCategory === category ? "active" : ""} aria-pressed={videoCategory === category} onClick={() => setVideoCategory(category)}>{category}</button>)}</div>
    </section>}
    {notice && <p className="discover-notice" role="alert">{notice}</p>}
    {loading && <p className="discover-notice">正在读取已审核内容…</p>}
    <section className="discover-grid">
      {tab === "messages" ? messages.map((item) => <article className={item.isRead ? "read" : ""} key={item.id} onClick={() => markRead(item.id)}><i>{item.isRead ? "已读" : "新"}</i><h2>{item.title}</h2><p>{item.body}</p></article>) : visibleItems.map((item) => <article key={item.id} onClick={() => void openContent(item)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") void openContent(item); }}><div className="discover-tags"><i>{tab === "video" ? VIDEO_TOPIC_LABELS[normalizeVideoTopicType(item.topicType)] : "已审核"}</i><i>{item.category || "未分类"}</i></div>{tab === "article" && item.mediaId && <img className="discover-card-image" src={`/api/media/${item.mediaId}`} alt={`${item.title}配图`} loading="lazy" onClick={(event) => event.stopPropagation()} />}<h2>{item.title}</h2><p>{item.summary || "点击查看内容详情"}</p>{tab === "video" && item.mediaId && <video controls preload="metadata" src={`/api/media/${item.mediaId}`} onClick={(event) => event.stopPropagation()} />}</article>)}
    </section>
    {!loading && !notice && visibleCount === 0 && <section className="discover-empty"><span>鼻</span><h2>{tab === "video" && (videoTopic !== "all" || videoCategory !== "all") ? "暂无符合条件的视频" : "暂无已发布内容"}</h2><p>{tab === "video" && (videoTopic !== "all" || videoCategory !== "all") ? "可以切换其它分类，或等待管理员发布并完成审核。" : "管理员发布并完成审核后将出现在这里。"}</p></section>}
    {selected && <div className="discover-detail" role="dialog" aria-modal="true"><article><button type="button" onClick={() => setSelected(null)} aria-label="关闭内容详情">×</button><div className="discover-tags"><i>{selected.topicType ? VIDEO_TOPIC_LABELS[normalizeVideoTopicType(selected.topicType)] : "已审核"}</i><i>{selected.category || "未分类"}</i></div><h2>{selected.title}</h2>{selected.mediaId && tab === "article" && <img className="discover-detail-image" src={`/api/media/${selected.mediaId}`} alt={`${selected.title}配图`} />}{selected.mediaId && tab === "video" && <video className="discover-detail-video" controls preload="metadata" src={`/api/media/${selected.mediaId}`} />}{selected.steps && selected.steps.length > 0 ? <ol>{selected.steps.map((step) => <li key={step.title}><strong>{step.title}</strong><p>{step.instruction}</p></li>)}</ol> : <p>{selected.body || selected.summary || "暂无正文"}</p>}{selected.risks && <p><strong>风险提示：</strong>{selected.risks}</p>}{selected.contraindications && <p><strong>禁忌事项：</strong>{selected.contraindications}</p>}</article></div>}
    <footer>内容仅供健康科普与居家管理参考，不能替代门诊诊断。</footer>
  </main>;
}
