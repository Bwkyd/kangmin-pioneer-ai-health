import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  AdminRequestError,
  adminCommand,
  login,
  logout,
  sessionStatus,
  uploadFile,
  type AdminSession
} from "./client";

type Section = "overview" | "article" | "video" | "message" | "knowledge" | "media";
type ContentKind = "article" | "video";

interface ContentItem {
  id: string;
  kind: ContentKind;
  title: string;
  category: string;
  summary: string;
  body: string;
  source: string;
  status: "draft" | "published" | "unpublished";
  revision: number;
  coverMediaId: string | null;
  mediaId: string | null;
  instructions: string;
  precautions: string;
  disclaimer: string;
  displayOrder: number;
  updatedAt: string;
}

interface MediaItem {
  id: string;
  filename: string;
  kind: string;
  sizeBytes: number;
  status: string;
  failureReason?: string | null;
}

interface KnowledgeItem {
  id: string;
  name: string;
  category?: string | null;
  source: string | null;
  description: string | null;
  status: "processing" | "indexed" | "enabled" | "disabled" | "index_failed";
  chunkCount: number;
  parseError: string | null;
  updatedAt: string;
}

interface MessageItem {
  id: string;
  title: string;
  body: string;
  summary: string | null;
  status: "draft" | "published" | "unpublished";
  revision: number;
  publishedAt: string | null;
  updatedAt: string;
}

interface CategoryItem { id: string; name: string; kind: string; status: string }
interface KnowledgeHit { knowledgeId: string; name: string; snippet: string }

const knowledgeStatusLabels: Record<KnowledgeItem["status"], string> = {
  processing: "待建索引",
  indexed: "已建索引",
  enabled: "已启用",
  disabled: "已停用",
  index_failed: "索引失败"
};

const navigation: Array<{ key: Section; label: string; icon: string }> = [
  { key: "overview", label: "工作台", icon: "◈" },
  { key: "article", label: "科普文章", icon: "文" },
  { key: "video", label: "视频内容", icon: "播" },
  { key: "message", label: "站内消息", icon: "信" },
  { key: "knowledge", label: "智能体知识库", icon: "知" },
  { key: "media", label: "素材库", icon: "图" }
];

function messageOf(error: unknown): string {
  if (error instanceof AdminRequestError) {
    if (error.code === "authentication_required") return "登录已失效，请重新登录";
    return error.message;
  }
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

export function AdminApp() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [section, setSection] = useState<Section>("overview");
  const [articles, setArticles] = useState<ContentItem[]>([]);
  const [videos, setVideos] = useState<ContentItem[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [articleData, videoData, messageData, mediaData, knowledgeData, categoryData] = await Promise.all([
      adminCommand<{ items: ContentItem[] }>("content article list"),
      adminCommand<{ items: ContentItem[] }>("content video list"),
      adminCommand<{ items: MessageItem[] }>("content message list"),
      adminCommand<{ items: MediaItem[] }>("content media list"),
      adminCommand<{ items: KnowledgeItem[] }>("agent knowledge list"),
      adminCommand<{ items: CategoryItem[] }>("content category list")
    ]);
    setArticles(articleData.items);
    setVideos(videoData.items);
    setMessages(messageData.items);
    setMedia(mediaData.items);
    setKnowledge(knowledgeData.items);
    setCategories(categoryData.items);
  }, []);

  useEffect(() => {
    sessionStatus()
      .then((value) => setSession(value.loggedIn ? value : null))
      .catch(() => setSession(null))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (session === null) return;
    refresh().catch((error) => setNotice(messageOf(error)));
  }, [refresh, session]);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      await action();
      await refresh();
      setNotice(success);
    } catch (error) {
      setNotice(messageOf(error));
      if (error instanceof AdminRequestError && error.code === "authentication_required") {
        setSession(null);
      }
    } finally {
      setBusy(false);
    }
  }

  if (checking) return <main className="admin-loading">正在验证管理员身份…</main>;
  if (session === null) return <Login onSuccess={setSession} />;

  const current = navigation.find((item) => item.key === section) ?? navigation[0]!;
  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand"><span>抗</span><div><strong>抗敏先锋</strong><small>鼻健康内容中心</small></div></div>
        <nav aria-label="管理后台导航">
          {navigation.map((item) => <button data-testid={`admin-nav-${item.key}`} key={item.key} className={section === item.key ? "active" : ""} onClick={() => setSection(item.key)}><i>{item.icon}</i>{item.label}</button>)}
        </nav>
        <div className="admin-account"><span>{session.username?.slice(0, 1).toUpperCase()}</span><div><strong>{session.username}</strong><small>{session.role === "owner" ? "主管理员" : "内容管理员"}</small></div><button onClick={() => void run(async () => { await logout(); setSession(null); }, "已安全退出")}>退出</button></div>
      </aside>
      <section className="admin-main">
        <header className="admin-topbar"><div><small>抗敏先锋 / {current.label}</small><h1>{current.label}</h1></div><a href="/" target="_blank" rel="noreferrer">查看用户端 ↗</a></header>
        {notice !== "" && <div className="admin-toast" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>}
        {section === "overview" && <Overview articles={articles} videos={videos} messages={messages} knowledge={knowledge} media={media} />}
        {section === "article" && <ContentManager kind="article" items={articles} media={media} categories={categories} busy={busy} run={run} />}
        {section === "video" && <ContentManager kind="video" items={videos} media={media} categories={categories} busy={busy} run={run} />}
        {section === "message" && <MessageManager items={messages} busy={busy} run={run} />}
        {section === "knowledge" && <KnowledgeManager items={knowledge} busy={busy} run={run} />}
        {section === "media" && <MediaManager items={media} busy={busy} run={run} />}
      </section>
    </main>
  );
}

