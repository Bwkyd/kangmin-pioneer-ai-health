export interface MessageDraftRecovery {
  version: 1;
  task: "message";
  editingId: string | null;
  revision: number | null;
  title: string;
  summary: string;
  body: string;
}

export function messageDraftStorageKey(adminKey: string): string {
  return `kangmin.admin.message-draft.${encodeURIComponent(adminKey)}`;
}

export function hasMessageDraft(draft: MessageDraftRecovery | null): boolean {
  return draft !== null && (draft.title.trim() !== "" || draft.summary.trim() !== "" || draft.body.trim() !== "");
}

export function readMessageDraft(storageKey: string): MessageDraftRecovery | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<MessageDraftRecovery>;
    if (parsed.version !== 1 || parsed.task !== "message") return null;
    if (typeof parsed.title !== "string" || typeof parsed.summary !== "string" || typeof parsed.body !== "string") return null;
    return {
      version: 1,
      task: "message",
      editingId: typeof parsed.editingId === "string" ? parsed.editingId : null,
      revision: typeof parsed.revision === "number" ? parsed.revision : null,
      title: parsed.title,
      summary: parsed.summary,
      body: parsed.body
    };
  } catch {
    return null;
  }
}

export function writeMessageDraft(storageKey: string, draft: MessageDraftRecovery): void {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(draft));
  } catch {
    // 浏览器存储不可用时仍保留当前表单和服务端草稿能力。
  }
}

export function removeMessageDraft(storageKey: string): void {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // ignore unavailable browser storage
  }
}
