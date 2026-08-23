import { ContentBody } from "./content-body";
import type { PublicContent } from "./discover";

interface PublicContentModalProps {
  content: PublicContent;
  onClose: () => void;
}

/** 学一学与最终方案共用同一份已发布内容详情弹层。 */
export function PublicContentModal({ content, onClose }: PublicContentModalProps) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="内容详情">
      <article className="discover-detail" data-testid="discover-detail">
        <button type="button" onClick={onClose} aria-label="关闭内容详情">×</button>
        <div className="discover-tags"><i>{content.category || "未分类"}</i></div>
        <h2>{content.title}</h2>
        {content.kind === "article" && content.coverUrl && (
          <img className="discover-detail-image" src={content.coverUrl} alt={`${content.title}配图`} />
        )}
        {content.kind === "video" && content.mediaUrl && (
          <video className="discover-detail-video" controls preload="metadata" src={content.mediaUrl} />
        )}
        <ContentBody body={content.body ?? content.summary} />
        {content.kind === "video" && (content.instructions || content.precautions) && (
          <section className="discover-safety-note" aria-label="视频操作安全说明">
            {content.instructions && <p><strong>操作提示：</strong>{content.instructions}</p>}
            {content.precautions && <p><strong>注意事项：</strong>{content.precautions}</p>}
          </section>
        )}
        <p className="discover-detail-meta">来源：{content.source} · 更新于 {content.updatedAt.slice(0, 10)}</p>
        <footer>{content.disclaimer}</footer>
      </article>
    </div>
  );
}