function Login({ onSuccess }: { onSuccess: (session: AdminSession) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try { onSuccess(await login(username, password)); }
    catch (reason) { setError(messageOf(reason)); }
    finally { setBusy(false); }
  }
  return <main className="admin-login"><section><div className="login-mark">抗</div><small>抗敏先锋 · 鼻健康内容中心</small><h1>管理后台</h1><p>登录后管理客户可见的文章、视频和智能体知识资料。</p><form onSubmit={(event) => void submit(event)}><label>管理员账号<input data-testid="admin-username" autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label><label>密码<input data-testid="admin-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error !== "" && <div className="form-error" role="alert">{error}</div>}<button data-testid="admin-login" disabled={busy}>{busy ? "正在登录…" : "登录"}</button></form><footer>管理操作会记录审计；医疗内容发布前请完成专业审核。</footer></section></main>;
}

function Overview({ articles, videos, messages, knowledge, media }: { articles: ContentItem[]; videos: ContentItem[]; messages: MessageItem[]; knowledge: KnowledgeItem[]; media: MediaItem[] }) {
  const published = [...articles, ...videos].filter((item) => item.status === "published").length;
  return <div className="admin-overview"><section className="welcome-card"><div><small>客户试用版内容工作台</small><h2>先用真实闭环收集反馈</h2><p>本后台覆盖报价范围内的文章、视频、站内消息、素材与知识库。发布和下架会直接影响用户端可见内容。</p></div><span>KM</span></section><section className="stat-grid"><Stat icon="发" label="已发布内容" value={published} tone="green"/><Stat icon="信" label="已发布消息" value={messages.filter((item) => item.status === "published").length} tone="green"/><Stat icon="知" label="启用知识" value={knowledge.filter((item) => item.status === "enabled").length} tone="blue"/><Stat icon="材" label="可用素材" value={media.filter((item) => item.status === "ready").length} tone="blue"/></section><section className="recent-card"><div className="card-heading"><div><h2>当前交付边界</h2><p>不包含复杂统计、模型参数和调理方案后台编辑。</p></div></div><div className="scope-note">消息发布后会进入全部登录用户的站内信列表；不调用微信订阅消息，不产生额外模板消息合规范围。</div></section></div>;
}

