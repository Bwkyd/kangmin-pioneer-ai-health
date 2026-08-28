import { type FormEvent, useEffect, useMemo, useState } from "react";

import {
  ADMIN_CONTENT_PAGE_SIZE,
  clampPage,
  itemsForPage,
  pageCountFor
} from "../admin-pagination";
import type { KnowledgeFolder, KnowledgeHit, KnowledgeItem } from "../admin-contracts";
import { Empty, knowledgeStatusLabels, Pagination } from "../admin-ui";
import { adminCommand, uploadFile } from "../client";
import {
  hasKnowledgeDraft,
  knowledgeDraftStorageKey,
  readKnowledgeDraft,
  removeKnowledgeDraft,
  type KnowledgeDraftRecovery,
  writeKnowledgeDraft
} from "../knowledge-draft-recovery";

type KnowledgeStatusFilter = "all" | KnowledgeItem["status"];

export function KnowledgeFolderManager({ items, folders, busy, run, onOpenFiles, adminKey, initialCreate, initialStatusFilter }: { items: KnowledgeItem[]; folders: KnowledgeFolder[]; busy: boolean; run: (action: () => Promise<void>, success: string) => Promise<boolean>; onOpenFiles: () => void; adminKey: string; initialCreate: boolean; initialStatusFilter: KnowledgeStatusFilter }) {
  const createStorageKey = knowledgeDraftStorageKey(adminKey, "create");
  const [file, setFile] = useState<File | null>(null);
  const [knowledgeName, setKnowledgeName] = useState("");
  const [source, setSource] = useState("");
  const [uploadFolderId, setUploadFolderId] = useState("");
  const [uploadOpen, setUploadOpen] = useState(initialCreate);
  const [selectedFolder, setSelectedFolder] = useState<"all" | "unfiled" | string>("all");
  const [scopedQuery, setScopedQuery] = useState("");
  const [scopedHits, setScopedHits] = useState<KnowledgeHit[]>([]);
  const [fullQuery, setFullQuery] = useState("");
  const [fullHits, setFullHits] = useState<KnowledgeHit[]>([]);
  const [fullSearchCompleted, setFullSearchCompleted] = useState(false);
  const [listQuery, setListQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<KnowledgeStatusFilter>(initialStatusFilter);
  const [workflowItem, setWorkflowItem] = useState<KnowledgeItem | null>(null);
  const [workflowError, setWorkflowError] = useState("");
  const [editing, setEditing] = useState<KnowledgeItem | null>(null);
  const [editName, setEditName] = useState("");
  const [editSource, setEditSource] = useState("");
  const [editError, setEditError] = useState("");
  const [editRecovery, setEditRecovery] = useState<KnowledgeDraftRecovery | null>(null);
  const [folderMode, setFolderMode] = useState<"create" | "edit" | null>(null);
  const [folderName, setFolderName] = useState("");
  const [folderParentId, setFolderParentId] = useState("");
  const [movingItemId, setMovingItemId] = useState<string | null>(null);
  const [updatingFileItem, setUpdatingFileItem] = useState<KnowledgeItem | null>(null);
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [updateRecovery, setUpdateRecovery] = useState<KnowledgeDraftRecovery | null>(null);
  const [createRecovery, setCreateRecovery] = useState<KnowledgeDraftRecovery | null>(() => readKnowledgeDraft(createStorageKey));
  const [createFileNameHint, setCreateFileNameHint] = useState<string | null>(() => {
    const saved = readKnowledgeDraft(createStorageKey);
    return saved?.task === "create" ? saved.fileName : null;
  });
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

  function createDraft(): KnowledgeDraftRecovery {
    return {
      version: 1,
      task: "create",
      knowledgeName,
      source,
      uploadFolderId,
      // 只保存文件名提示，不保存 File、文件内容或 base64。
      fileName: file?.name ?? createFileNameHint
    };
  }

  function persistCreateDraft() {
    const draft = createDraft();
    if (hasKnowledgeDraft(draft)) writeKnowledgeDraft(createStorageKey, draft);
    else removeKnowledgeDraft(createStorageKey);
  }

  function clearSearchResults() {
    setScopedQuery("");
    setScopedHits([]);
    setFullQuery("");
    setFullHits([]);
    setFullSearchCompleted(false);
  }

  function restoreCreate() {
    if (createRecovery?.task !== "create") return;
    const saved = createRecovery;
    setKnowledgeName(saved.knowledgeName);
    setSource(saved.source);
    setUploadFolderId(saved.uploadFolderId);
    // 浏览器不能恢复本地 File；恢复文字后要求重新选择文件。
    setFile(null);
    setCreateFileNameHint(saved.fileName);
    setCreateRecovery(null);
    setWorkflowItem(null);
    setUploadOpen(true);
  }

  function openCreate() {
    if (createRecovery !== null) {
      restoreCreate();
      return;
    }
    setWorkflowItem(null);
    setKnowledgeName("");
    setSource("");
    setUploadFolderId("");
    setFile(null);
    setCreateFileNameHint(null);
    setUploadOpen(true);
  }

  useEffect(() => {
    if (initialCreate && uploadOpen && workflowItem === null && createRecovery !== null) restoreCreate();
  }, [createRecovery, initialCreate, uploadOpen, workflowItem]);

  useEffect(() => {
    if (!uploadOpen || workflowItem !== null) return;
    persistCreateDraft();
  }, [createFileNameHint, createRecovery, file, knowledgeName, source, uploadFolderId, uploadOpen, workflowItem]);

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
      removeKnowledgeDraft(createStorageKey);
      setCreateRecovery(null);
      clearSearchResults();
      setWorkflowItem(created);
      setWorkflowError(succeeded ? "" : "自动建立索引未完成，请查看原因后重试");
      setFile(null);
      setCreateFileNameHint(null);
      setKnowledgeName("");
      setSource("");
      setUploadFolderId("");
    }
  }
  function closeUpload() {
    if (busy) return;
    if (workflowItem === null && (hasKnowledgeDraft(createDraft()) || createRecovery !== null)) {
      if (!window.confirm("当前知识任务还有未保存信息，确定放弃吗？文件不会保存到浏览器，之后需要重新选择。")) return;
      removeKnowledgeDraft(createStorageKey);
      setCreateRecovery(null);
      setCreateFileNameHint(null);
    }
    setUploadOpen(false);
    setWorkflowItem(null);
    setWorkflowError("");
    clearSearchResults();
    setFile(null);
    setCreateFileNameHint(null);
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
    clearSearchResults();
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
      const data = await adminCommand<{ items: KnowledgeHit[] }>("agent knowledge search-test", { id: item.id, query: scopedQuery });
      setScopedHits(data.items);
    }, "当前资料检索测试已完成");
    if (!succeeded) setScopedHits([]);
  }
  async function enableWorkflow(item: KnowledgeItem) {
    let enabled: KnowledgeItem | null = null;
    const succeeded = await run(async () => {
      enabled = await adminCommand<KnowledgeItem>("agent knowledge enable", { id: item.id, yes: true });
    }, "知识已明确启用，将参与 AI 问答");
    if (enabled !== null) setWorkflowItem(enabled);
    if (succeeded) {
      setScopedQuery("");
      setScopedHits([]);
    }
  }
  function openEdit(item: KnowledgeItem) {
    const saved = readKnowledgeDraft(knowledgeDraftStorageKey(adminKey, "edit-info", item.id));
    setEditing(item);
    setEditName(saved?.task === "edit-info" && saved.itemId === item.id ? saved.editName : item.name);
    setEditSource(saved?.task === "edit-info" && saved.itemId === item.id ? saved.editSource : item.source ?? "");
    setEditRecovery(saved?.task === "edit-info" && saved.itemId === item.id ? saved : null);
    setEditError("");
  }
  function hasUnsavedEdit(): boolean {
    return editing !== null && (editRecovery !== null || editName !== editing.name || editSource !== (editing.source ?? ""));
  }
  function closeEdit() {
    if (busy) return;
    if (hasUnsavedEdit() && !window.confirm("当前修改信息还有未保存内容，确定放弃吗？")) return;
    if (editing !== null) removeKnowledgeDraft(knowledgeDraftStorageKey(adminKey, "edit-info", editing.id));
    setEditing(null);
    setEditRecovery(null);
  }
  useEffect(() => {
    if (!hasUnsavedEdit() || editing === null) return;
    writeKnowledgeDraft(knowledgeDraftStorageKey(adminKey, "edit-info", editing.id), {
      version: 1,
      task: "edit-info",
      itemId: editing.id,
      editName,
      editSource
    });
  }, [adminKey, editName, editRecovery, editSource, editing]);
  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (editing === null) return;
    const name = editName.trim();
    if (name === "") {
      setEditError("知识名称不能为空");
      return;
    }
    const succeeded = await run(() => adminCommand("agent knowledge update", { id: editing.id, name, source: editSource.trim() }).then(() => undefined), "知识资料已更新");
    if (succeeded) {
      removeKnowledgeDraft(knowledgeDraftStorageKey(adminKey, "edit-info", editing.id));
      setEditRecovery(null);
      setEditing(null);
    }
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
    const saved = readKnowledgeDraft(knowledgeDraftStorageKey(adminKey, "update-file", item.id));
    setUpdateRecovery(saved?.task === "update-file" && saved.itemId === item.id ? saved : null);
  }
  function closeUpdateFile() {
    if (busy) return;
    if (replacementFile !== null || updateRecovery !== null) {
      if (!window.confirm("当前更新文件任务还有未保存选择，确定放弃吗？文件不会保存到浏览器，之后需要重新选择。")) return;
    }
    if (updatingFileItem !== null) removeKnowledgeDraft(knowledgeDraftStorageKey(adminKey, "update-file", updatingFileItem.id));
    setUpdatingFileItem(null);
    setReplacementFile(null);
    setUpdateRecovery(null);
  }
  useEffect(() => {
    if (updatingFileItem === null) return;
    const fileName = replacementFile?.name ?? (updateRecovery?.task === "update-file" ? updateRecovery.fileName : null);
    const draft: KnowledgeDraftRecovery = { version: 1, task: "update-file", itemId: updatingFileItem.id, fileName };
    if (hasKnowledgeDraft(draft)) writeKnowledgeDraft(knowledgeDraftStorageKey(adminKey, "update-file", updatingFileItem.id), draft);
  }, [adminKey, replacementFile, updateRecovery, updatingFileItem]);
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
      removeKnowledgeDraft(knowledgeDraftStorageKey(adminKey, "update-file", updatingFileItem.id));
      setUpdateRecovery(null);
      clearSearchResults();
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
    const succeeded = await run(async () => {
      const data = await adminCommand<{ items: KnowledgeHit[] }>("agent knowledge search-test", { query: fullQuery });
      // 全库接口本身只检索启用资料；前端再做一次 fail-closed 过滤，避免
      // 未来接口误返未启用命中时把它展示成患者侧可用证据。
      setFullHits(data.items.filter((hit) => hit.enabled));
      setFullSearchCompleted(true);
    }, "检索测试已完成");
    if (!succeeded) {
      setFullHits([]);
      setFullSearchCompleted(false);
    }
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
        <div className="manager-heading-actions"><button type="button" onClick={onOpenFiles}>文件管理</button><button className="primary" disabled={busy} onClick={openCreate}>新增知识</button></div>
      </div>
      {createRecovery !== null && !uploadOpen && <div className="draft-recovery" role="status"><span>发现上次未完成的知识上传信息{createRecovery.task === "create" && createRecovery.fileName !== null ? `（文件：${createRecovery.fileName}）` : ""}。</span><button type="button" onClick={restoreCreate}>恢复未保存信息</button><button type="button" onClick={() => { removeKnowledgeDraft(createStorageKey); setCreateRecovery(null); setCreateFileNameHint(null); }}>放弃恢复</button></div>}
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
                <label className="knowledge-file-picker"><span>{file?.name ?? createFileNameHint ?? "选择知识文件"}</span><small>{createFileNameHint !== null && file === null ? "已恢复名称和说明，请重新选择原文件" : "Markdown、TXT、PDF 或 DOCX"}</small><input aria-label="选择知识文件" type="file" accept=".md,.markdown,.txt,.pdf,.docx" required onChange={(event) => { const nextFile = event.target.files?.[0] ?? null; setFile(nextFile); setCreateFileNameHint(nextFile?.name ?? null); if (knowledgeName === "" && nextFile !== null) setKnowledgeName(nextFile.name.replace(/\.[^.]+$/u, "")); }}/></label>
              </div>
              <div className="knowledge-upload-actions"><button type="button" disabled={busy} onClick={closeUpload}>取消</button><button className="primary" disabled={busy || file === null || knowledgeName.trim() === ""}>{busy ? "正在处理…" : "上传并建立索引"}</button></div>
            </> : <KnowledgeWorkflow item={items.find((item) => item.id === workflowItem.id) ?? workflowItem} busy={busy} query={scopedQuery} setQuery={(value) => { setScopedQuery(value); setScopedHits([]); }} hits={scopedHits} error={workflowError} onIndex={indexWorkflow} onSearch={searchScoped} onEnable={enableWorkflow} onClose={closeUpload} onUpdateFile={openUpdateFile} />}
          </form>
        </div>
      )}
      {editing !== null && <div className="knowledge-upload-backdrop" role="presentation"><form className="knowledge-upload-dialog" data-testid="knowledge-edit-form" role="dialog" aria-modal="true" aria-labelledby="knowledge-edit-title" onSubmit={(event) => void saveEdit(event)}><div className="knowledge-upload-heading"><div><h2 id="knowledge-edit-title">修改信息</h2><p>这里只修改知识名称和来源说明，不会改变文件正文或索引。</p></div><button type="button" aria-label="关闭修改信息" disabled={busy} onClick={closeEdit}>×</button></div>{editRecovery !== null && <p className="draft-recovery" role="status">已恢复上次未保存的名称和来源；保存后会清理恢复记录。</p>}<div className="knowledge-upload-fields"><label>知识名称<input required value={editName} onChange={(event) => setEditName(event.target.value)}/></label><label>来源说明（可留空）<input value={editSource} onChange={(event) => setEditSource(event.target.value)}/></label></div>{editError !== "" && <div className="form-error" role="alert">{editError}</div>}<div className="knowledge-upload-actions"><button type="button" disabled={busy} onClick={closeEdit}>取消</button><button className="primary" disabled={busy}>保存信息</button></div></form></div>}
      {updatingFileItem !== null && <div className="knowledge-upload-backdrop" role="presentation"><form className="knowledge-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-update-file-title" onSubmit={(event) => void updateFile(event)}><div className="knowledge-upload-heading"><div><h2 id="knowledge-update-file-title">更新文件</h2><p>替换“{updatingFileItem.name}”的正文后会立即停止参与问答，并重新索引、测试和明确启用；失败不会留下半更新。</p></div><button type="button" aria-label="关闭更新文件" disabled={busy} onClick={closeUpdateFile}>×</button></div>{updateRecovery?.task === "update-file" && <p className="draft-recovery" role="status">已恢复上次的更新任务{updateRecovery.fileName !== null ? `（原文件：${updateRecovery.fileName}）` : ""}；浏览器不会恢复文件本身，请重新选择。</p>}<label className="knowledge-file-picker"><span>{replacementFile?.name ?? (updateRecovery?.task === "update-file" ? updateRecovery.fileName : null) ?? "选择新知识文件"}</span><small>{updateRecovery?.task === "update-file" && replacementFile === null ? "请重新选择文件后重试" : "Markdown、TXT、PDF 或 DOCX"}</small><input aria-label="选择更新文件" type="file" accept=".md,.markdown,.txt,.pdf,.docx" required onChange={(event) => setReplacementFile(event.target.files?.[0] ?? null)}/></label><div className="knowledge-upload-actions"><button type="button" disabled={busy} onClick={closeUpdateFile}>取消</button><button className="primary" disabled={busy || replacementFile === null}>{busy ? "正在更新…" : "更新并重建索引"}</button></div></form></div>}
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
          <details className="knowledge-search-test"><summary>全库检索复核 <span>只验证已启用资料；单资料测试在每条资料的下一步中完成</span></summary><form className="search-test" onSubmit={(event) => void search(event)}><label>全库检索问题<input required placeholder="输入客户可能询问的问题" value={fullQuery} onChange={(event) => { setFullQuery(event.target.value); setFullHits([]); setFullSearchCompleted(false); }}/></label><button disabled={busy}>复核已启用资料</button></form>{fullSearchCompleted && <KnowledgeSearchResults hits={fullHits} scope="full" />}</details>
        </div>
      </div>
    </section>
  );
}

