"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { SYNDROME_OPTIONS } from "@/lib/agent/syndromes";
import "./admin.css";

type Section = "overview" | "article" | "video" | "knowledge" | "plan" | "media" | "audit";
type Item = { id: string; type: string; title: string; category: string; summary: string; body: string; source: string; status: string; version: number; mediaId?: string | null; metadata: { risks?: string; contraindications?: string; syndromeCodes?: string[]; methodCode?: string | null }; updatedAt: string };
type Media = { id: string; filename: string; kind: string; byteSize: number; status: string };

const navigation: Array<{ key: Section; label: string; icon: string }> = [
  { key: "overview", label: "工作台", icon: "◈" },
  { key: "article", label: "科普文章", icon: "文" },
  { key: "video", label: "视频内容", icon: "播" },
  { key: "knowledge", label: "智能体知识库", icon: "知" },
  { key: "plan", label: "调理方案", icon: "方" },
  { key: "media", label: "素材库", icon: "图" },
  { key: "audit", label: "操作记录", icon: "录" },
];

async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "请求失败");
  return payload;
}

export default function AdminPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [section, setSection] = useState<Section>("overview");
  const [items, setItems] = useState<Item[]>([]);
  const [media, setMedia] = useState<Media[]>([]);
  const [auditItems, setAuditItems] = useState<Array<Record<string, string>>>([]);
  const [dashboard, setDashboard] = useState<Record<string, unknown>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!authenticated) return;
    try {
      const [contentPayload, mediaPayload, dashboardPayload] = await Promise.all([
        api("/api/admin/content"), api("/api/admin/uploads"), api("/api/admin/dashboard"),
      ]);
      setItems(contentPayload.items as Item[]);
      setMedia(mediaPayload.items as Media[]);
      setDashboard(dashboardPayload);
      if (section === "audit") setAuditItems((await api("/api/admin/audit")).items as Array<Record<string, string>>);
    } catch (error) { setMessage(error instanceof Error ? error.message : "加载失败"); }
  }

  useEffect(() => { api("/api/admin/auth/session").then(() => setAuthenticated(true)).catch(() => setAuthenticated(false)); }, []);
  useEffect(() => {
    if (!authenticated) return;
    Promise.all([api("/api/admin/content"), api("/api/admin/uploads"), api("/api/admin/dashboard")])
      .then(([contentPayload, mediaPayload, dashboardPayload]) => {
        setItems(contentPayload.items as Item[]);
        setMedia(mediaPayload.items as Media[]);
        setDashboard(dashboardPayload);
        if (section === "audit") api("/api/admin/audit").then((payload) => setAuditItems(payload.items as Array<Record<string, string>>));
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "加载失败"));
  }, [authenticated, section]);

  if (authenticated === null) return <main className="admin-loading">正在验证管理员身份…</main>;
  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;

  const current = navigation.find((item) => item.key === section)!;
  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand"><span>抗</span><div><strong>抗敏先锋</strong><small>鼻健康内容中心</small></div></div>
        <nav aria-label="管理后台导航">{navigation.map((item) => <button key={item.key} className={section === item.key ? "active" : ""} onClick={() => setSection(item.key)}><i>{item.icon}</i>{item.label}</button>)}</nav>
        <div className="admin-account"><span>A</span><div><strong>管理员</strong><small>内容可直接发布</small></div><button aria-label="退出登录" onClick={async () => { await api("/api/admin/auth/logout", { method: "POST" }); setAuthenticated(false); }}>退出</button></div>
      </aside>
      <section className="admin-main">
        <header className="admin-topbar"><div><small>抗敏先锋 / {current.label}</small><h1>{current.label}</h1></div><Link href="/discover" target="_blank">查看用户端 ↗</Link></header>
        {message && <div className="admin-toast" role="status"><span>{message}</span><button onClick={() => setMessage("")}>×</button></div>}
        {section === "overview" && <Overview dashboard={dashboard} items={items} />}
        {(["article", "video", "knowledge", "plan"] as Section[]).includes(section) && <ContentManager type={section} items={items.filter((item) => item.type === section)} media={media} busy={busy} onBusy={setBusy} onMessage={setMessage} onReload={load} />}
        {section === "media" && <MediaManager media={media} onMessage={setMessage} onReload={load} />}
        {section === "audit" && <AuditTable items={auditItems} />}
      </section>
    </main>
  );
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    try { await api("/api/admin/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) }); onSuccess(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); } finally { setBusy(false); }
  }
  return <main className="admin-login"><section><div className="login-mark">抗</div><small>抗敏先锋 · 鼻健康管理</small><h1>登录管理后台</h1><p>管理科普内容、知识资料与调理方案</p><form onSubmit={submit}><label>管理员账号<input name="username" autoComplete="username" required placeholder="请输入账号" /></label><label>密码<input name="password" type="password" autoComplete="current-password" required placeholder="请输入密码" /></label>{error && <div className="login-error" role="alert">{error}</div>}<button disabled={busy}>{busy ? "正在登录…" : "登录"}</button></form><footer>管理操作将记录完整审计日志</footer></section></main>;
}

