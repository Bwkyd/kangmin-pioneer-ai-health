import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  AdminRequestError,
  adminCommand,
  login,
  logout,
  sessionStatus,
  uploadFile,
  type AdminSession
} from "./client";
import { ContentBody } from "../content-body";

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
  folderId: string | null;
  category?: string | null;
  source: string | null;
  description: string | null;
  status: "processing" | "indexed" | "enabled" | "disabled" | "index_failed";
  chunkCount: number;
  parseError: string | null;
  updatedAt: string;
}

interface KnowledgeFolder {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  depth: 1 | 2 | 3;
  knowledgeCount: number;
  childCount: number;
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

type ContentStatusFilter = "all" | ContentItem["status"];
type KnowledgeStatusFilter = "all" | KnowledgeItem["status"];
type SectionFocus = ContentStatusFilter | KnowledgeStatusFilter;

const knowledgeStatusLabels: Record<KnowledgeItem["status"], string> = {
  processing: "待建索引",
  indexed: "已建索引",
  enabled: "已启用",
  disabled: "已停用",
  index_failed: "索引失败"
};

const contentStatusLabels: Record<ContentItem["status"], string> = {
  draft: "草稿",
  published: "已发布",
  unpublished: "已下架"
};

const navigation: Array<{ key: Section; label: string; icon: string }> = [
  { key: "overview", label: "工作台", icon: "◈" },
  { key: "article", label: "科普文章", icon: "文" },
  { key: "video", label: "视频内容", icon: "播" },
  { key: "message", label: "站内消息", icon: "信" },
  { key: "knowledge", label: "智能体知识库", icon: "知" },
  { key: "media", label: "素材库", icon: "图" }
];

const deliveryNavigation = navigation.filter((item) => item.key === "article" || item.key === "video" || item.key === "knowledge");
const supportNavigation = navigation.filter((item) => item.key === "message" || item.key === "media");

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
  const [sectionFocus, setSectionFocus] = useState<SectionFocus>("all");
  const [articles, setArticles] = useState<ContentItem[]>([]);
  const [videos, setVideos] = useState<ContentItem[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [knowledgeFolders, setKnowledgeFolders] = useState<KnowledgeFolder[]>([]);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const navigate = useCallback((nextSection: Section, focus: SectionFocus = "all") => {
    setSection(nextSection);
    setSectionFocus(focus);
  }, []);

  const refresh = useCallback(async () => {
    const [articleData, videoData, messageData, mediaData, knowledgeData, folderData, categoryData] = await Promise.all([
      adminCommand<{ items: ContentItem[] }>("content article list"),
      adminCommand<{ items: ContentItem[] }>("content video list"),
      adminCommand<{ items: MessageItem[] }>("content message list"),
      adminCommand<{ items: MediaItem[] }>("content media list"),
      adminCommand<{ items: KnowledgeItem[] }>("agent knowledge list"),
      adminCommand<{ items: KnowledgeFolder[] }>("agent knowledge folder list"),
      adminCommand<{ items: CategoryItem[] }>("content category list")
    ]);
    setArticles(articleData.items);
    setVideos(videoData.items);
    setMessages(messageData.items);
    setMedia(mediaData.items);
    setKnowledge(knowledgeData.items);
    setKnowledgeFolders(folderData.items);
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

  async function run(action: () => Promise<void>, success: string): Promise<boolean> {
    setBusy(true);
    setNotice("");
    try {
      await action();
      await refresh();
      setNotice(success);
      return true;
    } catch (error) {
      setNotice(messageOf(error));
      if (error instanceof AdminRequestError && error.code === "authentication_required") {
        setSession(null);
      }
      return false;
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
          <span className="admin-nav-label">工作台</span>
          {navigation.filter((item) => item.key === "overview").map((item) => <button data-testid={`admin-nav-${item.key}`} key={item.key} className={section === item.key ? "active" : ""} onClick={() => navigate(item.key)}><i>{item.icon}</i>{item.label}</button>)}
          <span className="admin-nav-label">内容运营</span>
          {deliveryNavigation.map((item) => <button data-testid={`admin-nav-${item.key}`} key={item.key} className={section === item.key ? "active" : ""} onClick={() => navigate(item.key)}><i>{item.icon}</i>{item.label}</button>)}
          <span className="admin-nav-label">消息与素材</span>
          {supportNavigation.map((item) => <button data-testid={`admin-nav-${item.key}`} key={item.key} className={section === item.key ? "active" : ""} onClick={() => navigate(item.key)}><i>{item.icon}</i>{item.label}</button>)}
        </nav>
        <div className="admin-account"><span>{session.username?.slice(0, 1).toUpperCase()}</span><div><strong>{session.username}</strong><small>{session.role === "owner" ? "主管理员" : "内容管理员"}</small></div><button onClick={() => void run(async () => { await logout(); setSession(null); }, "已安全退出")}>退出</button></div>
      </aside>
      <section className="admin-main">
        <header className="admin-topbar"><div><small>抗敏先锋 / {current.label}</small><h1>{current.label}</h1><p className="topbar-description">{section === "overview" ? "先处理待办，再让内容安全地到达小程序。" : "按状态完成当前运营任务，所有写操作由服务端确认。"}</p></div></header>
        {notice !== "" && <div className="admin-toast" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>}
        {section === "overview" && <Overview articles={articles} videos={videos} messages={messages} knowledge={knowledge} media={media} onNavigate={navigate} />}
        {section === "article" && <ContentManager kind="article" items={articles} media={media} categories={categories} busy={busy} run={run} adminKey={session.adminId ?? session.username ?? "admin"} initialStatusFilter={sectionFocus === "draft" || sectionFocus === "published" || sectionFocus === "unpublished" ? sectionFocus : "all"} />}
        {section === "video" && <ContentManager kind="video" items={videos} media={media} categories={categories} busy={busy} run={run} adminKey={session.adminId ?? session.username ?? "admin"} initialStatusFilter={sectionFocus === "draft" || sectionFocus === "published" || sectionFocus === "unpublished" ? sectionFocus : "all"} />}
        {section === "message" && <MessageManager items={messages} busy={busy} run={run} initialStatusFilter={sectionFocus === "draft" || sectionFocus === "published" || sectionFocus === "unpublished" ? sectionFocus : "all"} />}
        {section === "knowledge" && <KnowledgeFolderManager items={knowledge} folders={knowledgeFolders} busy={busy} run={run} initialStatusFilter={sectionFocus === "processing" || sectionFocus === "indexed" || sectionFocus === "enabled" || sectionFocus === "disabled" || sectionFocus === "index_failed" ? sectionFocus : "all"} />}
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

function Overview({ articles, videos, messages, knowledge, media, onNavigate }: { articles: ContentItem[]; videos: ContentItem[]; messages: MessageItem[]; knowledge: KnowledgeItem[]; media: MediaItem[]; onNavigate: (section: Section, focus?: SectionFocus) => void }) {
  const published = [...articles, ...videos].filter((item) => item.status === "published").length;
  const articleDrafts = articles.filter((item) => item.status === "draft").length;
  const videoDrafts = videos.filter((item) => item.status === "draft").length;
  const knowledgeProcessing = knowledge.filter((item) => item.status === "processing").length;
  const knowledgeIndexed = knowledge.filter((item) => item.status === "indexed").length;
  const knowledgeFailed = knowledge.filter((item) => item.status === "index_failed").length;
  const messageDrafts = messages.filter((item) => item.status === "draft").length;
  const attentionTotal = articleDrafts + videoDrafts + knowledgeProcessing + knowledgeIndexed + knowledgeFailed + messageDrafts;
  const knowledgeAttentionStates = [
    knowledgeFailed > 0 ? "index_failed" : "",
    knowledgeProcessing > 0 ? "processing" : "",
    knowledgeIndexed > 0 ? "indexed" : ""
  ].filter(Boolean);
  const knowledgeFocus: KnowledgeStatusFilter = knowledgeAttentionStates.length === 1 ? knowledgeAttentionStates[0] as KnowledgeStatusFilter : "all";
  const knowledgeDetail = knowledgeAttentionStates.length > 1
    ? "有多个待处理状态，请按列表逐项完成"
    : knowledgeFailed > 0
      ? "解析失败需更换文件，不能伪装成功"
      : knowledgeProcessing > 0
        ? "等待索引完成"
        : knowledgeIndexed > 0
          ? "索引已完成，启用后参与检索"
          : "建立索引后才能启用检索";
  const tasks: Array<{ section: Section; focus: SectionFocus; icon: string; title: string; detail: string; count: number; action: string; tone: string }> = [
    { section: "article", focus: "draft", icon: "文", title: "文章草稿", detail: "完成校验后再发布到小程序", count: articleDrafts, action: "处理文章", tone: "blue" },
    { section: "video", focus: "draft", icon: "播", title: "视频草稿", detail: "确认素材和说明后再上架", count: videoDrafts, action: "处理视频", tone: "blue" },
    { section: "knowledge", focus: knowledgeFocus, icon: "知", title: "知识索引", detail: knowledgeDetail, count: knowledgeFailed + knowledgeProcessing + knowledgeIndexed, action: "处理知识", tone: knowledgeFailed > 0 ? "red" : "amber" },
    { section: "message", focus: "draft", icon: "信", title: "站内消息草稿", detail: "发布后登录用户可在消息中心看到", count: messageDrafts, action: "处理消息", tone: "green" }
  ];
  const activeTasks = tasks.filter((task) => task.count > 0);
  const deliveryCards: Array<{ section: Section; icon: string; title: string; detail: string; count: string }> = [
    { section: "article", icon: "文", title: "文章与推送", detail: "编辑、校验、上架；需要通知时进入站内消息。", count: `${articles.length} 条文章` },
    { section: "video", icon: "播", title: "视频内容", detail: "先上传素材，再编辑说明、校验和上架。", count: `${videos.length} 条视频` },
    { section: "knowledge", icon: "知", title: "智能体知识库", detail: "资料只有建立索引并启用后才参与检索。", count: `${knowledge.filter((item) => item.status === "enabled").length} 条已启用` }
  ];
  return <div className="admin-overview">
    <section className="welcome-card">
      <div className="welcome-copy"><div className="welcome-eyebrow"><span>●</span> 内容运营 / 小程序同步</div><h2>今天先处理最重要的任务</h2><p>从待办开始，完成文章、视频和知识资料的准备、校验与受控生效。每一步都回读服务端状态。</p></div>
      <div className="welcome-flow" aria-label="内容发布链路"><small>发布链路</small><div className="flow-track"><span className="flow-node active">01</span><i></i><span className="flow-node">02</span><i></i><span className="flow-node">03</span></div><div className="flow-labels"><span><strong>准备</strong><small>编辑内容</small></span><span><strong>校验</strong><small>完成校验</small></span><span><strong>发布</strong><small>用户可见</small></span></div></div>
    </section>
    <section className="stat-grid"><Stat icon="待" label="待处理任务" value={attentionTotal} tone={attentionTotal > 0 ? "amber" : "green"}/><Stat icon="发" label="已发布内容" value={published} tone="green"/><Stat icon="信" label="已发布消息" value={messages.filter((item) => item.status === "published").length} tone="green"/><Stat icon="知" label="启用知识" value={knowledge.filter((item) => item.status === "enabled").length} tone="blue"/><Stat icon="材" label="可用素材" value={media.filter((item) => item.status === "ready").length} tone="blue"/></section>
    <section className="workbench-grid">
      <article className="queue-card"><div className="card-heading"><div><h2>今天先处理</h2><p>只显示需要操作者继续动作的状态。</p></div><span className={`queue-count ${attentionTotal > 0 ? "attention" : "clear"}`}>{attentionTotal}</span></div>{activeTasks.length === 0 ? <div className="queue-empty"><strong>当前没有待处理任务</strong><span>文章、视频和知识库都处于可继续工作的状态。</span></div> : <div className="task-list">{activeTasks.map((task) => <button className="task-row" key={task.section} onClick={() => onNavigate(task.section, task.focus)}><span className={`task-mark ${task.tone}`}>{task.icon}</span><span className="task-copy"><strong>{task.title}<em>{task.count}</em></strong><small>{task.detail}</small></span><span className="task-action">{task.action} →</span></button>)}</div>}</article>
      <article className="delivery-card"><div className="card-heading"><div><h2>从内容开始</h2><p>文章、视频和知识库，从这里进入处理。</p></div><span className="sync-badge"><i></i> 服务端同步</span></div><div className="delivery-links">{deliveryCards.map((card) => <button className="delivery-link" key={card.section} onClick={() => onNavigate(card.section)}><span className="task-mark blue">{card.icon}</span><span><strong>{card.title}</strong><small>{card.detail}</small><em>{card.count} · 进入处理 →</em></span></button>)}</div></article>
    </section>
    <section className="recent-card"><div className="card-heading"><div><h2>内容如何到达小程序</h2><p>从后台操作到用户端展示，状态和边界保持清晰。</p></div><span className="sync-badge"><i></i> 边界清晰</span></div><div className="workflow-list"><div className="workflow-item"><span>01</span><div><strong>编辑与校验</strong><p>文章、视频和站内消息在后台完成内容准备；素材与知识资料单独维护。</p></div><em>后台完成</em></div><div className="workflow-item"><span>02</span><div><strong>发布与同步</strong><p>发布后的文章和视频进入小程序科普内容，站内消息进入登录用户的消息中心。</p></div><em>状态同步</em></div><div className="workflow-item"><span>03</span><div><strong>知识参与问答</strong><p>知识资料建立索引并启用后，才会参与智能体检索；停用后不再命中。</p></div><em>受控生效</em></div></div></section>
  </div>;
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

type DraftContent = ReturnType<typeof blank>;

interface ContentPreview extends ContentItem {
  validation: { ok: boolean; missing: string[] };
  patientVisible: boolean;
}

interface ArticleDocumentDraft {
  title: string;
  body: string;
  source: string;
  images: Array<{
    token: string;
    filename: string;
    mimeType: string;
    dataBase64: string;
  }>;
}

interface DraftRecovery {
  kind: ContentKind;
  draft: DraftContent;
  editingId: string | null;
  revision: number | null;
}

const mediaKindLabels: Record<string, string> = {
  image: "图片",
  video: "视频",
  word: "Word",
  pdf: "PDF",
  markdown: "Markdown"
};

function hasDraftContent(draft: DraftContent): boolean {
  return [
    draft.title,
    draft.category,
    draft.summary,
    draft.body,
    draft.source,
    draft.coverMediaId,
    draft.mediaId,
    draft.instructions,
    draft.precautions,
    draft.disclaimer
  ].some((value) => typeof value === "string" && value.trim() !== "");
}

function ContentManager({
  kind,
  items,
  media,
  categories,
  busy,
  run,
  adminKey,
  initialStatusFilter
}: {
  kind: ContentKind;
  items: ContentItem[];
  media: MediaItem[];
  categories: CategoryItem[];
  busy: boolean;
  run: (action: () => Promise<void>, success: string) => Promise<boolean>;
  adminKey: string;
  initialStatusFilter: ContentStatusFilter;
}) {
  const [editing, setEditing] = useState<ContentItem | null>(null);
  const [draft, setDraft] = useState(blank(kind));
  const [showForm, setShowForm] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ContentStatusFilter>(initialStatusFilter);
  const [previewItem, setPreviewItem] = useState<ContentPreview | null>(null);
  const [recovery, setRecovery] = useState<DraftRecovery | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const storageKey = "kangmin.admin.content-draft." + adminKey + "." + kind;
  const label = kind === "article" ? "文章" : "视频";
  const readyMedia = media.filter((item) => item.status === "ready");
  const availableCategories = categories.filter((item) => item.status === "active" && (item.kind === kind || item.kind === "general"));
  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      const matchesStatus = statusFilter === "all" || item.status === statusFilter;
      const matchesQuery = normalized === "" || [item.title, item.summary, item.category].join(" ").toLocaleLowerCase().includes(normalized);
      return matchesStatus && matchesQuery;
    });
  }, [items, query, statusFilter]);
  const draftCount = items.filter((item) => item.status === "draft").length;
  const publishedCount = items.filter((item) => item.status === "published").length;
  const selectedVideo = draft.mediaId === null
    ? null
    : readyMedia.find((item) => item.kind === "video" && item.id === draft.mediaId) ?? null;
  const importedDocumentName = editing === null
    && /\.(?:docx|pdf)$/iu.test(draft.source)
    && draft.body.trim() !== ""
    ? draft.source
    : null;

  useEffect(() => {
    setStatusFilter(initialStatusFilter);
    setQuery("");
  }, [initialStatusFilter]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw === null) return;
      const parsed = JSON.parse(raw) as Partial<DraftRecovery>;
      if (parsed.kind !== kind || parsed.draft === undefined || typeof parsed.draft !== "object") return;
      setRecovery({
        kind,
        draft: { ...blank(kind), ...(parsed.draft as Partial<DraftContent>) },
        editingId: typeof parsed.editingId === "string" ? parsed.editingId : null,
        revision: typeof parsed.revision === "number" ? parsed.revision : null
      });
    } catch {
      sessionStorage.removeItem(storageKey);
    }
  }, [kind, storageKey]);