export function KnowledgeWorkflow({ item, busy, query, setQuery, hits, error, onIndex, onSearch, onEnable, onClose, onUpdateFile }: {
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
    {(item.status === "indexed" || item.status === "disabled") && <div className="knowledge-scoped-test"><label>只测试当前资料<input required placeholder="输入能由这份资料回答的问题" value={query} onChange={(event) => setQuery(event.target.value)}/></label><button type="button" disabled={busy || query.trim() === ""} onClick={() => void onSearch(item)}>测试当前资料</button>{hits.length > 0 && <KnowledgeSearchResults hits={hits} scope="scoped" /> }<div className="knowledge-workflow-actions"><small>{hits.length === 0 ? "至少命中一条当前资料结果后，才能明确启用。" : "测试已命中当前资料；启用后才会进入患者全库检索。"}</small><button type="button" className="primary" disabled={busy || hits.length === 0} onClick={() => void onEnable(item)}>明确启用</button></div></div>}
    {item.status === "enabled" && <div className="knowledge-workflow-actions"><small>已完成上传、索引、单资料测试和明确启用。</small><button type="button" className="primary" onClick={onClose}>完成</button></div>}
  </div>;
}

function KnowledgeSearchResults({ hits, scope }: { hits: KnowledgeHit[]; scope: "scoped" | "full" }) {
  if (hits.length === 0) return <p className="search-empty" role="status">未命中{scope === "full" ? "已启用" : "当前"}资料。</p>;
  return <div className="search-results">{hits.map((hit, index) => <article key={`${hit.knowledgeId}-${index}`}><strong>{hit.name}</strong><small className={`knowledge-hit-scope ${hit.enabled ? "enabled" : "not-enabled"}`}>{hit.enabled ? "已启用，可进入全库检索" : "未启用，仅当前资料测试"}</small><p>{hit.snippet}</p></article>)}</div>;
}
