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
import {
  ADMIN_CONTENT_PAGE_SIZE,
  clampPage,
  itemsForPage,
  pageCountFor
} from "./admin-pagination";
import type {
  CategoryRegistryItem,
  ContentItem,
  KnowledgeFolder,
  KnowledgeHit,
  KnowledgeItem,
  MediaItem,
  MessageItem
} from "./admin-contracts";
import { Empty, knowledgeStatusLabels, Pagination } from "./admin-ui";
import { ContentManager } from "./features/content-manager";
import { MediaManager, MessageManager } from "./features/support-managers";

type Section = "overview" | "article" | "video" | "message" | "knowledge" | "media";

type ContentStatusFilter = "all" | ContentItem["status"];
type KnowledgeStatusFilter = "all" | KnowledgeItem["status"];
type SectionFocus = ContentStatusFilter | KnowledgeStatusFilter | "create";

const navigation: Array<{ key: Section; label: string; icon: string }> = [
  { key: "overview", label: "工作台", icon: "◈" },
  { key: "article", label: "科普文章", icon: "文" },
  { key: "video", label: "视频内容", icon: "播" },
  { key: "message", label: "站内消息", icon: "信" },
  { key: "knowledge", label: "AI知识库", icon: "知" },
  { key: "media", label: "文件管理", icon: "档" }
];

