export type KnowledgeDraftRecovery =
  | {
      version: 1;
      task: "create";
      knowledgeName: string;
      source: string;
      uploadFolderId: string;
      fileName: string | null;
    }
  | {
      version: 1;
      task: "update-file";
      itemId: string;
      fileName: string | null;
    }
  | {
      version: 1;
      task: "edit-info";
      itemId: string;
      editName: string;
      editSource: string;
    };

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : isString(value) ? value : undefined;
}

/** 管理员与任务隔离；只把可恢复的文字、ID 和文件名放入浏览器存储。 */
export function knowledgeDraftStorageKey(
  adminKey: string,
  task: KnowledgeDraftRecovery["task"],
  itemId?: string
): string {
  const scope = encodeURIComponent(adminKey);
  const item = itemId === undefined ? "" : "." + encodeURIComponent(itemId);
  return `kangmin.admin.knowledge-draft.${scope}.${task}${item}`;
}

export function hasKnowledgeDraft(draft: KnowledgeDraftRecovery | null): boolean {
  if (draft === null) return false;
  if (draft.task === "create") {
    return draft.fileName !== null || draft.knowledgeName.trim() !== "" || draft.source.trim() !== "" || draft.uploadFolderId !== "";
  }
  if (draft.task === "update-file") return draft.fileName !== null;
  return draft.editName.trim() !== "" || draft.editSource.trim() !== "";
}

export function readKnowledgeDraft(storageKey: string): KnowledgeDraftRecovery | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1 || !isString(parsed.task)) return null;
    if (parsed.task === "create") {
      const fileName = nullableString(parsed.fileName);
      if (!isString(parsed.knowledgeName) || !isString(parsed.source) || !isString(parsed.uploadFolderId) || fileName === undefined) return null;
      return { version: 1, task: "create", knowledgeName: parsed.knowledgeName, source: parsed.source, uploadFolderId: parsed.uploadFolderId, fileName };
    }
    if (parsed.task === "update-file") {
      const fileName = nullableString(parsed.fileName);
      if (!isString(parsed.itemId) || fileName === undefined) return null;
      return { version: 1, task: "update-file", itemId: parsed.itemId, fileName };
    }
    if (parsed.task === "edit-info" && isString(parsed.itemId) && isString(parsed.editName) && isString(parsed.editSource)) {
      return { version: 1, task: "edit-info", itemId: parsed.itemId, editName: parsed.editName, editSource: parsed.editSource };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeKnowledgeDraft(storageKey: string, draft: KnowledgeDraftRecovery): void {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(draft));
  } catch {
    // 浏览器存储不可用时仍保留当前表单和服务端重试能力。
  }
}

export function removeKnowledgeDraft(storageKey: string): void {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // ignore unavailable browser storage
  }
}
