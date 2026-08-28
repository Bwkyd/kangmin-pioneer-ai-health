import assert from "node:assert/strict";
import test from "node:test";
import {
  hasKnowledgeDraft,
  knowledgeDraftStorageKey,
  readKnowledgeDraft,
  writeKnowledgeDraft
} from "../src/knowledge-draft-recovery.js";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  };
}

test("知识草稿键按管理员、任务和资料隔离，不保存原始文件", () => {
  const first = knowledgeDraftStorageKey("owner/one", "create");
  const second = knowledgeDraftStorageKey("owner/one", "update-file", "knowledge-1");
  const otherAdmin = knowledgeDraftStorageKey("owner/two", "create");
  assert.notEqual(first, second);
  assert.notEqual(first, otherAdmin);
  assert.match(first, /owner%2Fone/u);

  const original = globalThis.sessionStorage;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage() });
  try {
    writeKnowledgeDraft(first, {
      version: 1,
      task: "create",
      knowledgeName: "鼻健康资料",
      source: "客户资料",
      uploadFolderId: "folder-1",
      fileName: "鼻健康.md"
    });
    const raw = globalThis.sessionStorage.getItem(first) ?? "";
    assert.doesNotMatch(raw, /fileData|base64|正文内容/u);
    assert.deepEqual(readKnowledgeDraft(first), {
      version: 1,
      task: "create",
      knowledgeName: "鼻健康资料",
      source: "客户资料",
      uploadFolderId: "folder-1",
      fileName: "鼻健康.md"
    });
    assert.equal(hasKnowledgeDraft(readKnowledgeDraft(first)), true);
  } finally {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: original });
  }
});

test("损坏或带未知任务的知识草稿 fail-closed", () => {
  const original = globalThis.sessionStorage;
  const fake = storage();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: fake });
  try {
    const key = knowledgeDraftStorageKey("owner", "edit-info", "k1");
    fake.setItem(key, JSON.stringify({ version: 1, task: "unknown" }));
    assert.equal(readKnowledgeDraft(key), null);
    fake.setItem(key, "not-json");
    assert.equal(readKnowledgeDraft(key), null);
  } finally {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: original });
  }
});
