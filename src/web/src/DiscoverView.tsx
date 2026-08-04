/**
 * 学一学内容视图（legacy /discover 迁入薄壳）：科普文章 / 操作视频 /
 * 调理方案三个 tab，数据全部来自 browse 只读命令的已发布内容。
 * 方案 tab 在 candidate 门禁下 list 返回空是设计行为，如实展示
 * “暂未开放”；任何读取失败只提示重试，不用假数据填充。
 */

import { useEffect, useRef, useState } from "react";

import {
  listCarePlans,
  listContentCategories,
  listPublicContent,
  showCarePlan,
  showPublicContent,
  type CarePlanDetail,
  type CarePlanSummary,
  type PublicContent
} from "./discover";

type DiscoverTab = "article" | "video" | "plan";

export default function DiscoverView() {
  const [tab, setTab] = useState<DiscoverTab>("article");
  const [items, setItems] = useState<PublicContent[]>([]);
  const [plans, setPlans] = useState<CarePlanSummary[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState("");
  const [selectedContent, setSelectedContent] = useState<PublicContent | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<CarePlanDetail | null>(null);
  const contentRequest = useRef(0);
  const detailRequest = useRef(0);

  useEffect(() => {
    const requestVersion = contentRequest.current + 1;
    contentRequest.current = requestVersion;
    setSelectedContent(null);
    setSelectedPlan(null);
    setCategory("all");
    setCategories([]);
    setItems([]);
    setPlans([]);
    setNotice("");
    setStatus("loading");
    const load = async () => {
      try {
        if (tab === "plan") {
          const planItems = await listCarePlans();
          if (contentRequest.current !== requestVersion) return;
          setPlans(planItems);
        } else {
          const [contentItems, categoryItems] = await Promise.all([
            listPublicContent(tab),
            tab === "video" ? listContentCategories("video") : Promise.resolve([])
          ]);
          if (contentRequest.current !== requestVersion) return;
          setItems(contentItems);
          setCategories(categoryItems);
        }
        setStatus("ready");
      } catch (error) {
        if (contentRequest.current !== requestVersion) return;
        setStatus("error");
        setNotice(error instanceof Error ? error.message : "内容暂时无法加载，请稍后重试");
      }
    };
    void load();
  }, [tab]);

  async function openContent(item: PublicContent) {
    const requestVersion = detailRequest.current + 1;
    detailRequest.current = requestVersion;
    try {
      const detail = await showPublicContent(item.kind, item.id);
      if (detailRequest.current !== requestVersion) return;
      setSelectedContent(detail);
    } catch {
      if (detailRequest.current === requestVersion) {
        setNotice("内容详情暂时无法加载，请稍后重试");
      }
    }
  }

  async function openPlan(plan: CarePlanSummary) {
    const requestVersion = detailRequest.current + 1;
    detailRequest.current = requestVersion;
    try {
      const detail = await showCarePlan(plan.id);
      if (detailRequest.current !== requestVersion) return;
      setSelectedPlan(detail);
    } catch {
      if (detailRequest.current === requestVersion) {
        setNotice("方案详情暂时无法加载，请稍后重试");
      }
    }
  }

  const visibleItems = tab === "video" && category !== "all"
    ? items.filter((item) => item.category === category)
    : items;

  return (
    <div className="discover-view" data-testid="discover-view">
      <nav className="discover-tabs" aria-label="内容类型">
        <button type="button" className={tab === "article" ? "active" : ""} onClick={() => setTab("article")}>科普文章</button>
        <button type="button" className={tab === "video" ? "active" : ""} onClick={() => setTab("video")}>操作视频</button>
        <button type="button" className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>调理方案</button>
      </nav>

      {tab === "video" && (
        <div className="discover-filter-row" aria-label="视频分类筛选">
          <button type="button" className={category === "all" ? "active" : ""} aria-pressed={category === "all"} onClick={() => setCategory("all")}>全部</button>
          {categories.map((item) => (
            <button type="button" key={item} className={category === item ? "active" : ""} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>
          ))}
        </div>
      )}

      {notice && <p className={`discover-notice ${status === "error" ? "error-text" : ""}`} role="alert">{notice}</p>}
      {status === "loading" && <p className="discover-notice">正在读取已发布内容…</p>}

      {status === "ready" && tab !== "plan" && visibleItems.length > 0 && (
        <section className="discover-grid">
          {visibleItems.map((item) => (
            <article
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => void openContent(item)}
              onKeyDown={(event) => { if (event.key === "Enter") void openContent(item); }}
            >
              <div className="discover-tags"><i>{item.category || "未分类"}</i></div>
              {item.kind === "article" && item.coverUrl && (
                <img className="discover-card-image" src={item.coverUrl} alt={`${item.title}配图`} loading="lazy" onClick={(event) => event.stopPropagation()} />
              )}
              <h2>{item.title}</h2>
              <p>{item.summary || "点击查看内容详情"}</p>
              {item.kind === "video" && item.mediaUrl && (
                <video controls preload="metadata" src={item.mediaUrl} onClick={(event) => event.stopPropagation()} />
              )}
            </article>
          ))}
        </section>
      )}

      {status === "ready" && tab === "plan" && plans.length > 0 && (
        <section className="discover-grid">
          {plans.map((plan) => (
            <article
              key={plan.id}
              role="button"
              tabIndex={0}
              onClick={() => void openPlan(plan)}
              onKeyDown={(event) => { if (event.key === "Enter") void openPlan(plan); }}
            >
              <div className="discover-tags"><i>调理方案</i></div>
              <h2>{plan.name}</h2>
              <p>点击查看方案步骤与注意事项</p>
            </article>
          ))}
        </section>
      )}

      {status === "ready" && tab === "plan" && plans.length === 0 && (
        <section className="discover-empty" data-testid="discover-empty">
          <h2>调理方案暂未开放</h2>
          <p>方案内容暂未开放，开放后将在此展示。</p>
        </section>
      )}

      {status === "ready" && tab !== "plan" && visibleItems.length === 0 && (
        <section className="discover-empty" data-testid="discover-empty">
          <h2>{tab === "video" && category !== "all" ? "暂无该分类的已发布视频" : "暂无已发布内容，发布后将出现在这里"}</h2>
        </section>
      )}

      {selectedContent && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="内容详情">
          <article className="discover-detail" data-testid="discover-detail">
            <button type="button" onClick={() => setSelectedContent(null)} aria-label="关闭内容详情">×</button>
            <div className="discover-tags"><i>{selectedContent.category || "未分类"}</i></div>
            <h2>{selectedContent.title}</h2>
            {selectedContent.kind === "article" && selectedContent.coverUrl && (
              <img className="discover-detail-image" src={selectedContent.coverUrl} alt={`${selectedContent.title}配图`} />
            )}
            {selectedContent.kind === "video" && selectedContent.mediaUrl && (
              <video className="discover-detail-video" controls preload="metadata" src={selectedContent.mediaUrl} />
            )}
            <p className="discover-detail-body">{selectedContent.body ?? selectedContent.summary}</p>
            <p className="discover-detail-meta">来源：{selectedContent.source} · 更新于 {selectedContent.updatedAt.slice(0, 10)}</p>
            <footer>{selectedContent.disclaimer}</footer>
          </article>
        </div>
      )}

      {selectedPlan && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="方案详情">
          <article className="discover-detail" data-testid="discover-detail">
            <button type="button" onClick={() => setSelectedPlan(null)} aria-label="关闭方案详情">×</button>
            <h2>{selectedPlan.name}</h2>
            {selectedPlan.summary && <p className="discover-detail-body">{selectedPlan.summary}</p>}
            {selectedPlan.steps.length > 0 && (
              <ol className="discover-plan-steps">
                {selectedPlan.steps.map((step) => (
                  <li key={step.step}>
                    <strong>{step.title}</strong>
                    {step.description && <p>{step.description}</p>}
                  </li>
                ))}
              </ol>
            )}
            {selectedPlan.precautions && <p className="discover-plan-note"><strong>注意事项：</strong>{selectedPlan.precautions}</p>}
            {selectedPlan.risks && <p className="discover-plan-note"><strong>风险提示：</strong>{selectedPlan.risks}</p>}
            {selectedPlan.contraindications && <p className="discover-plan-note"><strong>禁忌事项：</strong>{selectedPlan.contraindications}</p>}
            {selectedPlan.disclaimer && <footer>{selectedPlan.disclaimer}</footer>}
          </article>
        </div>
      )}

      <footer className="discover-footer">内容仅供健康科普与居家管理参考，不能替代门诊诊断。</footer>
    </div>
  );
}