function Stat({ icon, label, value, tone }: { icon: string; label: string; value: number; tone: string }) { return <article><i className={tone}>{icon}</i><small>{label}</small><strong>{value}</strong><p>实时读取服务端</p></article>; }

const blank = (kind: ContentKind): Omit<ContentItem, "id" | "revision" | "status" | "updatedAt"> => ({ kind, title: "", category: "", summary: "", body: "", source: "", coverMediaId: null, mediaId: null, instructions: "", precautions: "", disclaimer: "", displayOrder: 0 });

/**
 * 列表响应还可能包含 publishedAt、methodTags 等服务端字段。编辑表单只保留页面明确
 * 可编辑的字段，避免把隐藏元数据（尤其空 methodTags）原样回传并触发更新契约校验。
 */
function editableContent(item: ContentItem): ReturnType<typeof blank> {
  return {
    kind: item.kind,
    title: item.title,
    category: item.category,
    summary: item.summary,
    body: item.body,
    source: item.source,
    coverMediaId: item.coverMediaId,
    mediaId: item.mediaId,
    instructions: item.instructions,
    precautions: item.precautions,
    disclaimer: item.disclaimer,
    displayOrder: item.displayOrder
  };
}

function ContentManager({ kind, items, media, categories, busy, run }: { kind: ContentKind; items: ContentItem[]; media: MediaItem[]; categories: CategoryItem[]; busy: boolean; run: (action: () => Promise<void>, success: string) => Promise<void> }) {
  const [editing, setEditing] = useState<ContentItem | null>(null);
  const [draft, setDraft] = useState(blank(kind));
  const [showForm, setShowForm] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const label = kind === "article" ? "文章" : "视频";
  const readyMedia = media.filter((item) => item.status === "ready");
  const availableCategories = categories.filter((item) => item.status === "active" && (item.kind === kind || item.kind === "general"));
  function open(item?: ContentItem) { setEditing(item ?? null); setDraft(item === undefined ? blank(kind) : editableContent(item)); setShowForm(true); }
  async function save(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const input = { ...draft, kind: undefined, idempotencyKey: crypto.randomUUID() } as Record<string, unknown>;
      if (editing === null) await adminCommand(`content ${kind} create`, input);
      else await adminCommand(`content ${kind} update`, { ...input, id: editing.id, expectedRevision: editing.revision });
      setShowForm(false); setEditing(null); setDraft(blank(kind));
    }, `${label}已保存`);
  }
  async function createCategory() {
    const name = newCategory.trim();
    if (name === "") return;
    await run(async () => {
      await adminCommand("content category create", { name, kind, displayOrder: 0 });
    }, "分类已创建");
    setNewCategory("");
    setDraft((current) => ({ ...current, category: name }));
  }
  async function preview(item: ContentItem) {
    await run(async () => {
      const data = await adminCommand<{ validation: { ok: boolean; missing: string[] } }>(`content ${kind} preview`, { id: item.id });
      if (!data.validation.ok) throw new Error(`暂不能发布：${data.validation.missing.join("、")}`);
    }, "校验通过，可以发布");
  }
  async function toggle(item: ContentItem) {
    const action = item.status === "published" ? "unpublish" : "publish";
    await run(() => adminCommand(`content ${kind} ${action}`, { id: item.id, expectedRevision: item.revision, yes: true }).then(() => undefined), action === "publish" ? `${label}已发布，用户端现在可见` : `${label}已下架，用户端已不可见`);
  }
  return <section className="manager-card"><div className="manager-heading"><div><h2>{label}管理</h2><p>新增、编辑、校验、发布和下架；没有放置不可用按钮。</p></div><button className="primary" onClick={() => open()}>新增{label}</button></div>{showForm && <form className="content-form" onSubmit={(event) => void save(event)}><div className="form-grid"><label>标题<input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })}/></label><label>分类<select required value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}><option value="">请选择</option>{availableCategories.map((item) => <option key={item.id}>{item.name}</option>)}</select></label></div><div className="category-create"><input placeholder="没有合适分类？输入新分类" value={newCategory} onChange={(event) => setNewCategory(event.target.value)}/><button type="button" onClick={() => void createCategory()}>创建分类</button></div><label>摘要<textarea required rows={2} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })}/></label><label>{kind === "article" ? "正文" : "视频说明"}<textarea required rows={7} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })}/></label><div className="form-grid"><label>来源<input required value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })}/></label><label>封面素材<select value={draft.coverMediaId ?? ""} onChange={(event) => setDraft({ ...draft, coverMediaId: event.target.value || null })}><option value="">不设置</option>{readyMedia.filter((item) => item.kind === "image").map((item) => <option key={item.id} value={item.id}>{item.filename}</option>)}</select></label></div>{kind === "video" && <><label>视频文件<select required value={draft.mediaId ?? ""} onChange={(event) => setDraft({ ...draft, mediaId: event.target.value || null })}><option value="">请选择已上传视频</option>{readyMedia.filter((item) => item.kind === "video").map((item) => <option key={item.id} value={item.id}>{item.filename}</option>)}</select></label><div className="form-grid"><label>操作提示<textarea rows={2} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}/></label><label>注意事项<textarea rows={2} value={draft.precautions} onChange={(event) => setDraft({ ...draft, precautions: event.target.value })}/></label></div><label>免责声明<input value={draft.disclaimer} onChange={(event) => setDraft({ ...draft, disclaimer: event.target.value })}/></label></>}<div className="form-actions"><button type="button" onClick={() => setShowForm(false)}>取消</button><button className="primary" disabled={busy}>保存草稿</button></div></form>}<ContentTable items={items} busy={busy} onEdit={open} onPreview={preview} onToggle={toggle}/></section>;
}