function Overview({ dashboard, items }: { dashboard: Record<string, unknown>; items: Item[] }) {
  const published = items.filter((item) => item.status === "published").length;
  const drafts = items.filter((item) => item.status === "draft").length;
  const failed = items.filter((item) => item.status === "index_failed").length;
  return <div className="admin-overview"><section className="welcome-card"><div><small>今日内容工作台</small><h2>内容清晰，健康指导更安心</h2><p>统一管理已审核的科普、知识来源与调理操作，发布后立即同步到用户端。</p></div><span>鼻<br />健康</span></section><section className="stat-grid"><article><i className="green">↑</i><small>已发布内容</small><strong>{published}</strong><p>用户端可见</p></article><article><i className="amber">稿</i><small>待完善草稿</small><strong>{drafts}</strong><p>不会对外展示</p></article><article><i className="red">异</i><small>索引异常</small><strong>{failed}</strong><p>需检查资源后重试</p></article><article><i className="blue">站</i><small>站内消息</small><strong>{String((dashboard.messages as { count?: number } | undefined)?.count ?? 0)}</strong><p>已向用户公告</p></article></section><section className="recent-card"><div className="card-heading"><div><h2>最近更新</h2><p>最后编辑的内容与当前状态</p></div></div><ContentTable items={items.slice(0, 6)} onAction={undefined} /></section></div>;
}

function ContentManager({ type, items, media, busy, onBusy, onMessage, onReload }: { type: Section; items: Item[]; media: Media[]; busy: boolean; onBusy(value: boolean): void; onMessage(value: string): void; onReload(): Promise<void> }) {
  const [showForm, setShowForm] = useState(false);
  const labels: Record<string, string> = { article: "科普文章", video: "视频", knowledge: "知识资料", plan: "调理方案" };
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); onBusy(true);
    const form = new FormData(event.currentTarget);
    const payload = { type, title: form.get("title"), category: form.get("category"), summary: form.get("summary"), body: form.get("body"), source: form.get("source"), mediaId: form.get("mediaId"), metadata: { risks: form.get("risks"), contraindications: form.get("contraindications"), syndromeCodes: form.getAll("syndromeCodes"), methodCode: form.get("methodCode") } };
    try {
      const created = await api("/api/admin/content", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(payload) });
      if (type === "plan") {
        await api("/api/admin/steps", { method: "POST", headers: { "content-type": "application/json", "If-Match": String(created.version ?? 1) }, body: JSON.stringify({ planId: created.id, position: 1, title: form.get("stepTitle"), instruction: form.get("stepInstruction"), mediaId: form.get("stepMediaId") }) });
      }
      onMessage(`${labels[type]}\u5df2\u4fdd\u5b58\u4e3a\u8349\u7a3f`); setShowForm(false); await onReload();
    }
    catch (error) { onMessage(error instanceof Error ? error.message : "保存失败"); } finally { onBusy(false); }
  }
  async function action(id: string, actionName: string) {
    try {
      const item = items.find((candidate) => candidate.id === id);
      if (!item) throw new Error("内容已不在当前列表，请刷新");
      const headers = { "content-type": "application/json", "if-match": `"${item.version}"` };
      if (type === "knowledge" && actionName === "index") await api("/api/admin/knowledge/retry", { method: "POST", headers, body: JSON.stringify({ id }) });
      else await api("/api/admin/content", { method: "PATCH", headers, body: JSON.stringify({ id, action: actionName, notify: actionName === "publish" && (type === "article" || type === "video") }) });
      onMessage(actionName === "publish" ? "已发布并同步到用户端" : actionName === "index" ? "知识索引已完成" : "内容已下架"); await onReload();
    } catch (error) { onMessage(error instanceof Error ? error.message : "操作失败"); }
  }
    return <section className="manager-card"><div className="manager-heading"><div><h2>{labels[type]}管理</h2><p>草稿不会对外展示，发布后才进入用户端；正式健康内容必须经临床审核。</p></div><button className="primary" onClick={() => setShowForm(!showForm)}>+ 新建{labels[type]}</button></div>{showForm && <form className="content-form" onSubmit={create}><div className="form-grid"><label>标题<input name="title" required maxLength={160} /></label><label>分类<input name="category" placeholder="例如：日常护理" /></label></div><label>摘要<textarea name="summary" rows={2} /></label>{type !== "video" && <label>{type === "knowledge" ? "可检索文本" : "正文"}<textarea name="body" rows={6} required /></label>}<label>来源或依据<input name="source" /></label>{type !== "article" && <label>关联素材<select name="mediaId"><option value="">暂不关联</option>{media.filter((asset) => type !== "video" || asset.kind === "video").map((asset) => <option key={asset.id} value={asset.id}>{asset.filename}</option>)}</select></label>}{type === "plan" && <><label>康复方法<select name="methodCode" required><option value="">请选择受控方法</option><option value="nose_three_line_ginger_scrape">鼻三线姜刮（不等同于普通刮痧）</option><option value="finger_pressure_yingxiang">指腹擦迎香</option><option value="acupoint_massage">穴位按摩</option><option value="ear_acupressure">耳穴压豆</option><option value="moxa_or_blow_dazhui">艾灸/电吹风吹大椎、风池</option></select></label><div className="form-grid"><label>风险提示<textarea name="risks" rows={3} required /></label><label>禁忌事项<textarea name="contraindications" rows={3} required /></label></div><fieldset><legend>适用证型</legend>{SYNDROME_OPTIONS.map(({ code, label }) => <label key={code}><input type="checkbox" name="syndromeCodes" value={code} />{label}</label>)}</fieldset><div className="form-grid"><label>首个步骤标题<input name="stepTitle" required /></label><label>步骤视频<select name="stepMediaId"><option value="">无</option>{media.filter((asset) => asset.kind === "video").map((asset) => <option key={asset.id} value={asset.id}>{asset.filename}</option>)}</select></label></div><label>首个步骤说明<textarea name="stepInstruction" rows={3} required /></label></>}<div className="form-actions"><button type="button" onClick={() => setShowForm(false)}>取消</button><button className="primary" disabled={busy}>保存草稿</button></div></form>}<ContentTable items={items} onAction={action} secondaryAction={type === "knowledge" ? "index" : undefined} /></section>;
}