  useEffect(() => {
    if (!showForm) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({
        kind,
        draft,
        editingId: editing?.id ?? null,
        revision: editing?.revision ?? null
      }));
    } catch {
      // 浏览器存储不可用时仍保留当前表单和服务端草稿能力。
    }
  }, [draft, editing, kind, showForm, storageKey]);

  useEffect(() => {
    function warnBeforeLeave(event: BeforeUnloadEvent) {
      if (!showForm || !hasDraftContent(draft)) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [draft, showForm]);

  useEffect(() => {
    if (!showForm) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [showForm]);

  function clearStoredDraft() {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // ignore unavailable browser storage
    }
  }

  function restoreRecovery() {
    if (recovery === null) return;
    const saved = recovery;
    const current = saved.editingId === null ? undefined : items.find((item) => item.id === saved.editingId);
    setEditing(current ?? null);
    setDraft({ ...blank(kind), ...saved.draft });
    setShowForm(true);
    setRecovery(null);
    setRecoveryNotice(current === undefined && saved.editingId !== null ? "原内容已不存在，已按新草稿恢复正文。" : "");
  }

  function open(item?: ContentItem) {
    if (item === undefined && recovery !== null) {
      restoreRecovery();
      return;
    }
    setRecovery(null);
    setRecoveryNotice("");
    setEditing(item ?? null);
    setDraft(item === undefined ? blank(kind) : editableContent(item));
    setShowForm(true);
  }

  function closeForm() {
    if (hasDraftContent(draft) && !window.confirm("当前表单还有未保存内容，确定放弃吗？")) return;
    clearStoredDraft();
    setRecovery(null);
    setRecoveryNotice("");
    setShowForm(false);
    setEditing(null);
    setDraft(blank(kind));
  }

  async function persistDraft(previewAfterSave = false) {
    let savedItem: ContentItem | null = null;
    const succeeded = await run(async () => {
      const input = { ...draft, kind: undefined, idempotencyKey: crypto.randomUUID() } as Record<string, unknown>;
      if (editing === null) {
        savedItem = await adminCommand<ContentItem>("content " + kind + " create", input);
      } else {
        savedItem = await adminCommand<ContentItem>("content " + kind + " update", { ...input, id: editing.id, expectedRevision: editing.revision });
      }
      clearStoredDraft();
      setRecovery(null);
      setShowForm(false);
      setEditing(null);
      setDraft(blank(kind));
    }, label + "草稿已保存");
    if (succeeded && previewAfterSave && savedItem !== null) {
      await previewContent(savedItem);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    await persistDraft();
  }

  async function saveAndPreview() {
    if (draft.title.trim() === "" || draft.body.trim() === "") {
      await run(async () => {
        throw new Error(kind === "article"
          ? "请先填写标题和正文，或导入 Word/PDF 后再预览"
          : "请先填写标题和视频说明后再预览");
      }, "");
      return;
    }
    await persistDraft(true);
  }

  async function createCategory() {
    const name = newCategory.trim();
    if (name === "") return;
    const succeeded = await run(async () => {
      await adminCommand("content category create", { name, kind, displayOrder: 0 });
    }, "分类已创建");
    if (succeeded) {
      setNewCategory("");
      setDraft((current) => ({ ...current, category: name }));
    }
  }

  async function importArticleDocument(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    if (hasDraftContent(draft) && !window.confirm("导入文档会覆盖当前标题、正文和来源，是否继续？")) return;
    await run(async () => {
      const mediaItem = await uploadFile(file);
      const imported = await adminCommand<ArticleDocumentDraft>("content article import-document", { mediaId: mediaItem.id });
      let importedBody = imported.body;
      for (const image of imported.images) {
        const binary = window.atob(image.dataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const uploaded = await uploadFile(new File([bytes], image.filename, { type: image.mimeType }), "image");
        importedBody = importedBody.replaceAll(image.token, `/v1/media/${uploaded.id}`);
      }
      setDraft((current) => ({
        ...current,
        title: imported.title,
        body: importedBody,
        source: imported.source
      }));
    }, "文档和图片已导入，请校对内容并补充摘要、分类");
  }

  async function uploadVideo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    await run(async () => {
      const mediaItem = await uploadFile(file, "video");
      setDraft((current) => ({ ...current, mediaId: mediaItem.id }));
    }, "视频文件已上传并选中");
  }

  async function previewContent(item: ContentItem) {
    await run(async () => {
      const data = await adminCommand<ContentPreview>("content " + kind + " preview", { id: item.id });
      setPreviewItem(data);
    }, "患者端预览已打开，请查看发布校验结果");
  }

  async function toggle(item: ContentItem) {
    const action = item.status === "published" ? "unpublish" : "publish";
    const succeeded = await run(
      () => adminCommand("content " + kind + " " + action, { id: item.id, expectedRevision: item.revision, yes: true }).then(() => undefined),
      action === "publish" ? label + "已发布，用户端现在可见" : label + "已下架，用户端已不可见"
    );
    if (succeeded) setStatusFilter("all");
  }

  return (
    <section className="manager-card">
      <div className="manager-heading">
        <div>
          <span className="section-kicker">内容运营 / {kind === "article" ? "科普内容" : "视频内容"}</span>
          <h2>{label}管理</h2>
          <p>先保存不完整草稿，再用患者端预览确认效果；发布前由服务端校验内容、分类和素材。</p>
        </div>
        <button type="button" className="primary" onClick={() => open()}>新增{label}</button>
      </div>
      {recovery !== null && (
        <div className="draft-recovery" role="status">
          <span>发现上次离开页面时未保存的{label}内容。</span>
          <button type="button" onClick={restoreRecovery}>恢复未保存内容</button>
          <button type="button" onClick={() => { clearStoredDraft(); setRecovery(null); }}>放弃恢复</button>
        </div>
      )}
      {recoveryNotice !== "" && <p className="form-hint recovery-hint">{recoveryNotice}</p>}
      <div className="manager-toolbar">
        <label className="filter-field">搜索{label}<input aria-label={"搜索" + label} placeholder="按标题、摘要或分类搜索" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label className="filter-field filter-status">状态筛选<select aria-label={"筛选" + label + "状态"} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ContentStatusFilter)}><option value="all">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="unpublished">已下架</option></select></label>
        <div className="status-summary"><strong>{filteredItems.length}</strong><span>当前显示</span><small>{draftCount} 条草稿 · {publishedCount} 条已发布</small></div>
      </div>
      {showForm && (
        <div className="content-editor-backdrop" data-testid="content-editor-backdrop">
          <form className="content-form content-editor-dialog" role="dialog" aria-modal="true" aria-labelledby={`content-editor-title-${kind}`} onSubmit={(event) => void save(event)}>
            <div className="content-editor-heading">
              <h2 id={`content-editor-title-${kind}`}>{editing === null ? "新增" : "编辑"}{label}</h2>
              <button type="button" aria-label={`关闭${label}编辑`} onClick={closeForm}>×</button>
            </div>
            <div className="content-editor-scroll">
              {kind === "video" && (
                <div className={`article-import${draft.mediaId === null ? "" : " imported"}`}>
                  <div>{draft.mediaId === null
                    ? <><strong>上传视频文件</strong><small>支持 MP4、WebM；上传后仍可补充标题和说明。</small></>
                    : <><strong>已选择：{selectedVideo?.filename ?? "视频素材"}</strong><small>视频已绑定到当前内容，可重新选择或继续编辑。</small></>
                  }</div>
                  <label className="article-import-button">{draft.mediaId === null ? "选择视频" : "重新选择"}<input aria-label="选择视频文件" type="file" accept="video/*,.mp4,.webm" disabled={busy} onChange={(event) => void uploadVideo(event)} /></label>
                </div>
              )}
              {kind === "article" && editing === null && (
                <div className={`article-import${importedDocumentName === null ? "" : " imported"}`}>
                  <div>{importedDocumentName === null
                    ? <><strong>从 Word/PDF 导入</strong><small>自动提取文字和图片；扫描版 PDF 按页保留。</small></>
                    : <><strong>已导入：{importedDocumentName}</strong><small>文件内容已转换到下方标题和正文，可继续校对编辑。</small></>
                  }</div>
                  <label className="article-import-button">{importedDocumentName === null ? "选择文档" : "重新选择"}<input aria-label="选择文章文档" type="file" accept=".docx,.pdf" disabled={busy} onChange={(event) => void importArticleDocument(event)} /></label>
                </div>
              )}
              <div className="form-grid">
                <label>标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
                <label>分类<select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}><option value="">未选择（草稿可暂留空）</option>{availableCategories.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
              </div>
              <details className="category-create">
                <summary>新建分类</summary>
                <div className="category-create-fields"><input aria-label="新建分类名称" placeholder="输入分类名称" value={newCategory} onChange={(event) => setNewCategory(event.target.value)} /><button type="button" onClick={() => void createCategory()}>创建分类</button></div>
                <small className="form-hint">分类会立即加入当前{label}的可选列表。</small>
              </details>
              <label>摘要<textarea rows={2} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label>
              <ContentBodyEditor label={kind === "article" ? "正文" : "视频说明"} value={draft.body} onChange={(body) => setDraft((current) => ({ ...current, body }))} run={run} />
              <details className="content-advanced">
                <summary>更多设置（来源、封面{kind === "video" ? "、素材库" : ""}）</summary>
                <div className="form-grid">
                  <label>来源<input value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })} /></label>
                  <MediaBinding label="封面素材" selectedId={draft.coverMediaId} items={readyMedia.filter((item) => item.kind === "image")} accept="image/*,.jpg,.jpeg,.png,.webp,.gif" mediaKind="image" busy={busy} run={run} onSelect={(id) => setDraft((current) => ({ ...current, coverMediaId: id }))} />
                </div>
                {kind === "video" && <label>从素材库选择视频<select aria-label="从素材库选择视频" value={draft.mediaId ?? ""} onChange={(event) => setDraft((current) => ({ ...current, mediaId: event.target.value || null }))}><option value="">未选择</option>{readyMedia.filter((item) => item.kind === "video").map((item) => <option key={item.id} value={item.id}>{item.filename}</option>)}</select></label>}
              </details>
              {kind === "video" && (
                <>
                  <div className="form-grid">
                    <label>操作提示<textarea rows={3} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /><small className="form-hint">发布前必填，患者端会在视频下方看到。</small></label>
                    <label>注意事项<textarea rows={3} value={draft.precautions} onChange={(event) => setDraft({ ...draft, precautions: event.target.value })} /><small className="form-hint">发布前必填，缺失时服务端会阻止发布。</small></label>
                  </div>
                  <label>免责声明<input value={draft.disclaimer} onChange={(event) => setDraft({ ...draft, disclaimer: event.target.value })} /></label>
                </>
              )}
            </div>
            <div className="content-form-actions" data-testid="content-form-actions">
              <div className="content-form-actions-buttons"><button type="button" className="secondary-action" onClick={closeForm}>取消</button><button type="button" className="preview-action" disabled={busy} onClick={() => void saveAndPreview()}>保存并预览</button><button type="submit" className="primary" disabled={busy}>保存草稿</button></div>
            </div>
          </form>
        </div>
      )}
      <ContentTable items={filteredItems} emptyText={query.trim() !== "" || statusFilter !== "all" ? "没有匹配内容" : "还没有内容"} busy={busy} onEdit={open} onPreview={previewContent} onToggle={toggle} />
      {previewItem !== null && <PatientContentPreview item={previewItem} onClose={() => setPreviewItem(null)} />}
    </section>
  );
}

