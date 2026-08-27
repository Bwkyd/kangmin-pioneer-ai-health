import type { ContentItem, KnowledgeItem } from "./admin-contracts";

export const knowledgeStatusLabels: Record<KnowledgeItem["status"], string> = {
  processing: "待建索引",
  indexed: "已建索引",
  enabled: "已启用",
  disabled: "已停用",
  index_failed: "索引失败"
};

export const contentStatusLabels: Record<ContentItem["status"], string> = {
  draft: "草稿",
  published: "已发布",
  unpublished: "已下架"
};

export const mediaKindLabels: Record<string, string> = {
  image: "图片",
  video: "视频",
  word: "Word",
  pdf: "PDF",
  markdown: "Markdown"
};

export function Empty({ icon, title, text }: { icon: string; title: string; text: string }) {
  return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{text}</p></div>;
}

export function Pagination({ currentPage, pageCount, totalItems, onChange, ariaLabel }: { currentPage: number; pageCount: number; totalItems: number; onChange: (page: number) => void; ariaLabel: string }) {
  return (
    <nav className="content-pagination" aria-label={ariaLabel}>
      <span>第 {currentPage} / {pageCount} 页 · 共 {totalItems} 条</span>
      <div>
        <button type="button" aria-label="上一页" disabled={currentPage === 1} onClick={() => onChange(currentPage - 1)}>上一页</button>
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
          <button type="button" key={page} aria-label={`第 ${page} 页`} aria-current={page === currentPage ? "page" : undefined} className={page === currentPage ? "active" : ""} onClick={() => onChange(page)}>{page}</button>
        ))}
        <button type="button" aria-label="下一页" disabled={currentPage === pageCount} onClick={() => onChange(currentPage + 1)}>下一页</button>
      </div>
    </nav>
  );
}