const deliveryNavigation = navigation.filter((item) => item.key === "article" || item.key === "video" || item.key === "knowledge");
const supportNavigation = navigation.filter((item) => item.key === "message");

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
  const [videoCategoryRegistry, setVideoCategoryRegistry] = useState<CategoryRegistryItem[]>([]);
  const [articleCategoryRegistry, setArticleCategoryRegistry] = useState<CategoryRegistryItem[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [synced, setSynced] = useState(false);

  const navigate = useCallback((nextSection: Section, focus: SectionFocus = "all") => {
    setSection(nextSection);
    setSectionFocus(focus);
  }, []);

  const refresh = useCallback(async () => {
    setSynced(false);
    const [articleData, videoData, messageData, mediaData, knowledgeData, folderData, articleRegistryData, videoRegistryData] = await Promise.all([
      adminCommand<{ items: ContentItem[] }>("content article list"),
      adminCommand<{ items: ContentItem[] }>("content video list"),
      adminCommand<{ items: MessageItem[] }>("content message list"),
      adminCommand<{ items: MediaItem[] }>("content media list"),
      adminCommand<{ items: KnowledgeItem[] }>("agent knowledge list"),
      adminCommand<{ items: KnowledgeFolder[] }>("agent knowledge folder list"),
      adminCommand<{ items: CategoryRegistryItem[] }>("content article category-registry"),
      adminCommand<{ items: CategoryRegistryItem[] }>("content video category-registry")
    ]);
    setArticles(articleData.items);
    setVideos(videoData.items);
    setMessages(messageData.items);
    setMedia(mediaData.items);
    setKnowledge(knowledgeData.items);
    setKnowledgeFolders(folderData.items);
    setArticleCategoryRegistry(articleRegistryData.items);
    setVideoCategoryRegistry(videoRegistryData.items);
    setSynced(true);
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
          <span className="admin-nav-label">消息</span>
          {supportNavigation.map((item) => <button data-testid={`admin-nav-${item.key}`} key={item.key} className={section === item.key ? "active" : ""} onClick={() => navigate(item.key)}><i>{item.icon}</i>{item.label}</button>)}
        </nav>
        <div className="admin-account"><span>{session.username?.slice(0, 1).toUpperCase()}</span><div><strong>{session.username}</strong><small>{session.role === "owner" ? "主管理员" : "内容管理员"}</small></div><button onClick={() => void run(async () => { await logout(); setSession(null); }, "已安全退出")}>退出</button></div>
      </aside>
      <section className="admin-main">
        <header className="admin-topbar"><div><small>抗敏先锋 / {current.label}</small><h1>{current.label}</h1><p className="topbar-description">{section === "overview" ? "处理待办，管理小程序内容" : "按状态完成当前运营任务，所有写操作由服务端确认。"}</p></div>{section === "overview" && <span className={`sync-badge${synced ? "" : " pending"}`}><i></i> {synced ? "数据已同步" : "正在同步…"}</span>}</header>
        {notice !== "" && <div className="admin-toast" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>}
        {section === "overview" && (synced ? <Overview articles={articles} videos={videos} messages={messages} knowledge={knowledge} onNavigate={navigate} /> : <section className="workbench-loading" role="status">正在读取服务端内容状态…</section>)}
        {section === "article" && <ContentManager kind="article" items={articles} media={media} categoryRegistry={articleCategoryRegistry} busy={busy} run={run} onOpenFiles={() => navigate("media")} adminKey={session.adminId ?? session.username ?? "admin"} initialCreate={sectionFocus === "create"} initialStatusFilter={sectionFocus === "draft" || sectionFocus === "published" || sectionFocus === "unpublished" ? sectionFocus : "all"} />}
        {section === "video" && <ContentManager kind="video" items={videos} media={media} categoryRegistry={videoCategoryRegistry} busy={busy} run={run} onOpenFiles={() => navigate("media")} adminKey={session.adminId ?? session.username ?? "admin"} initialCreate={sectionFocus === "create"} initialStatusFilter={sectionFocus === "draft" || sectionFocus === "published" || sectionFocus === "unpublished" ? sectionFocus : "all"} />}
        {section === "message" && <MessageManager items={messages} busy={busy} run={run} initialStatusFilter={sectionFocus === "draft" || sectionFocus === "published" || sectionFocus === "unpublished" ? sectionFocus : "all"} />}
        {section === "knowledge" && <KnowledgeFolderManager items={knowledge} folders={knowledgeFolders} busy={busy} run={run} onOpenFiles={() => navigate("media")} initialCreate={sectionFocus === "create"} initialStatusFilter={sectionFocus === "processing" || sectionFocus === "indexed" || sectionFocus === "enabled" || sectionFocus === "disabled" || sectionFocus === "index_failed" ? sectionFocus : "all"} />}
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
  return <main className="admin-login"><section><div className="login-mark">抗</div><small>抗敏先锋 · 鼻健康内容中心</small><h1>管理后台</h1><p>登录后管理客户可见的文章、视频和 AI 知识资料。</p><form onSubmit={(event) => void submit(event)}><label>管理员账号<input data-testid="admin-username" autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label><label>密码<input data-testid="admin-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error !== "" && <div className="form-error" role="alert">{error}</div>}<button data-testid="admin-login" disabled={busy}>{busy ? "正在登录…" : "登录"}</button></form><footer>管理操作会记录审计；医疗内容发布前请完成专业审核。</footer></section></main>;
}

function Overview({ articles, videos, messages, knowledge, onNavigate }: { articles: ContentItem[]; videos: ContentItem[]; messages: MessageItem[]; knowledge: KnowledgeItem[]; onNavigate: (section: Section, focus?: SectionFocus) => void }) {
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
    { section: "article", focus: "draft", icon: "文", title: "文章草稿", detail: "预览效果后再发布到小程序", count: articleDrafts, action: "处理文章", tone: "blue" },
    { section: "video", focus: "draft", icon: "播", title: "视频草稿", detail: "确认素材和说明后再上架", count: videoDrafts, action: "处理视频", tone: "blue" },
    { section: "knowledge", focus: knowledgeFocus, icon: "知", title: "知识索引", detail: knowledgeDetail, count: knowledgeFailed + knowledgeProcessing + knowledgeIndexed, action: "处理知识", tone: knowledgeFailed > 0 ? "red" : "amber" },
    { section: "message", focus: "draft", icon: "信", title: "站内消息草稿", detail: "发布后登录用户可在消息中心看到", count: messageDrafts, action: "处理消息", tone: "green" }
  ];
  const activeTasks = tasks.filter((task) => task.count > 0);
  const summaries: Array<{ section: Section; title: string; total: number; detail: string }> = [
    { section: "article", title: "科普文章", total: articles.length, detail: `${articles.filter((item) => item.status === "published").length} 已发布 · ${articleDrafts} 草稿 · ${articles.filter((item) => item.status === "unpublished").length} 已下架` },
    { section: "video", title: "视频内容", total: videos.length, detail: `${videos.filter((item) => item.status === "published").length} 已发布 · ${videoDrafts} 草稿 · ${videos.filter((item) => item.status === "unpublished").length} 已下架` },
    { section: "knowledge", title: "AI 知识资料", total: knowledge.length, detail: `${knowledge.filter((item) => item.status === "enabled").length} 已启用 · ${knowledgeIndexed} 待启用 · ${knowledgeProcessing + knowledgeFailed} 待处理` },
    { section: "message", title: "站内消息", total: messages.length, detail: `${messages.filter((item) => item.status === "published").length} 已发布 · ${messageDrafts} 草稿 · ${messages.filter((item) => item.status === "unpublished").length} 已下架` }
  ];
  return <div className="admin-overview workbench-overview">
    <section className="workbench-section todo-section" data-testid="workbench-todos"><div className="workbench-heading"><div><h2>今日待办</h2><p>来自服务端的待处理状态，点击直接进入对应列表。</p></div><span className={`queue-count ${attentionTotal > 0 ? "attention" : "clear"}`}>{attentionTotal}</span></div>{activeTasks.length === 0 ? <div className="queue-empty"><strong>今日没有待办</strong><span>当前没有草稿、待索引、待启用或索引失败的内容。</span></div> : <div className="task-list">{activeTasks.map((task) => <button className="task-row" key={task.section} onClick={() => onNavigate(task.section, task.focus)}><span className={`task-mark ${task.tone}`}>{task.icon}</span><span className="task-copy"><strong>{task.title}<em>{task.count}</em></strong><small>{task.detail}</small></span><span className="task-action">{task.action} →</span></button>)}</div>}</section>
    <section className="workbench-section quick-create-section" data-testid="workbench-quick-create"><div className="workbench-heading"><div><h2>快捷新建</h2><p>一步进入对应的新建流程。</p></div></div><div className="quick-create-actions"><button onClick={() => onNavigate("article", "create")}><span>文</span><strong>新建科普文章</strong><small>打开文章编辑器</small></button><button onClick={() => onNavigate("video", "create")}><span>播</span><strong>上传视频</strong><small>打开视频上传与编辑</small></button><button onClick={() => onNavigate("knowledge", "create")}><span>知</span><strong>添加 AI 知识资料</strong><small>上传并建立索引</small></button></div></section>
    <section className="workbench-section overview-section" data-testid="workbench-content-overview"><div className="workbench-heading"><div><h2>内容概览</h2><p>按内容类型查看数量与当前状态。</p></div></div><div className="overview-rows">{summaries.map((item) => <div className="overview-row" key={item.section}><span><strong>{item.title}</strong><small>{item.detail}</small></span><b>{item.total}</b><button onClick={() => onNavigate(item.section)}>查看 →</button></div>)}</div><p className="knowledge-safety-note">AI 知识资料只有已建立索引且已启用后，才会参与 AI 问答。</p></section>
  </div>;
}
function KnowledgeFolderManager({ items, folders, busy, run, onOpenFiles, initialCreate, initialStatusFilter }: { items: KnowledgeItem[]; folders: KnowledgeFolder[]; busy: boolean; run: (action: () => Promise<void>, success: string) => Promise<boolean>; onOpenFiles: () => void; initialCreate: boolean; initialStatusFilter: KnowledgeStatusFilter }) {
  const [file, setFile] = useState<File | null>(null);
  const [knowledgeName, setKnowledgeName] = useState("");
  const [source, setSource] = useState("");
  const [uploadFolderId, setUploadFolderId] = useState("");
  const [uploadOpen, setUploadOpen] = useState(initialCreate);
  const [selectedFolder, setSelectedFolder] = useState<"all" | "unfiled" | string>("all");
  const [query, setQuery] = useState("");
  const [listQuery, setListQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<KnowledgeStatusFilter>(initialStatusFilter);
  const [hits, setHits] = useState<KnowledgeHit[]>([]);
  const [workflowItem, setWorkflowItem] = useState<KnowledgeItem | null>(null);
  const [workflowError, setWorkflowError] = useState("");
  const [editing, setEditing] = useState<KnowledgeItem | null>(null);
  const [editName, setEditName] = useState("");
  const [editSource, setEditSource] = useState("");
  const [editError, setEditError] = useState("");
  const [folderMode, setFolderMode] = useState<"create" | "edit" | null>(null);
  const [folderName, setFolderName] = useState("");
  const [folderParentId, setFolderParentId] = useState("");
  const [movingItemId, setMovingItemId] = useState<string | null>(null);
  const [updatingFileItem, setUpdatingFileItem] = useState<KnowledgeItem | null>(null);
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    setStatusFilter(initialStatusFilter);
    setListQuery("");
    setCurrentPage(1);
  }, [initialStatusFilter]);
  useEffect(() => {
    if (selectedFolder !== "all" && selectedFolder !== "unfiled" && !folders.some((folder) => folder.id === selectedFolder)) {
      setSelectedFolder("all");
    }
  }, [folders, selectedFolder]);
  useEffect(() => {
    setCurrentPage(1);
  }, [listQuery, selectedFolder, statusFilter]);

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
  const totalPages = pageCountFor(filteredItems.length, ADMIN_CONTENT_PAGE_SIZE);
  const effectivePage = clampPage(currentPage, filteredItems.length, ADMIN_CONTENT_PAGE_SIZE);
  const visibleItems = itemsForPage(filteredItems, effectivePage, ADMIN_CONTENT_PAGE_SIZE);
  useEffect(() => {
    if (effectivePage !== currentPage) setCurrentPage(effectivePage);
  }, [currentPage, effectivePage]);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (file === null) return;
    let created: KnowledgeItem | null = null;
    const succeeded = await run(async () => {
      const media = await uploadFile(file);
      created = await adminCommand<KnowledgeItem>("agent knowledge add-from-media", {
        mediaId: media.id,
        name: knowledgeName.trim(),
        source,
        description: "后台上传",
        folderId: uploadFolderId || null
      });
      if (created.status === "processing") {
        created = await adminCommand<KnowledgeItem>("agent knowledge index", { id: created.id });
      }
    }, "资料已上传并完成索引，请先测试再启用");
    if (created !== null) {
      setHits([]);
      setQuery("");
      setWorkflowItem(created);
      setWorkflowError(succeeded ? "" : "自动建立索引未完成，请查看原因后重试");
      setFile(null);
      setKnowledgeName("");
      setSource("");
      setUploadFolderId("");
    }
  }
  function closeUpload() {
    if (busy) return;
    setUploadOpen(false);
    setWorkflowItem(null);
    setWorkflowError("");
    setFile(null);
    setKnowledgeName("");
    setSource("");
    setUploadFolderId("");
  }
  async function action(item: KnowledgeItem, command: "index" | "enable" | "disable") {
    if (command === "disable" && !window.confirm(`停用“${item.name}”后，它将不再参与 AI 问答。确认停用？`)) return;
    const succeeded = await run(() => adminCommand(`agent knowledge ${command}`, { id: item.id, yes: true }).then(() => undefined), command === "index" ? "索引已建立" : command === "enable" ? "知识已启用" : "知识已停用");
    if (succeeded) setStatusFilter("all");
  }
  function openWorkflow(item: KnowledgeItem) {
    setWorkflowItem(item);
    setWorkflowError("");
    setHits([]);
    setQuery("");
    setUploadOpen(true);
  }
  async function indexWorkflow(item: KnowledgeItem) {
    let indexed: KnowledgeItem | null = null;
    const succeeded = await run(async () => {
      indexed = await adminCommand<KnowledgeItem>("agent knowledge index", { id: item.id });
    }, "索引已建立，请完成单资料检索测试");
    if (indexed !== null) setWorkflowItem(indexed);
    setWorkflowError(succeeded ? "" : "建立索引失败，可修正后重试或更新文件");
  }
  async function searchScoped(item: KnowledgeItem) {
    const succeeded = await run(async () => {
      const data = await adminCommand<{ items: KnowledgeHit[] }>("agent knowledge search-test", { id: item.id, query });
      setHits(data.items);
    }, "当前资料检索测试已完成");
    if (!succeeded) setHits([]);
  }
  async function enableWorkflow(item: KnowledgeItem) {
    let enabled: KnowledgeItem | null = null;
    const succeeded = await run(async () => {
      enabled = await adminCommand<KnowledgeItem>("agent knowledge enable", { id: item.id, yes: true });
    }, "知识已明确启用，将参与 AI 问答");
    if (enabled !== null) setWorkflowItem(enabled);
    if (succeeded) setHits([]);
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
  function openUpdateFile(item: KnowledgeItem) {
    setUploadOpen(false);
    setWorkflowItem(null);
    setUpdatingFileItem(item);
    setReplacementFile(null);
  }
  async function updateFile(event: FormEvent) {
    event.preventDefault();
    if (updatingFileItem === null || replacementFile === null) return;
    let replaced: KnowledgeItem | null = null;
    const succeeded = await run(async () => {
      const media = await uploadFile(replacementFile);
      replaced = await adminCommand<KnowledgeItem>("agent knowledge update-file", { id: updatingFileItem.id, mediaId: media.id });
      if (replaced.status === "processing") {
        replaced = await adminCommand<KnowledgeItem>("agent knowledge index", { id: replaced.id });
      }
    }, "文件已更新并重新建立索引，请重新测试后启用");
    if (replaced !== null) {
      setHits([]);
      setQuery("");
      setWorkflowItem(replaced);
      setWorkflowError(succeeded ? "" : "新文件已安全停用，但自动建立索引未完成，请查看原因后重试");
      setUpdatingFileItem(null);
      setReplacementFile(null);
      setUploadOpen(true);
    }
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
        <p>素材库保存原始文件；只有登记到 AI 知识库、建立索引并启用的资料才参与 AI 问答。</p>
        <div className="manager-heading-actions"><button type="button" onClick={onOpenFiles}>文件管理</button><button className="primary" disabled={busy} onClick={() => { setWorkflowItem(null); setUploadOpen(true); }}>新增知识</button></div>
      </div>
      {uploadOpen && (
        <div className="knowledge-upload-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeUpload(); }}>
          <form className="knowledge-upload-dialog knowledge-task-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-upload-title" onSubmit={(event) => { if (workflowItem === null) void add(event); else event.preventDefault(); }}>
            <div className="knowledge-upload-heading">
              <div><h2 id="knowledge-upload-title">{workflowItem === null ? "新增知识" : `维护知识：${workflowItem.name}`}</h2><p>{workflowItem === null ? "一次填写资料和信息；系统随后建立索引，引导测试并由你明确启用。" : "按当前状态完成唯一下一步；关闭后列表位置、目录和筛选保持不变。"}</p></div>
              <button type="button" aria-label="关闭知识任务" disabled={busy} onClick={closeUpload}>×</button>
            </div>
            {workflowItem === null ? <>
              <ol className="knowledge-task-steps" aria-label="新增知识流程"><li className="active">1 上传与信息</li><li>2 建立索引</li><li>3 检索测试</li><li>4 明确启用</li></ol>
              <div className="knowledge-upload-fields">
                <label>知识名称<input aria-label="知识名称" required maxLength={120} placeholder="运营人员可识别的名称" value={knowledgeName} onChange={(event) => setKnowledgeName(event.target.value)}/></label>
                <label>保存到目录<select aria-label="上传到目录" value={uploadFolderId} onChange={(event) => setUploadFolderId(event.target.value)}><option value="">未分类</option>{folderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folderPath(folder.id)}</option>)}</select></label>
                <label>来源说明（可选）<input aria-label="知识来源" placeholder="例如：客户提供资料" value={source} onChange={(event) => setSource(event.target.value)}/></label>
                <label className="knowledge-file-picker"><span>{file?.name ?? "选择知识文件"}</span><small>Markdown、TXT、PDF 或 DOCX</small><input aria-label="选择知识文件" type="file" accept=".md,.markdown,.txt,.pdf,.docx" required onChange={(event) => { const nextFile = event.target.files?.[0] ?? null; setFile(nextFile); if (knowledgeName === "" && nextFile !== null) setKnowledgeName(nextFile.name.replace(/\.[^.]+$/u, "")); }}/></label>
              </div>
              <div className="knowledge-upload-actions"><button type="button" disabled={busy} onClick={closeUpload}>取消</button><button className="primary" disabled={busy || file === null || knowledgeName.trim() === ""}>{busy ? "正在处理…" : "上传并建立索引"}</button></div>
            </> : <KnowledgeWorkflow item={items.find((item) => item.id === workflowItem.id) ?? workflowItem} busy={busy} query={query} setQuery={setQuery} hits={hits} error={workflowError} onIndex={indexWorkflow} onSearch={searchScoped} onEnable={enableWorkflow} onClose={closeUpload} onUpdateFile={openUpdateFile} />}
          </form>
        </div>
      )}
      {editing !== null && <div className="knowledge-upload-backdrop" role="presentation"><form className="knowledge-upload-dialog" data-testid="knowledge-edit-form" role="dialog" aria-modal="true" aria-labelledby="knowledge-edit-title" onSubmit={(event) => void saveEdit(event)}><div className="knowledge-upload-heading"><div><h2 id="knowledge-edit-title">修改信息</h2><p>这里只修改知识名称和来源说明，不会改变文件正文或索引。</p></div><button type="button" aria-label="关闭修改信息" disabled={busy} onClick={() => setEditing(null)}>×</button></div><div className="knowledge-upload-fields"><label>知识名称<input required value={editName} onChange={(event) => setEditName(event.target.value)}/></label><label>来源说明（可留空）<input value={editSource} onChange={(event) => setEditSource(event.target.value)}/></label></div>{editError !== "" && <div className="form-error" role="alert">{editError}</div>}<div className="knowledge-upload-actions"><button type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button><button className="primary" disabled={busy}>保存信息</button></div></form></div>}
      {updatingFileItem !== null && <div className="knowledge-upload-backdrop" role="presentation"><form className="knowledge-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-update-file-title" onSubmit={(event) => void updateFile(event)}><div className="knowledge-upload-heading"><div><h2 id="knowledge-update-file-title">更新文件</h2><p>替换“{updatingFileItem.name}”的正文后会立即停止参与问答，并重新索引、测试和明确启用；失败不会留下半更新。</p></div><button type="button" aria-label="关闭更新文件" disabled={busy} onClick={() => setUpdatingFileItem(null)}>×</button></div><label className="knowledge-file-picker"><span>{replacementFile?.name ?? "选择新知识文件"}</span><small>Markdown、TXT、PDF 或 DOCX</small><input aria-label="选择更新文件" type="file" accept=".md,.markdown,.txt,.pdf,.docx" required onChange={(event) => setReplacementFile(event.target.files?.[0] ?? null)}/></label><div className="knowledge-upload-actions"><button type="button" disabled={busy} onClick={() => setUpdatingFileItem(null)}>取消</button><button className="primary" disabled={busy || replacementFile === null}>{busy ? "正在更新…" : "更新并重建索引"}</button></div></form></div>}
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
          {filteredItems.length === 0 ? <Empty icon="知" title={items.length === 0 ? "还没有知识资料" : "当前目录没有匹配知识"} text={items.length === 0 ? "先创建目录或直接上传到未分类，建立索引并启用后再做检索测试。" : "切换目录、搜索词或状态筛选后继续。"}/> : (
            <><div className="table-wrap"><table><thead><tr><th>资料</th><th>所在目录</th><th>状态 / 下一步</th><th>操作</th></tr></thead><tbody>{visibleItems.map((item) => (
              <tr key={item.id}>
                <td className="knowledge-item-copy"><strong>{item.name}</strong><small>{item.source || "未填写来源"}{item.parseError ? ` · ${item.parseError}` : ""}</small></td>
                <td className="knowledge-folder-cell"><span>{item.folderId === null ? "未分类" : folderPath(item.folderId)}</span>{movingItemId === item.id && <select autoFocus aria-label={`移动知识 ${item.name}`} value={item.folderId ?? ""} disabled={busy} onChange={(event) => void moveItem(item, event.target.value)} onBlur={() => setMovingItemId(null)}><option value="">未分类</option>{folderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folderPath(folder.id)}</option>)}</select>}</td>
                <td className="knowledge-state-cell"><span className={`status ${item.status}`}>{knowledgeStatusLabels[item.status]}</span>{item.status !== "enabled" && <small className="next-step">{item.status === "processing" ? "下一步：建立索引" : item.status === "indexed" ? "下一步：检索测试" : item.status === "disabled" ? "下一步：测试后重新启用" : `下一步：更新文件（${item.parseError ?? "解析失败"}）`}</small>}</td>
                <td className="row-actions knowledge-row-actions">
                  {item.status === "index_failed" ? <button className="primary" disabled={busy} onClick={() => openUpdateFile(item)}>更新文件</button> : item.status === "enabled" ? <button className="primary" disabled={busy} onClick={() => void action(item, "disable")}>停用</button> : <button className="primary" disabled={busy} onClick={() => openWorkflow(item)}>{item.status === "processing" ? "建立索引" : "检索测试"}</button>}
                  <details className="knowledge-more-actions"><summary>更多操作</summary><div><button disabled={busy} onClick={() => openEdit(item)}>修改信息</button><button disabled={busy} onClick={() => openUpdateFile(item)}>更新文件</button><button disabled={busy} onClick={() => setMovingItemId(item.id)}>移动目录</button>{item.status !== "enabled" && <button className="danger-link" disabled={busy} onClick={() => void remove(item)}>删除</button>}</div></details>
                </td>
              </tr>
            ))}</tbody></table></div>{filteredItems.length > ADMIN_CONTENT_PAGE_SIZE && <Pagination currentPage={effectivePage} pageCount={totalPages} totalItems={filteredItems.length} onChange={setCurrentPage} ariaLabel="知识资料分页" />}</>
          )}
          <details className="knowledge-search-test"><summary>全库检索复核 <span>只验证已启用资料；单资料测试在每条资料的下一步中完成</span></summary><form className="search-test" onSubmit={(event) => void search(event)}><label>全库检索问题<input required placeholder="输入客户可能询问的问题" value={query} onChange={(event) => setQuery(event.target.value)}/></label><button disabled={busy}>复核已启用资料</button></form>{hits.length > 0 && <div className="search-results">{hits.map((hit, index) => <article key={`${hit.knowledgeId}-${index}`}><strong>{hit.name}</strong><p>{hit.snippet}</p></article>)}</div>}</details>
        </div>
      </div>
    </section>
  );
}

