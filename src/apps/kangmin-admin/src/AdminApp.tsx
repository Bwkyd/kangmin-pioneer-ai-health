import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  AdminRequestError,
  adminCommand,
  login,
  logout,
  sessionStatus,
  type AdminSession
} from "./client";
import type {
  CategoryRegistryItem,
  ContentItem,
  KnowledgeFolder,
  KnowledgeItem,
  MediaItem,
  MessageItem
} from "./admin-contracts";
import { ContentManager } from "./features/content-manager";
import { KnowledgeFolderManager } from "./features/knowledge-manager";
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