function ContentBodyEditor({
  label,
  value,
  onChange,
  run
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  run: (action: () => Promise<void>, success: string) => Promise<boolean>;
}) {
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  function insert(text: string) {
    const element = textarea.current;
    if (element === null) {
      onChange(value + text);
      return;
    }
    const start = element.selectionStart;
    const end = element.selectionEnd;
    onChange(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      element.focus();
      const cursor = start + text.length;
      element.setSelectionRange(cursor, cursor);
    });
  }

  async function uploadBodyFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    const succeeded = await run(async () => {
      const media = await uploadFile(file);
      const safeName = file.name.replaceAll("[", "").replaceAll("]", "");
      const snippet = media.kind === "image"
        ? "![" + safeName + "](/v1/media/" + media.id + ")"
        : "[" + safeName + "](/v1/media/" + media.id + ")";
      onChange(value.trim() === "" ? snippet : value + "\n\n" + snippet);
    }, "正文素材已上传并插入");
    if (!succeeded) return;
  }

  return (
    <div className="body-editor">
      <label>{label}<textarea ref={textarea} aria-label={label} rows={7} value={value} onChange={(event) => onChange(event.target.value)} /></label>
      <div className="body-toolbar">
        <button type="button" onClick={() => insert("## 小标题\n\n")}>插入小标题</button>
        <button type="button" onClick={() => insert("- 重点内容\n")}>插入列表</button>
        <button type="button" onClick={() => insert("[链接文字](https://example.com)")}>插入链接</button>
        <label className="body-upload">上传素材<input aria-label="上传正文图片或附件" type="file" accept="image/*,.jpg,.jpeg,.png,.webp,.gif,.pdf,.doc,.docx,.md,.markdown,.txt" onChange={(event) => void uploadBodyFile(event)} /></label>
      </div>
    </div>
  );
}

