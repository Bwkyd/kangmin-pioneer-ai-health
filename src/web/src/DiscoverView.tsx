/**
 * 学一学内容视图：视频优先，按成人/儿童和方案类别导航。
 * 列表和详情仍全部来自 browse 只读命令的已发布内容，
 * 分类目录只负责导航，不会把待审核内容伪装成可播放视频。
 * 若测试或后续变更注入 candidate 包，方案 tab 返回空是设计行为，如实展示
 * “暂未开放”；任何读取失败只提示重试，不用假数据填充。
 */

import { type FormEvent, useEffect, useRef, useState } from "react";
import { ContentBody } from "./content-body";

import {
  askKnowledge,
  listCarePlans,
  listPublicContent,
  showCarePlan,
  showPublicContent,
  type CarePlanDetail,
  type CarePlanSummary,
  type KnowledgeAnswer,
  type PublicContent
} from "./discover";
import {
  belongsToCategory,
  LEARNING_CATALOGS,
  type LearningAudience
} from "./learning-catalog";

type DiscoverTab = "article" | "video" | "plan" | "qa";

export default function DiscoverView() {
  const [tab, setTab] = useState<DiscoverTab>("video");
  const [items, setItems] = useState<PublicContent[]>([]);
  const [plans, setPlans] = useState<CarePlanSummary[]>([]);
  const [audience, setAudience] = useState<LearningAudience>("adult");
  const [category, setCategory] = useState("adult-quick-content");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState("");
  const [qaQuestion, setQaQuestion] = useState("");
  const [qaAnswer, setQaAnswer] = useState<KnowledgeAnswer | null>(null);
  const [qaBusy, setQaBusy] = useState(false);
  const [selectedContent, setSelectedContent] = useState<PublicContent | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<CarePlanDetail | null>(null);
  const contentRequest = useRef(0);
  const detailRequest = useRef(0);

  useEffect(() => {
    const requestVersion = contentRequest.current + 1;
    contentRequest.current = requestVersion;
    setSelectedContent(null);
    setSelectedPlan(null);
    setQuery("");
    setItems([]);
    setPlans([]);
    setNotice("");
    setStatus("loading");
    const load = async () => {
      try {
        if (tab === "qa") {
          setStatus("ready");
          return;
        }
        if (tab === "plan") {
          const planItems = await listCarePlans();
          if (contentRequest.current !== requestVersion) return;
          setPlans(planItems);
        } else {
          const contentItems = await listPublicContent(tab);
          if (contentRequest.current !== requestVersion) return;
          setItems(contentItems);
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

  async function submitKnowledge(event: FormEvent) {
    event.preventDefault(); setQaBusy(true); setNotice(""); setQaAnswer(null);
    try { setQaAnswer(await askKnowledge(qaQuestion)); }
    catch (error) { setNotice(error instanceof Error ? error.message : "知识问答暂时不可用"); }
    finally { setQaBusy(false); }
  }

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

  const activeCatalog = LEARNING_CATALOGS.find((item) => item.id === audience) ?? LEARNING_CATALOGS[0];
  const activeSection = activeCatalog.sections.find((section) => section.categories.some((item) => item.id === category)) ?? activeCatalog.sections[0];
  const activeCategory = activeSection.categories.find((item) => item.id === category) ?? activeSection.categories[0];
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleItems = items.filter((item) => {
    if (tab === "video" && !belongsToCategory(item, activeCategory)) return false;
    if (!normalizedQuery) return true;
    return `${item.title} ${item.summary} ${item.category}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
  });

  function chooseAudience(nextAudience: LearningAudience) {
    const nextCatalog = LEARNING_CATALOGS.find((item) => item.id === nextAudience) ?? LEARNING_CATALOGS[0];
    setAudience(nextAudience);
    setCategory(nextCatalog.sections[0].categories[0].id);
  }

  return (
    <div className={`discover-view ${tab === "video" ? "video-catalog-view" : ""}`} data-testid="discover-view">
      <nav className="discover-tabs" aria-label="内容类型">
        <button type="button" className={tab === "video" ? "active" : ""} onClick={() => setTab("video")}>操作视频</button>
        <button type="button" className={tab === "article" ? "active" : ""} onClick={() => setTab("article")}>科普文章</button>
        <button type="button" className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>调理方案</button>
        <button type="button" className={tab === "qa" ? "active" : ""} onClick={() => setTab("qa")}>知识问答</button>
      </nav>

      {tab === "video" && (
        <>
          <label className="discover-search">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索穴位、手法或症状" aria-label="搜索学一学视频" />
          </label>
          <div className="discover-audience" aria-label="适用人群">
            {LEARNING_CATALOGS.map((catalog) => (
              <button type="button" key={catalog.id} className={audience === catalog.id ? "active" : ""} aria-pressed={audience === catalog.id} onClick={() => chooseAudience(catalog.id)}>{catalog.label}</button>
            ))}
          </div>
          <p className="discover-catalog-note">按客户确认的内容目录分类，仅用于查找已发布内容，不代表诊断或证型判断。</p>
        </>
      )}

      {notice && <p className={`discover-notice ${status === "error" ? "error-text" : ""}`} role="alert">{notice}</p>}
      {status === "loading" && <p className="discover-notice">正在读取已发布内容…</p>}

      {status === "ready" && tab === "video" && (
        <section className="discover-catalog" data-testid="discover-video-catalog">
          <aside className="discover-category-rail" aria-label="视频方案分类">
            {activeCatalog.sections.map((section) => (
              <button type="button" key={section.id} className={activeSection.id === section.id ? "active" : ""} aria-pressed={activeSection.id === section.id} onClick={() => setCategory(section.categories[0].id)}>{section.label}</button>
            ))}
          </aside>
          <div className="discover-category-content">
            <header>
              <div><small>{activeCatalog.label}</small><h2>{activeSection.label}</h2></div>
              <span>{visibleItems.length} 个已发布</span>
            </header>
            {activeSection.categories.length > 1 && (
              <nav className="discover-subcategories" aria-label={`${activeSection.label}二级分类`}>
                {activeSection.categories.map((item) => (
                  <button type="button" key={item.id} className={activeCategory.id === item.id ? "active" : ""} aria-pressed={activeCategory.id === item.id} onClick={() => setCategory(item.id)}>{item.label}</button>
                ))}
              </nav>
            )}
            {visibleItems.length > 0 ? (
              <div className="discover-video-list">
                {visibleItems.map((item) => (
                  <article key={item.id} role="button" tabIndex={0} onClick={() => void openContent(item)} onKeyDown={(event) => { if (event.key === "Enter") void openContent(item); }}>
                    <span className="discover-play" aria-hidden="true">▶</span>
                    <div><h3>{item.title}</h3><p>{item.summary || "点击查看视频与文字介绍"}</p><small>视频 · 图文介绍</small></div>
                    <b aria-hidden="true">›</b>
                  </article>
                ))}
              </div>
            ) : (
              <div className="discover-category-empty" data-testid="discover-empty">
                <span aria-hidden="true">▷</span>
                <h3>{query.trim() ? "没有找到匹配的已发布视频" : "该分类暂无已发布视频"}</h3>
                <p>后台发布并通过审核后，视频和文字介绍将显示在这里。</p>
              </div>
            )}
          </div>
        </section>
      )}

      {status === "ready" && tab === "article" && visibleItems.length > 0 && (
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

      {status === "ready" && tab === "article" && visibleItems.length === 0 && (
        <section className="discover-empty" data-testid="discover-empty">
          <h2>暂无已发布内容，发布后将出现在这里</h2>
        </section>
      )}

      {status === "ready" && tab === "qa" && (
        <section className="knowledge-qa">
          <h2>问鼻健康知识库</h2><p>优先参考后台已启用资料；没有贴合资料时，也可以回答一般鼻健康问题。</p>
          <form onSubmit={(event) => void submitKnowledge(event)}><textarea required minLength={2} maxLength={500} rows={3} value={qaQuestion} onChange={(event) => setQaQuestion(event.target.value)} placeholder="例如：换季鼻塞时日常护理要注意什么？"/><button disabled={qaBusy}>{qaBusy ? "正在检索…" : "提交问题"}</button></form>
          {qaAnswer && <article><div>{qaAnswer.answer}</div>{qaAnswer.sources.length > 0 && <ul>{qaAnswer.sources.map((source) => <li key={source.knowledgeId}>来源：{source.name}{source.source ? `（${source.source}）` : ""}</li>)}</ul>}<footer>{qaAnswer.disclaimer}</footer></article>}
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
            <ContentBody body={selectedContent.body ?? selectedContent.summary} />
            {selectedContent.kind === "video" && (selectedContent.instructions || selectedContent.precautions) && (
              <section className="discover-safety-note" aria-label="视频操作安全说明">
                {selectedContent.instructions && <p><strong>操作提示：</strong>{selectedContent.instructions}</p>}
                {selectedContent.precautions && <p><strong>注意事项：</strong>{selectedContent.precautions}</p>}
              </section>
            )}
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