function ContentTable({ items, busy, onEdit, onPreview, onToggle }: { items: ContentItem[]; busy: boolean; onEdit: (item: ContentItem) => void; onPreview: (item: ContentItem) => Promise<void>; onToggle: (item: ContentItem) => Promise<void> }) {
  if (items.length === 0) return <Empty icon="稿" title="还没有内容" text="先新增一条草稿，确认展示效果后再发布。"/>;
  return <div className="table-wrap"><table><thead><tr><th>内容</th><th>分类</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><small>{item.summary || "暂无摘要"}</small></td><td>{item.category || "未分类"}</td><td><span className={`status ${item.status}`}>{item.status === "published" ? "已发布" : item.status === "draft" ? "草稿" : "已下架"}</span></td><td>{new Date(item.updatedAt).toLocaleString("zh-CN")}</td><td className="row-actions"><button disabled={busy} onClick={() => onEdit(item)}>编辑</button><button disabled={busy} onClick={() => void onPreview(item)}>校验</button><button disabled={busy} onClick={() => void onToggle(item)}>{item.status === "published" ? "下架" : "发布"}</button></td></tr>)}</tbody></table></div>;
}

function MessageManager({ items, busy, run }: { items: MessageItem[]; busy: boolean; run: (action: () => Promise<void>, success: string) => Promise<void> }) {
  const [editing, setEditing] = useState<MessageItem | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [showForm, setShowForm] = useState(false);
  function open(item?: MessageItem) {
    setEditing(item ?? null); setTitle(item?.title ?? ""); setSummary(item?.summary ?? ""); setBody(item?.body ?? ""); setShowForm(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      if (editing === null) await adminCommand("content message create", { title, summary, body, idempotencyKey: crypto.randomUUID() });
      else await adminCommand("content message update", { id: editing.id, title, summary, body, expectedRevision: editing.revision });
      setShowForm(false); setEditing(null);
    }, "站内消息已保存");
  }
  async function toggle(item: MessageItem) {
    const action = item.status === "published" ? "unpublish" : "publish";
    await run(() => adminCommand(`content message ${action}`, { id: item.id, expectedRevision: item.revision, yes: true }).then(() => undefined), action === "publish" ? "消息已发布，登录用户现在可见" : "消息已下架");
  }
  return <section className="manager-card"><div className="manager-heading"><div><h2>站内消息</h2><p>向全部登录用户发布应用内公告；支持草稿、编辑、发布和下架。</p></div><button className="primary" onClick={() => open()}>新建消息</button></div>{showForm && <form className="content-form" onSubmit={(event) => void save(event)}><label>标题<input required value={title} onChange={(event) => setTitle(event.target.value)}/></label><label>摘要<input value={summary} onChange={(event) => setSummary(event.target.value)}/></label><label>正文<textarea required rows={7} value={body} onChange={(event) => setBody(event.target.value)}/></label><div className="form-actions"><button type="button" onClick={() => setShowForm(false)}>取消</button><button className="primary" disabled={busy}>保存草稿</button></div></form>}{items.length === 0 ? <Empty icon="信" title="还没有站内消息" text="新建草稿并发布后，登录用户会在消息中心看到。"/> : <div className="table-wrap"><table><thead><tr><th>消息</th><th>状态</th><th>发布时间</th><th>操作</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><small>{item.summary || item.body.slice(0, 48)}</small></td><td><span className={`status ${item.status}`}>{item.status === "published" ? "已发布" : item.status === "draft" ? "草稿" : "已下架"}</span></td><td>{item.publishedAt ? new Date(item.publishedAt).toLocaleString("zh-CN") : "—"}</td><td className="row-actions"><button disabled={busy} onClick={() => open(item)}>编辑</button><button disabled={busy} onClick={() => void toggle(item)}>{item.status === "published" ? "下架" : "发布"}</button></td></tr>)}</tbody></table></div>}</section>;
}

