import assert from "node:assert/strict";
import test from "node:test";
import {
  hasMessageDraft,
  messageDraftStorageKey,
  readMessageDraft,
  writeMessageDraft
} from "../src/message-draft-recovery.js";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  };
}

test("站内消息草稿按管理员隔离并可恢复修订信息", () => {
  const original = globalThis.sessionStorage;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage() });
  try {
    const key = messageDraftStorageKey("owner/one");
    writeMessageDraft(key, {
      version: 1,
      task: "message",
      editingId: "msg-1",
      revision: 3,
      title: "维护通知",
      summary: "摘要",
      body: "正文"
    });
    assert.deepEqual(readMessageDraft(key), {
      version: 1,
      task: "message",
      editingId: "msg-1",
      revision: 3,
      title: "维护通知",
      summary: "摘要",
      body: "正文"
    });
    assert.equal(hasMessageDraft(readMessageDraft(key)), true);
    assert.notEqual(key, messageDraftStorageKey("owner/two"));
  } finally {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: original });
  }
});
