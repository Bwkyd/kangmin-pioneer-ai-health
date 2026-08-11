import { useEffect, useState } from "react";

import { command } from "./command-client";

interface PatientMessage {
  id: string;
  title: string;
  body: string;
  summary: string | null;
  publishedAt: string;
  readAt: string | null;
}

export default function MessagesView() {
  const [items, setItems] = useState<PatientMessage[]>([]);
  const [selected, setSelected] = useState<PatientMessage | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    command<{ items: PatientMessage[] }>("browse message list")
      .then((data) => { if (active) { setItems(data.items); setStatus("ready"); } })
      .catch((reason) => { if (active) { setError(reason instanceof Error ? reason.message : "消息读取失败"); setStatus("error"); } });
    return () => { active = false; };
  }, []);

  async function open(item: PatientMessage) {
    setSelected(item);
    if (item.readAt !== null) return;
    try {
      const read = await command<PatientMessage>("browse message read", { id: item.id });
      setSelected(read);
      setItems((current) => current.map((entry) => entry.id === read.id ? read : entry));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "已读状态保存失败");
    }
  }

  if (status === "loading") return <div className="message-state">正在读取站内消息…</div>;
  if (status === "error") return <div className="message-state error">{error}</div>;
  if (selected !== null) return <div className="messages-view"><button className="message-back" onClick={() => setSelected(null)}>‹ 返回消息列表</button><article className="message-detail"><small>{new Date(selected.publishedAt).toLocaleString("zh-CN")}</small><h2>{selected.title}</h2>{selected.summary && <p className="message-summary">{selected.summary}</p>}<div>{selected.body}</div></article>{error && <p className="message-error">{error}</p>}</div>;
  return <div className="messages-view"><div className="messages-heading"><small>应用内通知</small><h2>消息中心</h2><p>这里展示运营人员发布的鼻健康提醒。</p></div>{items.length === 0 ? <div className="message-state">暂无消息</div> : <div className="message-list">{items.map((item) => <button key={item.id} onClick={() => void open(item)}><span className={item.readAt === null ? "message-dot" : "message-dot read"}/><div><strong>{item.title}</strong><p>{item.summary || item.body}</p><small>{new Date(item.publishedAt).toLocaleDateString("zh-CN")}</small></div><b>›</b></button>)}</div>}</div>;
}
