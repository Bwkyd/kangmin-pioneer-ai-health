"use client";

import Link from "next/link";
import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { CLINICAL_CANDIDATE_DEFINITIONS, clinicalCandidateLabel } from "@/lib/admin/clinical-candidates";
import { NOSE_THREE_LINE_GINGER_ROUTES, REHAB_METHOD_DEFINITIONS, REHAB_POINT_GROUP_DEFINITIONS } from "@/lib/agent/rehab-methods";
import { SYNDROME_OPTIONS } from "@/lib/agent/syndromes";
import { VIDEO_TOPIC_LABELS, type VideoTopicType } from "@/lib/content/video-topics";
import "./admin.css";

type Section = "overview" | "article" | "video" | "knowledge" | "plan" | "media" | "audit";
type Item = { id: string; type: string; title: string; category: string; summary: string; body: string; source: string; status: string; version: number; mediaId?: string | null; clinicalCandidateKind?: string | null; clinicalChangeDiff?: string; clinicalReviewStatus?: "pending_review" | "approved" | "rejected"; metadata: { risks?: string; contraindications?: string; syndromeCodes?: string[]; methodCode?: string | null; methodLabel?: string | null; routes?: Array<{ code: string; label: string; points: string[] }>; pointGroups?: Array<{ code: string; label: string; methodCode: string; points: string[]; relation?: string }>; syndromePlanMappings?: Array<{ syndromeCode: string; status: "mapped" | "no_plan" | "missing"; planId?: string; planVersion?: number }>; videoTopicType?: VideoTopicType | null }; clinicalApproval?: { contentVersion: number; approver?: string | null; approvedAt?: string | null } | null; clinicalReview?: { status: "pending_review" | "approved" | "rejected"; candidateKind?: string | null; changeDiff?: string; reviewer?: string | null; reviewedAt?: string | null } | null; updatedAt: string };
type Media = { id: string; filename: string; kind: string; byteSize: number; status: string };
type ArticleImportPreview = { filename: string; format: "doc" | "docx" | "pdf"; title: string; source: string; text: string; characterCount: number };

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
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  if (raw) {
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      if (!response.ok) throw new Error(response.status === 413 ? "上传文件超过服务限制，请选择更小的文件" : `请求失败（${response.status}）`);
      throw new Error("服务响应格式无效");
    }
  }
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `请求失败（${response.status}）`);
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
        <div className="admin-account"><span>A</span><div><strong>管理员</strong><small>内容需临床审核后发布</small></div><button aria-label="退出登录" onClick={async () => { await api("/api/admin/auth/logout", { method: "POST" }); setAuthenticated(false); }}>退出</button></div>
      </aside>
      <section className="admin-main">
        <header className="admin-topbar"><div><small>抗敏先锋 / {current.label}</small><h1>{current.label}</h1></div><Link href="/discover" target="_blank">查看用户端 ↗</Link></header>
        {message && <div className="admin-toast" role="status"><span>{message}</span><button onClick={() => setMessage("")}>×</button></div>}
        {section === "overview" && <Overview dashboard={dashboard} items={items} />}
        {(["article", "video", "knowledge", "plan"] as Section[]).includes(section) && <ContentManager key={section} type={section} items={items.filter((item) => item.type === section)} media={media} busy={busy} onBusy={setBusy} onMessage={setMessage} onReload={load} />}
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
  return <div className="admin-overview"><section className="welcome-card"><div><small>今日内容工作台</small><h2>内容清晰，健康指导更安心</h2><p>统一管理已审核的科普、知识来源与调理操作，发布后立即同步到用户端。</p></div><span>鼻<br />健康</span></section><section className="stat-grid"><article><i className="green">↑</i><small>已发布内容</small><strong>{published}</strong><p>用户端可见</p></article><article><i className="amber">稿</i><small>待完善草稿</small><strong>{drafts}</strong><p>不会对外展示</p></article><article><i className="red">异</i><small>索引异常</small><strong>{failed}</strong><p>需检查资源后重试</p></article><article><i className="blue">站</i><small>站内消息</small><strong>{String((dashboard.messages as { count?: number } | undefined)?.count ?? 0)}</strong><p>已向用户公告</p></article></section><section className="recent-card"><div className="card-heading"><div><h2>最近更新</h2><p>最后编辑的内容与当前状态</p></div></div><ContentTable items={items.slice(0, 6)} onAction={undefined} busy={false} /></section></div>;
}