function MediaBinding({
  label,
  selectedId,
  items,
  accept,
  mediaKind,
  busy,
  run,
  onSelect
}: {
  label: string;
  selectedId: string | null;
  items: MediaItem[];
  accept: string;
  mediaKind: "image" | "video";
  busy: boolean;
  run: (action: () => Promise<void>, success: string) => Promise<boolean>;
  onSelect: (id: string | null) => void;
}) {
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    await run(async () => {
      const media = await uploadFile(file, mediaKind);
      onSelect(media.id);
    }, label + "已上传并已选中");
  }

  return (
    <div className="media-binding">
      <label>{label}<select aria-label={label} value={selectedId ?? ""} onChange={(event) => onSelect(event.target.value || null)}>
        <option value="">不设置（草稿可暂留空）</option>
        {items.map((item) => <option key={item.id} value={item.id}>{item.filename} · {mediaKindLabels[item.kind] ?? item.kind}</option>)}
      </select></label>
      <label className="media-upload-choice">直接上传{mediaKind === "image" ? "封面图片" : "视频文件"}<input aria-label={"直接上传" + label} type="file" accept={accept} disabled={busy} onChange={(event) => void upload(event)} /></label>
      <small className="form-hint">只接受{mediaKind === "image" ? "图片" : "视频"}；文件会上传到素材库并立即绑定到当前{mediaKind === "image" ? "内容封面" : "视频"}。</small>
    </div>
  );
}