function KnowledgeWorkflow({ item, busy, query, setQuery, hits, error, onIndex, onSearch, onEnable, onClose, onUpdateFile }: {
  item: KnowledgeItem;
  busy: boolean;
  query: string;
  setQuery: (value: string) => void;
  hits: KnowledgeHit[];
  error: string;
  onIndex: (item: KnowledgeItem) => Promise<void>;
  onSearch: (item: KnowledgeItem) => Promise<void>;
  onEnable: (item: KnowledgeItem) => Promise<void>;
  onClose: () => void;
  onUpdateFile: (item: KnowledgeItem) => void;
}) {
  const step = item.status === "processing" || item.status === "index_failed" ? 2 : item.status === "indexed" || item.status === "disabled" ? 3 : 4;
  return <div className="knowledge-workflow">
    <ol className="knowledge-task-steps" aria-label="知识维护流程"><li>1 上传与信息</li><li className={step === 2 ? "active" : "done"}>2 建立索引</li><li className={step === 3 ? "active" : step > 3 ? "done" : ""}>3 检索测试</li><li className={step === 4 ? "active" : ""}>4 明确启用</li></ol>
    <div className="knowledge-workflow-status"><span className={`status ${item.status}`}>{knowledgeStatusLabels[item.status]}</span><strong>{item.status === "processing" ? "正文已保存，下一步建立索引" : item.status === "index_failed" ? "当前文件无法建立索引" : item.status === "indexed" ? "索引已完成，请只测试当前资料" : item.status === "disabled" ? "资料已停用，重新测试后才能启用" : "资料已启用并参与 AI 问答"}</strong>{item.parseError && <p role="alert">{item.parseError}</p>}{error !== "" && <p role="alert">{error}</p>}</div>
    {item.status === "processing" && <div className="knowledge-workflow-actions"><button type="button" disabled={busy} onClick={() => void onUpdateFile(item)}>更新文件</button><button type="button" className="primary" disabled={busy} onClick={() => void onIndex(item)}>建立索引</button></div>}
    {item.status === "index_failed" && <div className="knowledge-workflow-actions"><button type="button" className="primary" disabled={busy} onClick={() => onUpdateFile(item)}>更新文件并重试</button></div>}
    {(item.status === "indexed" || item.status === "disabled") && <div className="knowledge-scoped-test"><label>只测试当前资料<input required placeholder="输入能由这份资料回答的问题" value={query} onChange={(event) => setQuery(event.target.value)}/></label><button type="button" disabled={busy || query.trim() === ""} onClick={() => void onSearch(item)}>测试当前资料</button>{hits.length > 0 && <div className="search-results">{hits.map((hit, index) => <article key={`${hit.knowledgeId}-${index}`}><strong>{hit.name}</strong><p>{hit.snippet}</p></article>)}</div>}<div className="knowledge-workflow-actions"><small>{hits.length === 0 ? "至少命中一条当前资料结果后，才能明确启用。" : "测试已命中当前资料；启用后才会进入患者全库检索。"}</small><button type="button" className="primary" disabled={busy || hits.length === 0} onClick={() => void onEnable(item)}>明确启用</button></div></div>}
    {item.status === "enabled" && <div className="knowledge-workflow-actions"><small>已完成上传、索引、单资料测试和明确启用。</small><button type="button" className="primary" onClick={onClose}>完成</button></div>}
  </div>;
}
