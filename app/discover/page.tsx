"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import "./discover.css";

type Content = { id: string; title: string; category: string; summary: string; mediaId?: string };
type Message = { id: string; title: string; body: string; isRead: number };

export default function DiscoverPage() {
  const [tab, setTab] = useState<"article" | "video" | "plan" | "messages">("article");
  const [items, setItems] = useState<Content[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (tab === "messages") {
      fetch("/api/messages", { headers: { "x-user-id": "h5-demo-user" } }).then((response) => response.json()).then((payload) => setMessages(payload.items || [])).catch(() => setNotice("消息暂时无法加载"));
      return;
    }
    fetch(`/api/content?type=${tab}`).then((response) => response.json()).then((payload) => setItems(payload.items || [])).catch(() => setNotice("内容暂时无法加载"));
  }, [tab]);

  async function markRead(id: string) {
    await fetch("/api/messages", { method: "PATCH", headers: { "content-type": "application/json", "x-user-id": "h5-demo-user" }, body: JSON.stringify({ id }) });
    setMessages((current) => current.map((item) => item.id === id ? { ...item, isRead: 1 } : item));
  }

  return <main className="discover-shell"><header><Link href="/">‹ 返回首页</Link><div><small>抗敏先锋</small><h1>学一学</h1><p>来自后台已发布、可追溯的鼻健康内容</p></div></header><nav><button className={tab === "article" ? "active" : ""} onClick={() => setTab("article")}>科普文章</button><button className={tab === "video" ? "active" : ""} onClick={() => setTab("video")}>操作视频</button><button className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>调理方案</button><button className={tab === "messages" ? "active" : ""} onClick={() => setTab("messages")}>站内消息</button></nav>{notice && <p className="discover-notice">{notice}</p>}<section className="discover-grid">{tab === "messages" ? messages.map((item) => <article className={item.isRead ? "read" : ""} key={item.id} onClick={() => markRead(item.id)}><i>{item.isRead ? "已读" : "新"}</i><h2>{item.title}</h2><p>{item.body}</p></article>) : items.map((item) => <article key={item.id}><i>{item.category}</i><h2>{item.title}</h2><p>{item.summary || "点击查看内容详情"}</p>{tab === "video" && item.mediaId && <video controls preload="metadata" src={`/api/media/${item.mediaId}`} />}</article>)}</section>{((tab === "messages" ? messages : items).length === 0) && <section className="discover-empty"><span>鼻</span><h2>暂无已发布内容</h2><p>管理员发布后将自动出现在这里。</p></section>}<footer>内容仅供健康科普与居家管理参考，不能替代门诊诊断。</footer></main>;
}