function PatientContentPreview({ item, onClose }: { item: ContentPreview; onClose: () => void }) {
  const mediaPrefix = "/v1/admin/media";
  return (
    <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label="患者端预览">
      <article className="patient-content-preview" data-testid="content-preview">
        <div className="preview-heading"><div><span className="section-kicker">患者端效果预览</span><h2>{item.title || "未填写标题"}</h2></div><button type="button" aria-label="关闭患者端预览" onClick={onClose}>×</button></div>
        <div className={"preview-validation " + (item.validation.ok ? "ok" : "failed")} role="status">{item.validation.ok ? "发布前校验已通过；当前只是预览，不会改变发布状态。" : "尚不能发布：" + item.validation.missing.join("、")}</div>
        <div className="preview-phone">
          <div className="discover-tags"><i>{item.category || "未分类"}</i></div>
          {item.coverMediaId && <img className="discover-detail-image" src={mediaPrefix + "/" + item.coverMediaId} alt={item.title + "配图"} />}
          {item.kind === "video" && item.mediaId && <video className="discover-detail-video" controls preload="metadata" src={mediaPrefix + "/" + item.mediaId} />}
          <h3>{item.title || "未填写标题"}</h3>
          {item.summary && <p className="preview-summary">{item.summary}</p>}
          <ContentBody body={item.body} mediaPathPrefix={mediaPrefix} />
          {item.kind === "video" && (item.instructions || item.precautions) && <section className="discover-safety-note"><p><strong>操作提示：</strong>{item.instructions || "未填写"}</p><p><strong>注意事项：</strong>{item.precautions || "未填写"}</p></section>}
          {item.source && <p className="discover-detail-meta">来源：{item.source}</p>}
          {item.disclaimer && <footer>{item.disclaimer}</footer>}
        </div>
      </article>
    </div>
  );
}

function ContentTable({ items, emptyText, busy, onEdit, onPreview, onToggle }: { items: ContentItem[]; emptyText: string; busy: boolean; onEdit: (item: ContentItem) => void; onPreview: (item: ContentItem) => Promise<void>; onToggle: (item: ContentItem) => Promise<void> }) {
  if (items.length === 0) return <Empty icon="稿" title={emptyText} text={emptyText === "还没有内容" ? "先新增一条草稿，确认展示效果后再发布。" : "调整搜索词或状态筛选后继续。"}/>;
  return <div className="table-wrap"><table><thead><tr><th>内容</th><th>分类</th><th>状态 / 下一步</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><small>{item.summary || "暂无摘要"}</small></td><td>{item.category || "未分类"}</td><td><span className={`status ${item.status}`}>{contentStatusLabels[item.status]}</span><small className="next-step">{item.status === "draft" ? "下一步：校验并发布" : item.status === "published" ? "用户端当前可见" : "需要时重新校验并发布"}</small></td><td>{new Date(item.updatedAt).toLocaleString("zh-CN")}</td><td className="row-actions"><button disabled={busy} onClick={() => onEdit(item)}>编辑</button><button disabled={busy} onClick={() => void onPreview(item)}>校验</button><button disabled={busy} onClick={() => void onToggle(item)}>{item.status === "published" ? "下架" : "发布"}</button></td></tr>)}</tbody></table></div>;
}

