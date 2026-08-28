import { type ChangeEvent, useRef, useState } from "react";

import type { ContentItem, ContentPreview, MediaItem } from "../admin-contracts";
import { contentStatusLabels, Empty, mediaKindLabels } from "../admin-ui";
import { uploadFile } from "../client";
import { ContentBody } from "../content-body";
import { appendBodyAttachment } from "../content-body-editing";

type RunAdminAction = (action: () => Promise<void>, success: string) => Promise<boolean>;
type BodyChange = string | ((current: string) => string);

export function ContentBodyEditor({ label, value, onChange, run }: { label: string; value: string; onChange: (value: BodyChange) => void; run: RunAdminAction }) {
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const [uploadMessage, setUploadMessage] = useState("");

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
    setUploadMessage(`正在上传：${file.name}`);
    const succeeded = await run(async () => {
      const media = await uploadFile(file);
      const safeName = file.name.replaceAll("[", "").replaceAll("]", "");
      const snippet = media.kind === "image"
        ? "![" + safeName + "](/v1/media/" + media.id + ")"
        : "[" + safeName + "](/v1/media/" + media.id + ")";
      // 上传期间用户可能继续编辑正文；使用函数式更新合并到完成上传时的
      // 最新正文，不能把 await 之前捕获的旧 value 写回去。
      onChange((current) => appendBodyAttachment(current, snippet));
    }, "正文图片已上传并插入");
    setUploadMessage(succeeded ? `已上传并插入：${file.name}` : `上传失败：${file.name}，可重新选择重试`);
  }

  return (
    <div className="body-editor">
      <label>{label}<textarea ref={textarea} aria-label={label} rows={7} value={value} onChange={(event) => onChange(event.target.value)} /></label>
      <div className="body-toolbar">
        <button type="button" onClick={() => insert("## 小标题\n\n")}>插入小标题</button>
        <button type="button" onClick={() => insert("- 重点内容\n")}>插入列表</button>
        <button type="button" onClick={() => insert("[链接文字](https://example.com)")}>插入链接</button>
        <label className="body-upload">上传正文图片或附件<input aria-label="上传正文图片或附件" type="file" accept="image/*,.jpg,.jpeg,.png,.webp,.gif,.pdf,.doc,.docx,.md,.markdown,.txt" onChange={(event) => void uploadBodyFile(event)} /></label>
      </div>
      {uploadMessage !== "" && <small className="inline-upload-status" aria-live="polite">{uploadMessage}</small>}
    </div>
  );
}

export function MediaBinding({ label, selectedId, items, accept, mediaKind, busy, run, onSelect }: { label: string; selectedId: string | null; items: MediaItem[]; accept: string; mediaKind: "image" | "video"; busy: boolean; run: RunAdminAction; onSelect: (id: string | null) => void }) {
  const [uploadMessage, setUploadMessage] = useState("");
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    setUploadMessage(`正在上传：${file.name}`);
    const succeeded = await run(async () => {
      const media = await uploadFile(file, mediaKind);
      onSelect(media.id);
    }, label + "已上传并已选中");
    setUploadMessage(succeeded ? `已上传并选中：${file.name}` : `上传失败：${file.name}，可重新选择重试`);
  }

  return (
    <div className="media-binding">
      <label>{label}<select aria-label={label} value={selectedId ?? ""} onChange={(event) => onSelect(event.target.value || null)}>
        <option value="">不设置（草稿可暂留空）</option>
        {items.map((item) => <option key={item.id} value={item.id}>{item.filename} · {mediaKindLabels[item.kind] ?? item.kind}</option>)}
      </select></label>
      <label className="media-upload-choice">直接上传{mediaKind === "image" ? "封面图片" : "视频文件"}<input aria-label={"直接上传" + label} type="file" accept={accept} disabled={busy} onChange={(event) => void upload(event)} /></label>
      <small className="form-hint">只接受{mediaKind === "image" ? "图片" : "视频"}；上传后会立即绑定到当前{mediaKind === "image" ? "内容封面" : "视频"}，也可选择已上传文件复用。</small>
      {uploadMessage !== "" && <small className="inline-upload-status" aria-live="polite">{uploadMessage}</small>}
    </div>
  );
}

export function PatientContentPreview({ item, onClose }: { item: ContentPreview; onClose: () => void }) {
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

export function ContentTable({ items, emptyText, busy, onEdit, onPreview, onToggle }: { items: ContentItem[]; emptyText: string; busy: boolean; onEdit: (item: ContentItem) => void; onPreview: (item: ContentItem) => Promise<void>; onToggle: (item: ContentItem) => Promise<void> }) {
  if (items.length === 0) return <Empty icon="稿" title={emptyText} text={emptyText === "还没有内容" ? "先新增一条草稿，确认展示效果后再发布。" : "调整搜索词或状态筛选后继续。"}/>;
  return <div className="table-wrap"><table><thead><tr><th>内容</th><th>分类</th><th>状态 / 下一步</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><small>{item.summary || "暂无摘要"}</small></td><td>{item.category || "未分类"}</td><td><span className={`status ${item.status}`}>{contentStatusLabels[item.status]}</span><small className="next-step">{item.status === "draft" ? "下一步：预览并发布" : item.status === "published" ? "用户端当前可见" : "需要时重新预览并发布"}</small></td><td>{new Date(item.updatedAt).toLocaleString("zh-CN")}</td><td className="row-actions"><button disabled={busy} onClick={() => onEdit(item)}>编辑</button><button disabled={busy} onClick={() => void onPreview(item)}>预览</button><button disabled={busy} onClick={() => void onToggle(item)}>{item.status === "published" ? "下架" : "发布"}</button></td></tr>)}</tbody></table></div>;
}