function ContentManager({ type, items, media, busy, onBusy, onMessage, onReload }: { type: Section; items: Item[]; media: Media[]; busy: boolean; onBusy(value: boolean): void; onMessage(value: string): void; onReload(): Promise<void> }) {
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [articleImageId, setArticleImageId] = useState<string | null>(null);
  const [articleImageName, setArticleImageName] = useState("");
  const [articleImagePreview, setArticleImagePreview] = useState<string | null>(null);
  const [articleImageBusy, setArticleImageBusy] = useState(false);
  const [articleImportPreview, setArticleImportPreview] = useState<ArticleImportPreview | null>(null);
  const [articleImportConfirmed, setArticleImportConfirmed] = useState(false);
  const [articleImportBusy, setArticleImportBusy] = useState(false);
  const [articleImportRevision, setArticleImportRevision] = useState(0);
  const [createIdempotencyKey, setCreateIdempotencyKey] = useState<string | null>(null);
  const [candidateKind, setCandidateKind] = useState("");
  const labels: Record<string, string> = { article: "科普文章", video: "视频", knowledge: "知识资料", plan: "调理方案" };

  function setArticleImage(item: Item | null) {
    const imageId = type === "article" ? item?.mediaId ?? null : null;
    const image = imageId ? media.find((asset) => asset.id === imageId && asset.kind === "image") : null;
    setArticleImageId(imageId);
    setArticleImageName(image?.filename ?? (imageId ? "已关联图片" : ""));
    setArticleImagePreview(imageId ? `/api/admin/uploads/${encodeURIComponent(imageId)}` : null);
  }

  function clearArticleImport() {
    setArticleImportPreview(null);
    setArticleImportConfirmed(false);
    setArticleImportRevision((value) => value + 1);
  }

  async function importArticle(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || type !== "article") return;
    setArticleImportBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const preview = await api("/api/admin/article-import", { method: "POST", body: form }) as unknown as ArticleImportPreview;
      if (!preview || typeof preview.text !== "string" || !preview.text.trim()) throw new Error("导入预览为空，不能进入文章草稿");
      setArticleImportPreview(preview);
      setArticleImportConfirmed(false);
      setArticleImportRevision((value) => value + 1);
      onMessage("已生成导入预览，请核对内容并确认后再保存草稿");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "文章导入失败");
    } finally {
      setArticleImportBusy(false);
    }
  }

  function confirmArticleImport() {
    if (!articleImportPreview) return;
    setArticleImportConfirmed(true);
    setArticleImportRevision((value) => value + 1);
    onMessage("已确认导入预览，正文已填入文章草稿；仍需临床审核后才能发布");
  }

  async function uploadArticleImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || type !== "article") return;
    const previous = { id: articleImageId, name: articleImageName, preview: articleImagePreview };
    const localPreview = URL.createObjectURL(file);
    setArticleImageBusy(true);
    setArticleImagePreview(localPreview);
    try {
      const form = new FormData();
      form.set("file", file);
      const uploaded = await api("/api/admin/uploads", { method: "POST", body: form });
      if (typeof uploaded.id !== "string" || typeof uploaded.filename !== "string") throw new Error("上传响应无效");
      URL.revokeObjectURL(localPreview);
      setArticleImageId(uploaded.id);
      setArticleImageName(uploaded.filename);
      setArticleImagePreview(`/api/admin/uploads/${encodeURIComponent(uploaded.id)}`);
      onMessage("文章图片上传成功，保存文章后才会关联");
    } catch (error) {
      URL.revokeObjectURL(localPreview);
      setArticleImageId(previous.id);
      setArticleImageName(previous.name);
      setArticleImagePreview(previous.preview);
      onMessage(error instanceof Error ? error.message : "文章图片上传失败，正文未变更");
    } finally {
      setArticleImageBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); onBusy(true);
    if (type === "article" && articleImportPreview && !articleImportConfirmed) {
      onMessage("请先预览并确认导入内容，才能保存文章草稿");
      onBusy(false);
      return;
    }
    const form = new FormData(event.currentTarget);
    const payload = { type, title: form.get("title"), category: form.get("category"), summary: form.get("summary"), body: form.get("body"), source: form.get("source"), candidateKind: form.get("candidateKind"), changeDiff: form.get("changeDiff"), mediaId: type === "article" ? articleImageId : form.get("mediaId"), metadata: { risks: form.get("risks"), contraindications: form.get("contraindications"), syndromeCodes: form.getAll("syndromeCodes"), methodCode: form.get("methodCode"), routeCodes: form.getAll("routeCodes"), pointGroupCodes: form.getAll("pointGroupCodes"), syndromePlanMappings: form.get("syndromePlanMappings"), topicType: form.get("videoTopicType") } };
    try {
      if (editingItem) {
        await api("/api/admin/content", { method: "PATCH", headers: { "content-type": "application/json", "If-Match": `\"${editingItem.version}\"` }, body: JSON.stringify({ ...payload, id: editingItem.id, action: "update" }) });
        onMessage(`${labels[type]}已保存为新草稿版本`);
      } else {
        const idempotencyKey = createIdempotencyKey ?? crypto.randomUUID();
        if (!createIdempotencyKey) setCreateIdempotencyKey(idempotencyKey);
        const created = await api("/api/admin/content", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify(payload) });
        if (type === "plan") {
          await api("/api/admin/steps", { method: "POST", headers: { "content-type": "application/json", "If-Match": String(created.version ?? 1) }, body: JSON.stringify({ planId: created.id, position: 1, title: form.get("stepTitle"), instruction: form.get("stepInstruction"), mediaId: form.get("stepMediaId") }) });
        }
        onMessage(`${labels[type]}已保存为草稿`);
      }
      setShowForm(false); setEditingItem(null); setCreateIdempotencyKey(null); clearArticleImport(); await onReload();
    }
    catch (error) { onMessage(error instanceof Error ? error.message : "保存失败"); } finally { onBusy(false); }
  }
  function openCreate() { setArticleImage(null); clearArticleImport(); setCreateIdempotencyKey(crypto.randomUUID()); setCandidateKind(""); setEditingItem(null); setShowForm(true); }
  function openEdit(item: Item) { setArticleImage(item); clearArticleImport(); setCreateIdempotencyKey(null); setCandidateKind(item.clinicalCandidateKind ?? item.clinicalReview?.candidateKind ?? ""); setEditingItem(item); setShowForm(true); }
  async function action(id: string, actionName: string) {
    onBusy(true);
    try {
      const item = items.find((candidate) => candidate.id === id);
      if (!item) throw new Error("内容已不在当前列表，请刷新");
      const headers = { "content-type": "application/json", "if-match": `"${item.version}"` };
      if (actionName === "approve") await api("/api/admin/clinical-approvals", { method: "POST", headers, body: JSON.stringify({ contentId: id }) });
      else if (type === "knowledge" && actionName === "index") await api("/api/admin/knowledge/retry", { method: "POST", headers, body: JSON.stringify({ id }) });
      else await api("/api/admin/content", { method: "PATCH", headers, body: JSON.stringify({ id, action: actionName, notify: actionName === "publish" && (type === "article" || type === "video") }) });
      onMessage(actionName === "approve" ? "已完成当前版本临床审核" : actionName === "publish" ? "已发布并同步到用户端" : actionName === "index" ? "知识索引已完成" : "内容已下架"); await onReload();
    } catch (error) { onMessage(error instanceof Error ? error.message : "操作失败"); } finally { onBusy(false); }
  }
  return (
    <section className="manager-card">
      <div className="manager-heading"><div><h2>{labels[type]}管理</h2><p>草稿不会对外展示，发布后才进入用户端；正式健康内容必须经临床审核。</p></div><button className="primary" onClick={showForm ? () => { setShowForm(false); setEditingItem(null); } : openCreate} disabled={busy}>+ 新建{labels[type]}</button></div>
      {showForm && <form key={`${editingItem?.id ?? "new"}-${articleImportRevision}`} className="content-form" onSubmit={save}>
        <div className="form-grid"><label>标题<input name="title" required maxLength={160} defaultValue={articleImportConfirmed && articleImportPreview ? articleImportPreview.title : editingItem?.title ?? ""} /></label><label>分类<input name="category" defaultValue={editingItem?.category ?? ""} placeholder={type === "video" ? "例如：鼻塞、流清涕或肺气虚寒型" : "例如：日常护理"} /></label></div>
        {type === "video" && <label>分类维度<select name="videoTopicType" defaultValue={editingItem?.metadata.videoTopicType ?? ""}><option value="">请选择分类维度</option>{(Object.entries(VIDEO_TOPIC_LABELS) as Array<[VideoTopicType, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
        <label>摘要<textarea name="summary" rows={2} defaultValue={editingItem?.summary ?? ""} /></label>
        {type === "article" && <section className="article-import-field" aria-label="导入 Word 或 PDF 文章">
          <div className="article-import-heading"><div><strong>导入 Word / PDF</strong><small>支持 .doc、.docx、.pdf，单文件最大 30 MB；扫描 PDF 不自动 OCR。</small></div>{articleImportBusy && <span role="status">转换预览中…</span>}</div>
          <label className="article-import-control">选择文章文件<input type="file" accept=".doc,.docx,.pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf" onChange={importArticle} disabled={busy || articleImportBusy} /></label>
          {articleImportPreview && <div className="article-import-preview"><div className="article-import-preview-heading"><div><strong>{articleImportPreview.filename}</strong><small>{articleImportPreview.format.toUpperCase()} · {articleImportPreview.characterCount} 字 · 预览不会直接发布</small></div>{articleImportConfirmed ? <span className="article-import-confirmed">已确认预览</span> : <button type="button" className="primary" onClick={confirmArticleImport} disabled={busy || articleImportBusy}>确认预览并填入正文</button>}</div><pre>{articleImportPreview.text}</pre><button type="button" onClick={clearArticleImport} disabled={busy || articleImportBusy}>取消本次导入</button></div>}
        </section>}
        {type !== "video" && <label>{type === "knowledge" ? "可检索文本" : "正文"}<textarea name="body" rows={6} required={type === "article" || type === "knowledge"} defaultValue={articleImportConfirmed && articleImportPreview ? articleImportPreview.text : editingItem?.body ?? ""} /></label>}
        {type === "article" && <section className="article-image-field" aria-label="文章图片">
          <div className="article-image-heading"><div><strong>文章图片</strong><small>可作为封面或正文配图；上传失败时不会清空正文或已有图片。</small></div>{articleImageBusy && <span role="status">上传中…</span>}</div>
          {articleImagePreview ? <div className="article-image-preview"><img src={articleImagePreview} alt={articleImageName || "文章图片预览"} /><div><strong>{articleImageName || "已关联图片"}</strong><small>保存文章后保留当前关联</small><button type="button" onClick={() => { setArticleImageId(null); setArticleImageName(""); setArticleImagePreview(null); }} disabled={busy || articleImageBusy}>移除图片</button></div></div> : <p className="article-image-empty">尚未关联图片；可以先保存无图草稿。</p>}
          <label className="image-upload-control">选择图片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={uploadArticleImage} disabled={busy || articleImageBusy} /></label>
        </section>}
        <label>来源或依据<input name="source" defaultValue={articleImportConfirmed && articleImportPreview ? articleImportPreview.source : editingItem?.source ?? ""} /></label>
        <div className="form-grid"><label>临床候选类别<select name="candidateKind" value={candidateKind} onChange={(event) => setCandidateKind(event.currentTarget.value)}><option value="">基础内容（不单独标记候选）</option>{CLINICAL_CANDIDATE_DEFINITIONS.map(({ code, label }) => <option key={code} value={code}>{label}</option>)}</select></label><label>本版本变更差异<textarea name="changeDiff" rows={2} defaultValue={editingItem?.clinicalChangeDiff ?? editingItem?.clinicalReview?.changeDiff ?? ""} placeholder="候选内容需说明相对上一版本的新增、删除或调整" /></label></div>
        <p className="form-help">临床候选会独立进入待审核状态；选择候选类别后，必须填写来源和本版本变更差异，审核前不会进入用户端、提示词或知识检索。</p>
        {type === "plan" && candidateKind === "base_syndrome_mapping" && <label>五种证型基础方案映射（JSON）<textarea name="syndromePlanMappings" rows={8} required defaultValue={editingItem?.metadata.syndromePlanMappings ? JSON.stringify(editingItem.metadata.syndromePlanMappings, null, 2) : ""} placeholder={'[{"syndromeCode":"LUNG_QI_COLD","status":"missing"},{"syndromeCode":"SPLEEN_QI_DEF","status":"missing"},{"syndromeCode":"KIDNEY_YANG_DEF","status":"missing"},{"syndromeCode":"LUNG_HEAT","status":"missing"},{"syndromeCode":"MIXED_COLD_HEAT","status":"missing"}]'} /><span className="form-help">每个证型必须单独记录 mapped、no_plan 或 missing；mapped 还要填写 planId 和 planVersion。不要用默认值替代客户资料。</span></label>}
        {type !== "article" && <label>关联素材<select name="mediaId" defaultValue={editingItem?.mediaId ?? ""}><option value="">暂不关联</option>{media.filter((asset) => type !== "video" || asset.kind === "video").map((asset) => <option key={asset.id} value={asset.id}>{asset.filename}</option>)}</select></label>}
        {(type === "video" || type === "plan") && <><label>康复方法<select name="methodCode" required={type === "plan"} defaultValue={editingItem?.metadata.methodCode ?? ""}><option value="">{type === "plan" ? "请选择受控方法" : "非操作类视频可不选择"}</option>{REHAB_METHOD_DEFINITIONS.map(({ code, label, note }) => <option key={code} value={code}>{note ? `${label}（${note}）` : label}</option>)}</select></label><fieldset><legend>路线/穴位结构（鼻三线姜刮候选）</legend><p className="form-help">只保留结构化路线；未完成临床审核前不能发布到用户端。</p>{NOSE_THREE_LINE_GINGER_ROUTES.map((route) => <label key={route.code}><input type="checkbox" name="routeCodes" value={route.code} defaultChecked={editingItem?.metadata.routes?.some((item) => item.code === route.code) ?? false} />{route.label}（{route.points.join("、")}）</label>)}</fieldset><fieldset><legend>穴位结构（临床候选）</legend><p className="form-help">仅保存客户已明确列出的穴位和顺序；服务端会校验方法类型，未审核前不进入用户端。</p>{REHAB_POINT_GROUP_DEFINITIONS.map((group) => <label key={group.code}><input type="checkbox" name="pointGroupCodes" value={group.code} defaultChecked={editingItem?.metadata.pointGroups?.some((item) => item.code === group.code) ?? false} />{group.label}{group.relation ? `（${group.relation}）` : ""}</label>)}</fieldset>{type === "plan" && <><div className="form-grid"><label>风险提示<textarea name="risks" rows={3} required defaultValue={editingItem?.metadata.risks ?? ""} /></label><label>禁忌事项<textarea name="contraindications" rows={3} required defaultValue={editingItem?.metadata.contraindications ?? ""} /></label></div><fieldset><legend>适用证型</legend>{SYNDROME_OPTIONS.map(({ code, label }) => <label key={code}><input type="checkbox" name="syndromeCodes" value={code} defaultChecked={editingItem?.metadata.syndromeCodes?.includes(code) ?? false} />{label}</label>)}</fieldset>{!editingItem && <><div className="form-grid"><label>首个步骤标题<input name="stepTitle" required /></label><label>步骤视频<select name="stepMediaId"><option value="">无</option>{media.filter((asset) => asset.kind === "video").map((asset) => <option key={asset.id} value={asset.id}>{asset.filename}</option>)}</select></label></div><label>首个步骤说明<textarea name="stepInstruction" rows={3} required /></label></>}</>}</>}
        <div className="form-actions"><button type="button" onClick={() => { setShowForm(false); setEditingItem(null); setCreateIdempotencyKey(null); clearArticleImport(); }} disabled={busy || articleImageBusy || articleImportBusy}>取消</button><button className="primary" disabled={busy || articleImageBusy || articleImportBusy}>{editingItem ? "保存修改" : "保存草稿"}</button></div>
      </form>}
      <ContentTable items={items} onAction={action} onEdit={openEdit} secondaryAction={type === "knowledge" ? "index" : undefined} busy={busy} />
    </section>
  );
}

function ContentTable({ items, onAction, onEdit, secondaryAction, busy }: { items: Item[]; onAction?: (id: string, action: string) => void; onEdit?: (item: Item) => void; secondaryAction?: string; busy: boolean }) {
  if (items.length === 0) return <div className="empty-state"><span>◌</span><strong>还没有内容</strong><p>新建后将在这里统一管理。</p></div>;
  return <div className="table-wrap"><table><thead><tr><th>内容</th><th>分类</th><th>状态</th><th>版本</th><th>更新时间</th>{(onAction || onEdit) && <th>操作</th>}</tr></thead><tbody>{items.map((item) => { const reviewStatus = item.clinicalReview?.status ?? item.clinicalReviewStatus ?? (item.clinicalApproval ? "approved" : "pending_review"); return <tr key={item.id}><td><strong>{item.title}</strong><small>{item.summary || item.source || "暂无摘要"}</small>{item.clinicalCandidateKind && <small>候选：{clinicalCandidateLabel(item.clinicalCandidateKind) ?? item.clinicalCandidateKind}</small>}</td><td>{item.category}</td><td><span className={`status ${item.status}`}>{({ draft: "草稿", published: "已发布", offline: "已下架", indexing: "索引中", index_failed: "索引失败" } as Record<string, string>)[item.status] || item.status}</span><small>{reviewStatus === "approved" ? `临床已审核 v${item.version}` : reviewStatus === "rejected" ? "临床审核未通过" : "待临床审核"}</small></td><td>v{item.version}</td><td>{new Date(item.updatedAt).toLocaleString("zh-CN")}</td>{(onAction || onEdit) && <td><div className="row-actions">{onEdit && ["draft", "offline", "index_failed"].includes(item.status) && <button type="button" disabled={busy} onClick={() => onEdit(item)}>编辑</button>}{secondaryAction && ["draft", "index_failed", "indexing"].includes(item.status) && onAction && <button type="button" disabled={busy} onClick={() => onAction(item.id, secondaryAction)}>{item.status === "indexing" ? "重试索引" : "建立索引"}</button>}{onAction && item.status !== "published" && item.status !== "indexing" && reviewStatus !== "approved" && <button type="button" disabled={busy} onClick={() => onAction(item.id, "approve")}>临床审核</button>}{onAction && item.status !== "published" && item.status !== "indexing" && <button type="button" disabled={busy} onClick={() => onAction(item.id, "publish")}>发布</button>}{onAction && item.status === "published" && <button type="button" disabled={busy} onClick={() => onAction(item.id, "offline")}>下架</button>}</div></td>}</tr>; })}</tbody></table></div>;
}

function MediaManager({ media, onMessage, onReload }: { media: Media[]; onMessage(value: string): void; onReload(): Promise<void> }) {
  async function upload(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api("/api/admin/uploads", { method: "POST", body: form }); onMessage("素材上传成功"); event.currentTarget.reset(); await onReload(); } catch (error) { onMessage(error instanceof Error ? error.message : "上传失败"); } }
  return <section className="manager-card"><div className="manager-heading"><div><h2>素材库</h2><p>图片、视频和知识来源文件安全存储于对象存储。</p></div><form className="upload-form" onSubmit={upload}><input name="file" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,application/pdf,text/plain,text/markdown" required /><button className="primary">上传素材</button></form></div><div className="media-grid">{media.map((asset) => <article key={asset.id}><span>{asset.kind === "video" ? "▶" : asset.kind === "image" ? "图" : "文"}</span><div><strong>{asset.filename}</strong><small>{(asset.byteSize / 1024 / 1024).toFixed(2)} MB · {asset.status === "ready" ? "可用" : "已下架"}</small></div></article>)}</div>{media.length === 0 && <div className="empty-state"><span>图</span><strong>暂无素材</strong><p>上传后可与视频、知识和方案绑定。</p></div>}</section>;
}

function AuditTable({ items }: { items: Array<Record<string, string>> }) { return <section className="manager-card"><div className="manager-heading"><div><h2>操作记录</h2><p>关键写操作的不可省略追踪记录。</p></div></div><div className="timeline">{items.map((item) => <article key={item.id}><i /><div><strong>{item.actor} · {item.action}</strong><p>{item.entity_type} / {item.entity_id}</p><small>{new Date(item.created_at).toLocaleString("zh-CN")}</small></div></article>)}</div>{items.length === 0 && <div className="empty-state"><span>录</span><strong>暂无操作记录</strong></div>}</section>; }
