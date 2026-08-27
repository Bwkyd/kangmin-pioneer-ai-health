import { type ChangeEvent, type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import {
  ADMIN_CONTENT_PAGE_SIZE,
  clampPage,
  itemsForPage,
  pageCountFor
} from "../admin-pagination";
import type { CategoryRegistryItem, ContentItem, ContentKind, ContentPreview, MediaItem } from "../admin-contracts";
import { Pagination } from "../admin-ui";
import { adminCommand, uploadFile } from "../client";
import { ContentBodyEditor, ContentTable, MediaBinding, PatientContentPreview } from "./content-views";

type ContentStatusFilter = "all" | ContentItem["status"];

const blank = (kind: ContentKind): Omit<ContentItem, "id" | "revision" | "status" | "updatedAt"> => ({ kind, title: "", category: "", categoryIds: [], summary: "", body: "", source: "", coverMediaId: null, mediaId: null, instructions: "", precautions: "", disclaimer: "", displayOrder: 0 });

/**
 * 列表响应还可能包含 publishedAt、methodTags 等服务端字段。编辑表单只保留页面明确
 * 可编辑的字段，避免把隐藏元数据（尤其空 methodTags）原样回传并触发更新契约校验。
 */
function editableContent(item: ContentItem): ReturnType<typeof blank> {
  return {
    kind: item.kind,
    title: item.title,
    category: item.category,
    categoryIds: item.categoryIds,
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

function hasDraftContent(draft: DraftContent): boolean {
  return draft.categoryIds.length > 0 || [
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

export function ContentManager({
  kind,
  items,
  media,
  categoryRegistry,
  busy,
  run,
  onOpenFiles,
  adminKey,
  initialCreate,
  initialStatusFilter
}: {
  kind: ContentKind;
  items: ContentItem[];
  media: MediaItem[];
  categoryRegistry: CategoryRegistryItem[];
  busy: boolean;
  run: (action: () => Promise<void>, success: string) => Promise<boolean>;
  onOpenFiles: () => void;
  adminKey: string;
  initialCreate: boolean;
  initialStatusFilter: ContentStatusFilter;
}) {
  const [editing, setEditing] = useState<ContentItem | null>(null);
  const [draft, setDraft] = useState(blank(kind));
  const [showForm, setShowForm] = useState(initialCreate);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ContentStatusFilter>(initialStatusFilter);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [previewItem, setPreviewItem] = useState<ContentPreview | null>(null);
  const [videoUploadMessage, setVideoUploadMessage] = useState("");
  const [recovery, setRecovery] = useState<DraftRecovery | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const storageKey = "kangmin.admin.content-draft." + adminKey + "." + kind;
  const label = kind === "article" ? "文章" : "视频";
  const readyMedia = media.filter((item) => item.status === "ready");
  const selectableRegistry = useMemo(() => categoryRegistry.filter((item) =>
    item.status === "active" && item.selectable
  ), [categoryRegistry]);
  const registryById = useMemo(() => new Map(categoryRegistry.map((item) => [item.id, item])), [categoryRegistry]);
  const categoryPath = useCallback((item: CategoryRegistryItem) => {
    const names = [item.name];
    let parentId = item.parentId;
    while (parentId !== null) {
      const parent = registryById.get(parentId);
      if (parent === undefined) break;
      names.unshift(parent.name);
      parentId = parent.parentId;
    }
    return names.join(" / ");
  }, [registryById]);
  const filterCategories = selectableRegistry;
  const videoCategoryGroups = useMemo(() => categoryRegistry
    .filter((item) => item.status === "active" && item.nodeType === "audience")
    .sort((left, right) => left.displayOrder - right.displayOrder)
    .map((audience) => ({
      audience,
      groups: categoryRegistry
        .filter((item) => item.status === "active" && item.parentId === audience.id)
        .sort((left, right) => left.displayOrder - right.displayOrder)
        .map((group) => ({
          group,
          leaves: selectableRegistry
            .filter((item) => item.parentId === group.id)
            .sort((left, right) => left.displayOrder - right.displayOrder)
        }))
    })), [categoryRegistry, selectableRegistry]);
  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      const matchesStatus = statusFilter === "all" || item.status === statusFilter;
      const matchesCategory = categoryFilter === "all" || item.categoryIds.includes(categoryFilter);
      const matchesQuery = normalized === "" || [item.title, item.summary, item.category].join(" ").toLocaleLowerCase().includes(normalized);
      return matchesStatus && matchesCategory && matchesQuery;
    });
  }, [categoryFilter, items, query, statusFilter]);
  const pageCount = kind === "video" ? pageCountFor(filteredItems.length) : 1;
  const safePage = kind === "video" ? clampPage(currentPage, filteredItems.length) : 1;
  const visibleItems = kind === "video" ? itemsForPage(filteredItems, safePage) : filteredItems;
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
    setCategoryFilter("all");
    setCurrentPage(1);
  }, [initialStatusFilter]);

  useEffect(() => {
    if (currentPage !== safePage) setCurrentPage(safePage);
  }, [currentPage, safePage]);

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
    setVideoUploadMessage("");
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
      const { category: _derivedCategory, ...writableDraft } = draft;
      const input = { ...writableDraft, kind: undefined, idempotencyKey: crypto.randomUUID() } as Record<string, unknown>;
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
    setVideoUploadMessage(`正在上传：${file.name}`);
    const succeeded = await run(async () => {
      const mediaItem = await uploadFile(file, "video");
      setDraft((current) => ({ ...current, mediaId: mediaItem.id }));
    }, "视频文件已上传并选中");
    setVideoUploadMessage(succeeded ? `已上传：${file.name}` : `上传失败：${file.name}，可重新选择重试`);
  }

  async function previewContent(item: ContentItem) {
    await run(async () => {
      const data = await adminCommand<ContentPreview>("content " + kind + " preview", { id: item.id });
      setPreviewItem(data);
    }, "患者端预览已打开");
  }

  async function toggle(item: ContentItem) {
    const action = item.status === "published" ? "unpublish" : "publish";
    const succeeded = await run(
      () => adminCommand("content " + kind + " " + action, { id: item.id, expectedRevision: item.revision, yes: true }).then(() => undefined),
      action === "publish" ? label + "已发布，用户端现在可见" : label + "已下架，用户端已不可见"
    );
    if (succeeded && kind !== "video") setStatusFilter("all");
  }

  return (
    <section className="manager-card">
      <div className="manager-heading">
        <div>
          <span className="section-kicker">内容运营 / {kind === "article" ? "科普内容" : "视频内容"}</span>
          <h2>{label}管理</h2>
          <p>先保存不完整草稿，再用患者端预览确认效果；发布前由服务端校验内容、分类和素材。</p>
        </div>
        <div className="manager-heading-actions"><button type="button" onClick={onOpenFiles}>文件管理</button><button type="button" className="primary" onClick={() => open()}>新增{label}</button></div>
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
        <label className="filter-field">搜索{label}<input aria-label={"搜索" + label} placeholder="按标题、摘要或分类搜索" value={query} onChange={(event) => { setQuery(event.target.value); setCurrentPage(1); }} /></label>
        <label className="filter-field filter-category">分类筛选<select aria-label={`筛选${label}分类`} value={categoryFilter} onChange={(event) => { setCategoryFilter(event.target.value); setCurrentPage(1); }}><option value="all">全部分类</option>{filterCategories.map((category) => <option key={category.id} value={category.id}>{categoryPath(category)}</option>)}</select></label>
        <label className="filter-field filter-status">状态筛选<select aria-label={"筛选" + label + "状态"} value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as ContentStatusFilter); setCurrentPage(1); }}><option value="all">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="unpublished">已下架</option></select></label>
        <div className="status-summary"><strong>{filteredItems.length}</strong><span>筛选结果</span><small>{draftCount} 条草稿 · {publishedCount} 条已发布</small></div>
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
                  {videoUploadMessage !== "" && <small className="inline-upload-status" aria-live="polite">{videoUploadMessage}</small>}
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
                {kind === "article" && <label>文章分类<select value={draft.categoryIds[0] ?? ""} onChange={(event) => setDraft({ ...draft, categoryIds: event.target.value === "" ? [] : [event.target.value] })}><option value="">未选择（草稿可暂留空）</option>{selectableRegistry.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
              </div>
              {kind === "video" && <fieldset className="category-registry-select"><legend>视频分类（可多选）</legend><p>按适用人群、方案类别、细分类逐级选择；跨人群内容必须分别勾选。</p>{videoCategoryGroups.map(({ audience, groups }) => <section key={audience.id}><h3>{audience.name}</h3>{groups.map(({ group, leaves }) => <div className="category-registry-group" key={group.id}><strong>{group.name}</strong><div>{leaves.map((category) => { const fullPath = categoryPath(category); return <label key={category.id}><input aria-label={fullPath} type="checkbox" checked={draft.categoryIds.includes(category.id)} onChange={(event) => setDraft((current) => ({ ...current, categoryIds: event.target.checked ? [...new Set([...current.categoryIds, category.id])] : current.categoryIds.filter((id) => id !== category.id) }))} /><span>{category.name}<small>{fullPath}</small></span></label>; })}</div></div>)}</section>)}{selectableRegistry.length === 0 && <small>暂无可用视频分类，请核对 truth 与迁移状态。</small>}</fieldset>}
              {kind === "article" && <p className="form-hint">文章统一归入“科普文章”，按最近更新时间排序；时间不是分类。</p>}
              <label>摘要<textarea rows={2} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label>
              <ContentBodyEditor label={kind === "article" ? "正文" : "视频说明"} value={draft.body} onChange={(body) => setDraft((current) => ({ ...current, body }))} run={run} />
              <details className="content-advanced">
                <summary>更多设置（来源、封面）</summary>
                <div className="form-grid">
                  <label>来源<input value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })} /></label>
                  <MediaBinding label="封面图片" selectedId={draft.coverMediaId} items={readyMedia.filter((item) => item.kind === "image")} accept="image/*,.jpg,.jpeg,.png,.webp,.gif" mediaKind="image" busy={busy} run={run} onSelect={(id) => setDraft((current) => ({ ...current, coverMediaId: id }))} />
                </div>
                {kind === "video" && <label>选择已上传视频<select aria-label="选择已上传视频" value={draft.mediaId ?? ""} onChange={(event) => setDraft((current) => ({ ...current, mediaId: event.target.value || null }))}><option value="">未选择</option>{readyMedia.filter((item) => item.kind === "video").map((item) => <option key={item.id} value={item.id}>{item.filename}</option>)}</select></label>}
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
      <ContentTable items={visibleItems} emptyText={query.trim() !== "" || statusFilter !== "all" || categoryFilter !== "all" ? "没有匹配内容" : "还没有内容"} busy={busy} onEdit={open} onPreview={previewContent} onToggle={toggle} />
      {kind === "video" && filteredItems.length > ADMIN_CONTENT_PAGE_SIZE && (
        <Pagination currentPage={safePage} pageCount={pageCount} totalItems={filteredItems.length} onChange={setCurrentPage} ariaLabel="视频列表分页" />
      )}
      {previewItem !== null && <PatientContentPreview item={previewItem} onClose={() => setPreviewItem(null)} />}
    </section>
  );
}