function MessageManager({ items, busy, run, initialStatusFilter }: { items: MessageItem[]; busy: boolean; run: (action: () => Promise<void>, success: string) => Promise<boolean>; initialStatusFilter: ContentStatusFilter }) {
  const [editing, setEditing] = useState<MessageItem | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ContentStatusFilter>(initialStatusFilter);
  useEffect(() => {
    setStatusFilter(initialStatusFilter);
    setQuery("");
  }, [initialStatusFilter]);
  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      const matchesStatus = statusFilter === "all" || item.status === statusFilter;
      const matchesQuery = normalized === "" || [item.title, item.summary ?? "", item.body].join(" ").toLocaleLowerCase().includes(normalized);
      return matchesStatus && matchesQuery;
    });
  }, [items, query, statusFilter]);
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
    const succeeded = await run(() => adminCommand(`content message ${action}`, { id: item.id, expectedRevision: item.revision, yes: true }).then(() => undefined), action === "publish" ? "消息已发布，登录用户现在可见" : "消息已下架");
    if (succeeded) setStatusFilter("all");
  }
  return <section className="manager-card"><div className="manager-heading"><div><span className="section-kicker">消息与素材 / 应用内推送</span><h2>站内消息</h2><p>向登录用户发布应用内消息；支持草稿、编辑、发布和下架，不扩展到微信订阅通知。</p></div><button className="primary" onClick={() => open()}>新建消息</button></div><div className="manager-toolbar"><label className="filter-field">搜索消息<input aria-label="搜索站内消息" placeholder="按标题、摘要或正文搜索" value={query} onChange={(event) => setQuery(event.target.value)}/></label><label className="filter-field filter-status">状态筛选<select aria-label="筛选站内消息状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | MessageItem["status"])}><option value="all">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="unpublished">已下架</option></select></label><div className="status-summary"><strong>{filteredItems.length}</strong><span>当前显示</span><small>{items.filter((item) => item.status === "draft").length} 条草稿 · 发布后登录用户可见</small></div></div>{showForm && <form className="content-form" onSubmit={(event) => void save(event)}><label>标题<input required value={title} onChange={(event) => setTitle(event.target.value)}/></label><label>摘要<input value={summary} onChange={(event) => setSummary(event.target.value)}/></label><label>正文<textarea required rows={7} value={body} onChange={(event) => setBody(event.target.value)}/></label><div className="form-actions"><button type="button" onClick={() => setShowForm(false)}>取消</button><button className="primary" disabled={busy}>保存草稿</button></div></form>}{filteredItems.length === 0 ? <Empty icon="信" title={items.length === 0 ? "还没有站内消息" : "没有匹配消息"} text={items.length === 0 ? "新建草稿并发布后，登录用户会在消息中心看到。" : "调整搜索词或状态筛选后继续。"}/> : <div className="table-wrap"><table><thead><tr><th>消息</th><th>状态 / 下一步</th><th>发布时间</th><th>操作</th></tr></thead><tbody>{filteredItems.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><small>{item.summary || item.body.slice(0, 48)}</small></td><td><span className={`status ${item.status}`}>{contentStatusLabels[item.status]}</span><small className="next-step">{item.status === "draft" ? "下一步：发布后进入消息中心" : item.status === "published" ? "登录用户当前可见" : "需要时重新发布"}</small></td><td>{item.publishedAt ? new Date(item.publishedAt).toLocaleString("zh-CN") : "—"}</td><td className="row-actions"><button disabled={busy} onClick={() => open(item)}>编辑</button><button disabled={busy} onClick={() => void toggle(item)}>{item.status === "published" ? "下架" : "发布"}</button></td></tr>)}</tbody></table></div>}</section>;
}

const mediaStatusLabels: Record<string, string> = {
  processing: "上传中",
  ready: "可用",
  failed: "上传失败",
  disabled: "已停用"
};