function ContentTable({ items, onAction, secondaryAction }: { items: Item[]; onAction?: (id: string, action: string) => void; secondaryAction?: string }) {
  if (items.length === 0) return <div className="empty-state"><span>◌</span><strong>还没有内容</strong><p>新建后将在这里统一管理。</p></div>;
  return <div className="table-wrap"><table><thead><tr><th>内容</th><th>分类</th><th>状态</th><th>版本</th><th>更新时间</th>{onAction && <th>操作</th>}</tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><small>{item.summary || item.source || "暂无摘要"}</small></td><td>{item.category}</td><td><span className={`status ${item.status}`}>{({ draft: "草稿", published: "已发布", offline: "已下架", indexing: "索引中", index_failed: "索引失败" } as Record<string, string>)[item.status] || item.status}</span></td><td>v{item.version}</td><td>{new Date(item.updatedAt).toLocaleString("zh-CN")}</td>{onAction && <td><div className="row-actions">{secondaryAction && item.status !== "published" && <button onClick={() => onAction(item.id, secondaryAction)}>建立索引</button>}{item.status !== "published" && <button onClick={() => onAction(item.id, "publish")}>发布</button>}{item.status === "published" && <button onClick={() => onAction(item.id, "offline")}>下架</button>}</div></td>}</tr>)}</tbody></table></div>;
}

function MediaManager({ media, onMessage, onReload }: { media: Media[]; onMessage(value: string): void; onReload(): Promise<void> }) {
  async function upload(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api("/api/admin/uploads", { method: "POST", body: form }); onMessage("素材上传成功"); event.currentTarget.reset(); await onReload(); } catch (error) { onMessage(error instanceof Error ? error.message : "上传失败"); } }
  return <section className="manager-card"><div className="manager-heading"><div><h2>素材库</h2><p>图片、视频和知识来源文件安全存储于对象存储。</p></div><form className="upload-form" onSubmit={upload}><input name="file" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,application/pdf,text/plain,text/markdown" required /><button className="primary">上传素材</button></form></div><div className="media-grid">{media.map((asset) => <article key={asset.id}><span>{asset.kind === "video" ? "▶" : asset.kind === "image" ? "图" : "文"}</span><div><strong>{asset.filename}</strong><small>{(asset.byteSize / 1024 / 1024).toFixed(2)} MB · {asset.status === "ready" ? "可用" : "已下架"}</small></div></article>)}</div>{media.length === 0 && <div className="empty-state"><span>图</span><strong>暂无素材</strong><p>上传后可与视频、知识和方案绑定。</p></div>}</section>;
}

function AuditTable({ items }: { items: Array<Record<string, string>> }) { return <section className="manager-card"><div className="manager-heading"><div><h2>操作记录</h2><p>关键写操作的不可省略追踪记录。</p></div></div><div className="timeline">{items.map((item) => <article key={item.id}><i /><div><strong>{item.actor} · {item.action}</strong><p>{item.entity_type} / {item.entity_id}</p><small>{new Date(item.created_at).toLocaleString("zh-CN")}</small></div></article>)}</div>{items.length === 0 && <div className="empty-state"><span>录</span><strong>暂无操作记录</strong></div>}</section>; }