function MediaManager({ items, busy, run }: { items: MediaItem[]; busy: boolean; run: (action: () => Promise<void>, success: string) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); if (file === null) return; await run(async () => { await uploadFile(file); setFile(null); }, "素材已上传并通过完整性校验"); }
  return <section className="manager-card"><div className="manager-heading"><div><h2>素材库</h2><p>图片、视频和知识源文件统一先上传到素材库。</p></div><form className="upload-form" onSubmit={(event) => void submit(event)}><input aria-label="选择素材" type="file" required onChange={(event) => setFile(event.target.files?.[0] ?? null)}/><button className="primary" disabled={busy || file === null}>上传素材</button></form></div>{items.length === 0 ? <Empty icon="图" title="还没有素材" text="上传后可在文章、视频或知识库中引用。"/> : <div className="media-grid">{items.map((item) => <article key={item.id}><span>{item.kind.slice(0, 1).toUpperCase()}</span><div><strong>{item.filename}</strong><small>{(item.sizeBytes / 1024).toFixed(1)} KB · {item.status}</small>{item.failureReason && <small>{item.failureReason}</small>}</div></article>)}</div>}</section>;
}

function KnowledgeManager({ items, busy, run }: { items: KnowledgeItem[]; busy: boolean; run: (action: () => Promise<void>, success: string) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[]>([]);
  const [editing, setEditing] = useState<KnowledgeItem | null>(null);
  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editSource, setEditSource] = useState("");
  const [editError, setEditError] = useState("");
  async function add(event: FormEvent) { event.preventDefault(); if (file === null) return; await run(async () => { const media = await uploadFile(file); await adminCommand("agent knowledge add-from-media", { mediaId: media.id, source, description: "后台上传" }); setFile(null); setSource(""); }, "知识资料已上传，请建立索引后启用"); }
  async function action(item: KnowledgeItem, command: "index" | "enable" | "disable") { await run(() => adminCommand(`agent knowledge ${command}`, { id: item.id, yes: true }).then(() => undefined), command === "index" ? "索引已建立" : command === "enable" ? "知识已启用" : "知识已停用"); }
  function openEdit(item: KnowledgeItem) {
    setEditing(item);
    setEditName(item.name);
    setEditCategory(item.category ?? "");
    setEditSource(item.source ?? "");
    setEditError("");
  }
  function closeEdit() {
    setEditing(null);
    setEditError("");
  }
  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (editing === null) return;
    const name = editName.trim();
    if (name === "") {
      setEditError("知识名称不能为空");
      return;
    }
    setEditError("");
    await run(async () => {
      await adminCommand("agent knowledge update", {
        id: editing.id,
        name,
        category: editCategory.trim(),
        source: editSource.trim()
      });
      closeEdit();
    }, "知识资料已更新");
  }
  async function remove(item: KnowledgeItem) { if (!window.confirm(`确认删除知识“${item.name}”？源素材会保留在素材库。`)) return; await run(() => adminCommand("agent knowledge delete", { id: item.id, yes: true }).then(() => undefined), "知识资料已删除"); }
  async function search(event: FormEvent) { event.preventDefault(); await run(async () => { const data = await adminCommand<{ items: KnowledgeHit[] }>("agent knowledge search-test", { query }); setHits(data.items); }, "检索测试已完成"); }
  return <section className="manager-card"><div className="manager-heading knowledge-heading"><div><h2>智能体知识库</h2><p>上传、分类、更新、删除、索引、启停和检索测试；启用内容才会参与智能体检索。</p></div><form className="knowledge-upload" onSubmit={(event) => void add(event)}><input aria-label="知识来源" placeholder="来源说明（可选）" value={source} onChange={(event) => setSource(event.target.value)}/><input aria-label="选择知识文件" type="file" accept=".md,.markdown,.txt,.pdf,.docx" required onChange={(event) => setFile(event.target.files?.[0] ?? null)}/><button className="primary" disabled={busy || file === null}>上传知识</button></form></div>{editing !== null && <form className="content-form knowledge-edit-form" data-testid="knowledge-edit-form" onSubmit={(event) => void saveEdit(event)}><div className="form-grid"><label>知识名称<input required value={editName} onChange={(event) => setEditName(event.target.value)}/></label><label>知识分类（可留空）<input value={editCategory} onChange={(event) => setEditCategory(event.target.value)}/></label></div><label>来源说明（可留空）<input value={editSource} onChange={(event) => setEditSource(event.target.value)}/></label>{editError !== "" && <div className="form-error" role="alert">{editError}</div>}<div className="form-actions"><button type="button" onClick={closeEdit}>取消编辑</button><button className="primary" disabled={busy}>保存修改</button></div></form>}{items.length === 0 ? <Empty icon="知" title="还没有知识资料" text="建议先上传 Markdown 或 TXT，建立索引并启用后再做检索测试。"/> : <div className="table-wrap"><table><thead><tr><th>资料</th><th>分类</th><th>状态</th><th>分块</th><th>操作</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><small>{item.source || "未填写来源"}{item.parseError ? ` · ${item.parseError}` : ""}</small></td><td>{item.category || "未分类"}</td><td><span className={`status ${item.status}`}>{knowledgeStatusLabels[item.status]}</span></td><td>{item.chunkCount}</td><td className="row-actions"><button disabled={busy || editing?.id === item.id} onClick={() => openEdit(item)}>{editing?.id === item.id ? "正在编辑" : "编辑"}</button>{item.status === "processing" && <button disabled={busy} onClick={() => void action(item, "index")}>建立索引</button>}{(item.status === "indexed" || item.status === "disabled") && <button disabled={busy} onClick={() => void action(item, "enable")}>启用</button>}{item.status === "enabled" && <button disabled={busy} onClick={() => void action(item, "disable")}>停用</button>}{item.status !== "enabled" && <button disabled={busy} onClick={() => void remove(item)}>删除</button>}</td></tr>)}</tbody></table></div>}<form className="search-test" onSubmit={(event) => void search(event)}><label>检索测试<input required placeholder="输入客户可能询问的问题" value={query} onChange={(event) => setQuery(event.target.value)}/></label><button disabled={busy}>测试检索</button></form>{hits.length > 0 && <div className="search-results">{hits.map((hit, index) => <article key={`${hit.knowledgeId}-${index}`}><strong>{hit.name}</strong><p>{hit.snippet}</p></article>)}</div>}</section>;
}

function Empty({ icon, title, text }: { icon: string; title: string; text: string }) { return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{text}</p></div>; }