function MediaManager({ items, busy, run }: { items: MediaItem[]; busy: boolean; run: (action: () => Promise<void>, success: string) => Promise<boolean> }) {
  const [file, setFile] = useState<File | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (file === null) return;
    await run(async () => {
      await uploadFile(file);
      setFile(null);
    }, "素材已上传并通过完整性校验");
  }
  return (
    <section className="manager-card">
      <div className="manager-heading">
        <div>
          <h2>素材库</h2>
          <p>按用途上传图片、视频或附件；文章封面只能选择图片，视频内容只能选择视频。</p>
          <small className="form-hint">支持图片、视频、Word、PDF、Markdown，单文件上限 200MB；失败会保留原因。</small>
        </div>
        <form className="upload-form" onSubmit={(event) => void submit(event)}>
          <input aria-label="选择素材" type="file" accept="image/*,video/*,.jpg,.jpeg,.png,.webp,.gif,.mp4,.webm,.doc,.docx,.pdf,.md,.markdown,.txt" required onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          <button className="primary" disabled={busy || file === null}>上传素材</button>
        </form>
      </div>
      {items.length === 0 ? <Empty icon="图" title="还没有素材" text="上传后可在文章、视频或知识库中引用。" /> : (
        <div className="media-grid">
          {items.map((item) => (
            <article key={item.id}>
              <span>{mediaKindLabels[item.kind] ?? item.kind}</span>
              <div>
                <strong>{item.filename}</strong>
                <small>{mediaKindLabels[item.kind] ?? item.kind} · {(item.sizeBytes / 1024).toFixed(1)} KB · {mediaStatusLabels[item.status] ?? item.status}</small>
                {item.failureReason && <small className="action-note">{item.failureReason}</small>}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function KnowledgeFolderManager({ items, folders, busy, run, initialStatusFilter }: { items: KnowledgeItem[]; folders: KnowledgeFolder[]; busy: boolean; run: (action: () => Promise<void>, success: string) => Promise<boolean>; initialStatusFilter: KnowledgeStatusFilter }) {
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState("");
  const [uploadFolderId, setUploadFolderId] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<"all" | "unfiled" | string>("all");
  const [query, setQuery] = useState("");
  const [listQuery, setListQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<KnowledgeStatusFilter>(initialStatusFilter);
  const [hits, setHits] = useState<KnowledgeHit[]>([]);
  const [editing, setEditing] = useState<KnowledgeItem | null>(null);
  const [editName, setEditName] = useState("");
  const [editSource, setEditSource] = useState("");
  const [editError, setEditError] = useState("");
  const [folderMode, setFolderMode] = useState<"create" | "edit" | null>(null);
  const [folderName, setFolderName] = useState("");
  const [folderParentId, setFolderParentId] = useState("");
  const [movingItemId, setMovingItemId] = useState<string | null>(null);

  useEffect(() => {
    setStatusFilter(initialStatusFilter);
    setListQuery("");
  }, [initialStatusFilter]);
  useEffect(() => {
    if (selectedFolder !== "all" && selectedFolder !== "unfiled" && !folders.some((folder) => folder.id === selectedFolder)) {
      setSelectedFolder("all");
    }
  }, [folders, selectedFolder]);

  const selectedFolderItem = folders.find((folder) => folder.id === selectedFolder) ?? null;
  const descendantsOfSelected = useMemo(() => {
    const result = new Set<string>();
    if (selectedFolderItem === null) return result;
    const queue = [selectedFolderItem.id];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      for (const child of folders.filter((folder) => folder.parentId === parentId)) {
        result.add(child.id);
        queue.push(child.id);
      }
    }
    return result;
  }, [folders, selectedFolderItem]);
  const folderPath = (folderId: string): string => {
    const names: string[] = [];
    let current = folders.find((folder) => folder.id === folderId);
    while (current !== undefined) {
      names.unshift(current.name);
      current = current.parentId === null ? undefined : folders.find((folder) => folder.id === current!.parentId);
    }
    return names.join(" / ");
  };
  const folderOptions = [...folders].sort((left, right) =>
    folderPath(left.id).localeCompare(folderPath(right.id), "zh-CN")
  );
  const filteredItems = useMemo(() => {
    const normalized = listQuery.trim().toLocaleLowerCase();
    return items.filter((item) => {
      const matchesFolder = selectedFolder === "all"
        || (selectedFolder === "unfiled" ? item.folderId === null : item.folderId === selectedFolder);
      const matchesStatus = statusFilter === "all" || item.status === statusFilter;
      const matchesQuery = normalized === "" || [item.name, item.category ?? "", item.source ?? "", item.parseError ?? ""].join(" ").toLocaleLowerCase().includes(normalized);
      return matchesFolder && matchesStatus && matchesQuery;
    });
  }, [items, listQuery, selectedFolder, statusFilter]);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (file === null) return;
    const succeeded = await run(async () => {
      const media = await uploadFile(file);
      await adminCommand("agent knowledge add-from-media", { mediaId: media.id, source, description: "后台上传", folderId: uploadFolderId || null });
      setFile(null);
      setSource("");
      setUploadFolderId("");
    }, "知识资料已上传，请建立索引后启用");
    if (succeeded) setUploadOpen(false);
  }
  function closeUpload() {
    if (busy) return;
    setUploadOpen(false);
    setFile(null);
    setSource("");
    setUploadFolderId("");
  }
  async function action(item: KnowledgeItem, command: "index" | "enable" | "disable") {
    if (command === "disable" && !window.confirm(`停用“${item.name}”后，它将不再参与智能体检索。确认停用？`)) return;
    const succeeded = await run(() => adminCommand(`agent knowledge ${command}`, { id: item.id, yes: true }).then(() => undefined), command === "index" ? "索引已建立" : command === "enable" ? "知识已启用" : "知识已停用");
    if (succeeded) setStatusFilter("all");
  }
  function openEdit(item: KnowledgeItem) {
    setEditing(item);
    setEditName(item.name);
    setEditSource(item.source ?? "");
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
    const succeeded = await run(() => adminCommand("agent knowledge update", { id: editing.id, name, source: editSource.trim() }).then(() => undefined), "知识资料已更新");
    if (succeeded) setEditing(null);
  }
  async function moveItem(item: KnowledgeItem, folderId: string) {
    const succeeded = await run(() => adminCommand("agent knowledge move", { id: item.id, folderId: folderId || null }).then(() => undefined), folderId === "" ? "知识已移到未分类" : "知识已移动到目标目录");
    if (succeeded) setMovingItemId(null);
  }
  async function remove(item: KnowledgeItem) {
    if (!window.confirm(`确认删除知识“${item.name}”？源素材会保留在素材库。`)) return;
    await run(() => adminCommand("agent knowledge delete", { id: item.id, yes: true }).then(() => undefined), "知识资料已删除");
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const data = await adminCommand<{ items: KnowledgeHit[] }>("agent knowledge search-test", { query });
      setHits(data.items);
    }, "检索测试已完成");
  }
  function startCreate(parentId: string | null) {
    setFolderMode("create");
    setFolderName("");
    setFolderParentId(parentId ?? "");
  }
  function startEdit() {
    if (selectedFolderItem === null) return;
    setFolderMode("edit");
    setFolderName(selectedFolderItem.name);
    setFolderParentId(selectedFolderItem.parentId ?? "");
  }
  async function saveFolder(event: FormEvent) {
    event.preventDefault();
    const name = folderName.trim();
    if (name === "") return;
    const command = folderMode === "edit" ? "agent knowledge folder update" : "agent knowledge folder create";
    const input = folderMode === "edit"
      ? { id: selectedFolderItem!.id, name, parentId: folderParentId || null }
      : { name, parentId: folderParentId || null };
    const succeeded = await run(() => adminCommand(command, input).then(() => undefined), folderMode === "edit" ? "目录已更新" : "目录已创建");
    if (succeeded) setFolderMode(null);
  }
  async function deleteSelectedFolder() {
    if (selectedFolderItem === null) return;
    if (!window.confirm(`确认删除空目录“${selectedFolderItem.name}”？`)) return;
    const succeeded = await run(() => adminCommand("agent knowledge folder delete", { id: selectedFolderItem.id, yes: true }).then(() => undefined), "空目录已删除");
    if (succeeded) {
      setSelectedFolder(selectedFolderItem.parentId ?? "all");
      setFolderMode(null);
    }
  }
  const renderFolders = (parentId: string | null) => folders
    .filter((folder) => folder.parentId === parentId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "zh-CN"))
    .map((folder) => (
      <div className="folder-node" key={folder.id}>
        <button className={selectedFolder === folder.id ? "active" : ""} style={{ paddingLeft: `${12 + (folder.depth - 1) * 18}px` }} onClick={() => { setSelectedFolder(folder.id); setFolderMode(null); }}><span>▸</span><strong>{folder.name}</strong><small>{folder.knowledgeCount}</small></button>
        {renderFolders(folder.id)}
      </div>
    ));
  const selectedLabel = selectedFolder === "all" ? "全部知识" : selectedFolder === "unfiled" ? "未分类" : folderPath(selectedFolder);
  const allowedParents = folderOptions.filter((folder) => folder.depth < 3 && (folderMode !== "edit" || (folder.id !== selectedFolderItem?.id && !descendantsOfSelected.has(folder.id))));

  return (
    <section className="manager-card knowledge-manager">
      <div className="knowledge-primary-actions">
        <p>只有已建立索引并启用的资料才参与智能体检索。</p>
        <button className="primary" disabled={busy} onClick={() => setUploadOpen(true)}>上传知识</button>
      </div>
      {uploadOpen && (
        <div className="knowledge-upload-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeUpload(); }}>
          <form className="knowledge-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-upload-title" onSubmit={(event) => void add(event)}>
            <div className="knowledge-upload-heading">
              <div><h2 id="knowledge-upload-title">上传知识</h2><p>支持 Markdown、文本、PDF 和 Word；上传后还需建立索引并启用。</p></div>
              <button type="button" aria-label="关闭上传知识" disabled={busy} onClick={closeUpload}>×</button>
            </div>
            <div className="knowledge-upload-fields">
              <label>保存到目录<select aria-label="上传到目录" value={uploadFolderId} onChange={(event) => setUploadFolderId(event.target.value)}><option value="">未分类</option>{folderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folderPath(folder.id)}</option>)}</select></label>
              <label>来源说明（可选）<input aria-label="知识来源" placeholder="例如：客户提供资料" value={source} onChange={(event) => setSource(event.target.value)}/></label>
              <label className="knowledge-file-picker"><span>{file?.name ?? "选择知识文件"}</span><small>Markdown、TXT、PDF 或 DOCX</small><input aria-label="选择知识文件" type="file" accept=".md,.markdown,.txt,.pdf,.docx" required onChange={(event) => setFile(event.target.files?.[0] ?? null)}/></label>
            </div>
            <div className="knowledge-upload-actions"><button type="button" disabled={busy} onClick={closeUpload}>取消</button><button className="primary" disabled={busy || file === null}>确认上传</button></div>
          </form>
        </div>
      )}
      <div className="knowledge-workspace">
        <aside className="knowledge-folders">
          <div className="folder-title"><strong>知识目录</strong><button disabled={busy} onClick={() => startCreate(null)}>新建目录</button></div>
          <nav aria-label="知识目录树">
            <button className={selectedFolder === "all" ? "active system-folder" : "system-folder"} onClick={() => { setSelectedFolder("all"); setFolderMode(null); }}><span>▦</span><strong>全部知识</strong><small>{items.length}</small></button>
            <button className={selectedFolder === "unfiled" ? "active system-folder" : "system-folder"} onClick={() => { setSelectedFolder("unfiled"); setFolderMode(null); }}><span>□</span><strong>未分类</strong><small>{items.filter((item) => item.folderId === null).length}</small></button>
            {renderFolders(null)}
          </nav>
          {selectedFolderItem !== null && <div className="folder-actions"><button disabled={busy || selectedFolderItem.depth >= 3} onClick={() => startCreate(selectedFolderItem.id)}>新建子目录</button><button disabled={busy} onClick={startEdit}>编辑目录</button><button className="danger-link" disabled={busy} onClick={() => void deleteSelectedFolder()}>删除空目录</button></div>}
          {folderMode !== null && <form className="folder-form" onSubmit={(event) => void saveFolder(event)}><strong>{folderMode === "edit" ? "编辑目录" : "新建目录"}</strong><label>目录名称<input autoFocus required maxLength={40} value={folderName} onChange={(event) => setFolderName(event.target.value)}/></label><label>上级目录<select value={folderParentId} onChange={(event) => setFolderParentId(event.target.value)}><option value="">根目录</option>{allowedParents.map((folder) => <option key={folder.id} value={folder.id}>{folderPath(folder.id)}</option>)}</select></label><div><button type="button" onClick={() => setFolderMode(null)}>取消</button><button className="primary" disabled={busy}>保存</button></div></form>}
        </aside>
        <div className="knowledge-list">
          <div className="manager-toolbar">
            <label className="filter-field">搜索当前视图<input aria-label="搜索知识资料" placeholder="按名称、目录、来源或错误搜索" value={listQuery} onChange={(event) => setListQuery(event.target.value)}/></label>
            <label className="filter-field filter-status">状态筛选<select aria-label="筛选知识状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as KnowledgeStatusFilter)}><option value="all">全部状态</option><option value="processing">待建索引</option><option value="indexed">已建索引</option><option value="enabled">已启用</option><option value="disabled">已停用</option><option value="index_failed">索引失败</option></select></label>
            <div className="knowledge-view-note"><strong>{selectedLabel}</strong><small>只显示本层资料，不包含子目录</small></div>
          </div>
          {editing !== null && <form className="content-form knowledge-edit-form" data-testid="knowledge-edit-form" onSubmit={(event) => void saveEdit(event)}><div className="form-grid"><label>知识名称<input required value={editName} onChange={(event) => setEditName(event.target.value)}/></label><label>来源说明（可留空）<input value={editSource} onChange={(event) => setEditSource(event.target.value)}/></label></div>{editError !== "" && <div className="form-error" role="alert">{editError}</div>}<div className="form-actions"><button type="button" onClick={() => setEditing(null)}>取消编辑</button><button className="primary" disabled={busy}>保存修改</button></div></form>}
          {filteredItems.length === 0 ? <Empty icon="知" title={items.length === 0 ? "还没有知识资料" : "当前目录没有匹配知识"} text={items.length === 0 ? "先创建目录或直接上传到未分类，建立索引并启用后再做检索测试。" : "切换目录、搜索词或状态筛选后继续。"}/> : (
            <div className="table-wrap"><table><thead><tr><th>资料</th><th>所在目录</th><th>状态 / 下一步</th><th>操作</th></tr></thead><tbody>{filteredItems.map((item) => (
              <tr key={item.id}>
                <td className="knowledge-item-copy"><strong>{item.name}</strong><small>{item.source || "未填写来源"}{item.parseError ? ` · ${item.parseError}` : ""}</small></td>
                <td className="knowledge-folder-cell"><span>{item.folderId === null ? "未分类" : folderPath(item.folderId)}</span>{movingItemId === item.id ? <select autoFocus aria-label={`移动知识 ${item.name}`} value={item.folderId ?? ""} disabled={busy} onChange={(event) => void moveItem(item, event.target.value)} onBlur={() => setMovingItemId(null)}><option value="">未分类</option>{folderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folderPath(folder.id)}</option>)}</select> : <button className="table-link" disabled={busy} onClick={() => setMovingItemId(item.id)}>移动</button>}</td>
                <td className="knowledge-state-cell"><span className={`status ${item.status}`}>{knowledgeStatusLabels[item.status]}</span>{item.status !== "enabled" && <small className="next-step">{item.status === "processing" ? "下一步：建立索引" : item.status === "indexed" ? "下一步：启用后参与检索" : item.status === "disabled" ? "需要时重新启用" : `需更换文件：${item.parseError ?? "解析失败"}`}</small>}</td>
                <td className="row-actions knowledge-row-actions"><button disabled={busy || editing?.id === item.id} onClick={() => openEdit(item)}>{editing?.id === item.id ? "正在编辑" : "编辑"}</button>{item.status === "processing" && <button disabled={busy} onClick={() => void action(item, "index")}>建立索引</button>}{(item.status === "indexed" || item.status === "disabled") && <button disabled={busy} onClick={() => void action(item, "enable")}>启用</button>}{item.status === "enabled" && <button disabled={busy} onClick={() => void action(item, "disable")}>停用</button>}{item.status !== "enabled" && <button disabled={busy} onClick={() => void remove(item)}>删除</button>}</td>
              </tr>
            ))}</tbody></table></div>
          )}
          <details className="knowledge-search-test"><summary>检索测试 <span>验证启用资料能否被问题命中</span></summary><form className="search-test" onSubmit={(event) => void search(event)}><label>全库检索测试<input required placeholder="输入客户可能询问的问题" value={query} onChange={(event) => setQuery(event.target.value)}/></label><button disabled={busy}>测试检索</button></form>{hits.length > 0 && <div className="search-results">{hits.map((hit, index) => <article key={`${hit.knowledgeId}-${index}`}><strong>{hit.name}</strong><p>{hit.snippet}</p></article>)}</div>}</details>
        </div>
      </div>
    </section>
  );
}

function Empty({ icon, title, text }: { icon: string; title: string; text: string }) { return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{text}</p></div>; }
