import { type FormEvent, useEffect, useMemo, useState } from "react";

import type { ContentItem, KnowledgeItem, MediaItem, MessageItem } from "../admin-contracts";
import { contentStatusLabels, Empty, knowledgeStatusLabels, mediaKindLabels } from "../admin-ui";
import { adminCommand } from "../client";

type RunAdminAction = (action: () => Promise<void>, success: string) => Promise<boolean>;
type MessageStatusFilter = "all" | MessageItem["status"];

export function MessageManager({ items, busy, run, initialStatusFilter }: { items: MessageItem[]; busy: boolean; run: RunAdminAction; initialStatusFilter: MessageStatusFilter }) {
  const [editing, setEditing] = useState<MessageItem | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<MessageStatusFilter>(initialStatusFilter);
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
  return <section className="manager-card"><div className="manager-heading"><div><span className="section-kicker">消息与素材 / 应用内推送</span><h2>站内消息</h2><p>向登录用户发布应用内消息；支持草稿、编辑、发布和下架，不扩展到微信订阅通知。</p></div><button className="primary" onClick={() => open()}>新建消息</button></div><div className="manager-toolbar"><label className="filter-field">搜索消息<input aria-label="搜索站内消息" placeholder="按标题、摘要或正文搜索" value={query} onChange={(event) => setQuery(event.target.value)}/></label><label className="filter-field filter-status">状态筛选<select aria-label="筛选站内消息状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as MessageStatusFilter)}><option value="all">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="unpublished">已下架</option></select></label><div className="status-summary"><strong>{filteredItems.length}</strong><span>当前显示</span><small>{items.filter((item) => item.status === "draft").length} 条草稿 · 发布后登录用户可见</small></div></div>{showForm && <form className="content-form" onSubmit={(event) => void save(event)}><label>标题<input required value={title} onChange={(event) => setTitle(event.target.value)}/></label><label>摘要<input value={summary} onChange={(event) => setSummary(event.target.value)}/></label><label>正文<textarea required rows={7} value={body} onChange={(event) => setBody(event.target.value)}/></label><div className="form-actions"><button type="button" onClick={() => setShowForm(false)}>取消</button><button className="primary" disabled={busy}>保存草稿</button></div></form>}{filteredItems.length === 0 ? <Empty icon="信" title={items.length === 0 ? "还没有站内消息" : "没有匹配消息"} text={items.length === 0 ? "新建草稿并发布后，登录用户会在消息中心看到。" : "调整搜索词或状态筛选后继续。"}/> : <div className="table-wrap"><table><thead><tr><th>消息</th><th>状态 / 下一步</th><th>发布时间</th><th>操作</th></tr></thead><tbody>{filteredItems.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><small>{item.summary || item.body.slice(0, 48)}</small></td><td><span className={`status ${item.status}`}>{contentStatusLabels[item.status]}</span><small className="next-step">{item.status === "draft" ? "下一步：发布后进入消息中心" : item.status === "published" ? "登录用户当前可见" : "需要时重新发布"}</small></td><td>{item.publishedAt ? new Date(item.publishedAt).toLocaleString("zh-CN") : "—"}</td><td className="row-actions"><button disabled={busy} onClick={() => open(item)}>编辑</button><button disabled={busy} onClick={() => void toggle(item)}>{item.status === "published" ? "下架" : "发布"}</button></td></tr>)}</tbody></table></div>}</section>;
}

const mediaStatusLabels: Record<string, string> = {
  processing: "上传中",
  ready: "可用",
  failed: "上传失败",
  disabled: "已停用"
};

const mediaReferenceEntityLabels = { article: "文章", video: "视频", knowledge: "AI 知识" } as const;
const mediaReferenceRoleLabels = { file: "内容文件", cover: "封面", body: "正文附件", knowledge_source: "知识源文件" } as const;

export function MediaManager({ items, busy, run }: { items: MediaItem[]; busy: boolean; run: RunAdminAction }) {
  const [group, setGroup] = useState<"all" | "image" | "video" | "document">("all");
  const visible = items.filter((item) => group === "all" || (group === "document" ? item.kind !== "image" && item.kind !== "video" : item.kind === group));
  async function remove(item: MediaItem) {
    if (!window.confirm(`确认删除未被使用的文件“${item.filename}”？`)) return;
    await run(
      () => adminCommand("content media delete", { id: item.id, yes: true }).then(() => undefined),
      "未使用文件已删除"
    );
  }
  return (
    <section className="manager-card">
      <div className="manager-heading">
        <div>
          <span className="section-kicker">内容运营 / 辅助工具</span>
          <h2>文件管理</h2>
          <p>查看文件去向并清理未使用文件；新增或替换请回到文章、视频或 AI 知识任务。</p>
        </div>
      </div>
      <div className="media-manager-toolbar" aria-label="文件用途筛选">
        {([['all', '全部文件'], ['image', '图片'], ['video', '视频'], ['document', '知识文件与附件']] as const).map(([value, label]) => <button key={value} className={group === value ? "active" : ""} onClick={() => setGroup(value)}>{label}</button>)}
      </div>
      {visible.length === 0 ? <Empty icon="档" title={items.length === 0 ? "还没有文件" : "该分组没有文件"} text="请回到对应业务任务上传和绑定文件。" /> : (
        <div className="media-grid">
          {visible.map((item) => {
            const references = item.references ?? [];
            return (
            <article key={item.id}>
              <span>{mediaKindLabels[item.kind] ?? item.kind}</span>
              <div className="media-file-copy">
                <strong>{item.filename}</strong>
                <small>{mediaKindLabels[item.kind] ?? item.kind} · {(item.sizeBytes / 1024).toFixed(1)} KB · {mediaStatusLabels[item.status] ?? item.status}</small>
                {item.failureReason && <small className="action-note">{item.failureReason}</small>}
                {references.length === 0 ? <p className="media-unused">未被业务使用</p> : <ul className="media-reference-list">{references.map((reference) => <li key={`${reference.entityType}-${reference.entityId}-${reference.role}`}><strong>{mediaReferenceEntityLabels[reference.entityType]}：{reference.name}</strong><small>{mediaReferenceRoleLabels[reference.role]} · {reference.entityType === "knowledge" ? knowledgeStatusLabels[reference.status as KnowledgeItem["status"]] ?? reference.status : contentStatusLabels[reference.status as ContentItem["status"]] ?? reference.status}</small></li>)}</ul>}
                <button className="media-delete" disabled={busy || references.length > 0} title={references.length > 0 ? "请先在对应业务中更换或移除文件" : undefined} onClick={() => void remove(item)}>{references.length > 0 ? "使用中，不能删除" : "删除文件"}</button>
              </div>
            </article>
          )})}
        </div>
      )}
    </section>
  );
}
