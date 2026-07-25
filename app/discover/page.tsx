"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import "./discover.css";

type Content = { id: string; title: string; category: string; summary: string; body?: string; mediaId?: string; methodCode?: string | null; risks?: string; contraindications?: string; steps?: Array<{ title: string; instruction: string }> };
type Message = { id: string; title: string; body: string; isRead: number };

export default function DiscoverPage() {
  const [tab, setTab] = useState<"article" | "video" | "plan" | "messages">("article");
  const [items, setItems] = useState<Content[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Content | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      setNotice("");
      setLoading(true);
      setItems([]);
    });
    if (tab === "messages") {
      fetch("/api/messages", { signal: controller.signal }).then((response) => { if (!response.ok) throw new Error("messages"); return response.json(); }).then((payload) => setMessages(payload.items || [])).catch((error: unknown) => { if (error instanceof DOMException && error.name === "AbortError") return; setMessages([]); setNotice("消息暂时无法加载，请稍后重试"); }).finally(() => setLoading(false));
      return () => controller.abort();
    }
    fetch(`/api/content?type=${tab}`, { signal: controller.signal }).then(async (response) => {
      const payload = await response.json().catch(() => null) as { items?: Content[]; error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || (response.status === 404 ? "该类内容正在临床审核" : "内容服务暂时不可用"));
      setItems(Array.isArray(payload?.items) ? payload.items : []);
    }).catch((error: unknown) => { if (error instanceof DOMException && error.name === "AbortError") return; setItems([]); setNotice(error instanceof Error ? error.message : "内容暂时无法加载，请稍后重试"); }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [tab]);

  async function openContent(item: Content) {
    if (tab === "video") return;
    try {
      const response = await fetch(`/api/content?type=${tab}&id=${encodeURIComponent(item.id)}`);
      if (!response.ok) throw new Error("内容详情暂时无法加载");
      const payload = await response.json() as { item?: Content };
      setSelected(payload.item ?? item);
    } catch { setNotice("内容详情暂时无法加载，请稍后重试"); }
  }

  async function markRead(id: string) {
    await fetch("/api/messages", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    setMessages((current) => current.map((item) => item.id === id ? { ...item, isRead: 1 } : item));
  }

  const visibleCount = tab === "messages" ? messages.length : items.length;
  return <main className="discover-shell"><header><Link href="/">‹ 返回首页</Link><div><small>抗敏先锋</small><h1>学一学</h1><p>来自后台已发布、可追溯的鼻健康内容</p></div></header><nav><button className={tab === "article" ? "active" : ""} onClick={() => setTab("article")}>科普文章</button><button className={tab === "video" ? "active" : ""} onClick={() => setTab("video")}>操作视频</button><button className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>调理方案</button><button className={tab === "messages" ? "active" : ""} onClick={() => setTab("messages")}>站内消息</button></nav>{notice && <p className="discover-notice" role="alert">{notice}</p>}{loading && <p className="discover-notice">正在读取已审核内容…</p>}<section className="discover-grid">{tab === "messages" ? messages.map((item) => <article className={item.isRead ? "read" : ""} key={item.id} onClick={() => markRead(item.id)}><i>{item.isRead ? "已读" : "新"}</i><h2>{item.title}</h2><p>{item.body}</p></article>) : items.map((item) => <article key={item.id} onClick={() => openContent(item)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") void openContent(item); }}><i>{item.category}</i><h2>{item.title}</h2><p>{item.summary || "点击查看内容详情"}</p>{tab === "video" && item.mediaId && <video controls preload="metadata" src={`/api/media/${item.mediaId}`} />}</article>)}</section>{!loading && !notice && visibleCount === 0 && <section className="discover-empty"><span>鼻</span><h2>暂无已发布内容</h2><p>管理员发布并完成审核后将出现在这里。</p></section>}{selected && <div className="discover-detail" role="dialog" aria-modal="true"><article><button type="button" onClick={() => setSelected(null)} aria-label="关闭内容详情">×</button><i>{selected.category}</i><h2>{selected.title}</h2>{selected.steps && selected.steps.length > 0 ? <ol>{selected.steps.map((step) => <li key={step.title}><strong>{step.title}</strong><p>{step.instruction}</p></li>)}</ol> : <p>{selected.body || selected.summary || "暂无正文"}</p>}{selected.risks && <p><strong>风险提示：</strong>{selected.risks}</p>}{selected.contraindications && <p><strong>禁忌事项：</strong>{selected.contraindications}</p>}</article></div>}<footer>内容仅供健康科普与居家管理参考，不能替代门诊诊断。</footer></main>;
}
