var api = require("../../utils/request");
var pageUtils = require("../../utils/page");
var bodyParser = require("../../utils/content-body");
var learningCatalog = require("../../utils/learning-catalog");

function contentView(item) {
  return Object.assign({}, item, { coverUrl: api.mediaUrl(item.coverUrl) });
}

function knowledgeView(answer) {
  return Object.assign({}, answer, {
    sources: (answer && answer.sources || []).map(function (source) {
      return Object.assign({}, source, {
        sourceText: source.source ? "（" + source.source + "）" : ""
      });
    })
  });
}

function firstCatalogView(catalogs, audience) {
  var catalog = catalogs.find(function (item) { return item.id === audience; }) || catalogs[0];
  if (!catalog || !catalog.sections[0] || !catalog.sections[0].categories[0]) return null;
  var section = catalog.sections[0];
  var category = section.categories[0];
  return {
    catalog: catalog,
    activeSectionId: section.id,
    activeSectionLabel: section.label,
    activeCategories: section.categories,
    activeCategoryId: category.id,
    activeCategory: category
  };
}

Page({
  data: {
    kind: "video",
    audience: "adult",
    catalogs: [],
    catalog: { sections: [] },
    activeSectionId: "",
    activeSectionLabel: "",
    activeCategories: [],
    activeCategoryId: "",
    activeCategory: null,
    items: [],
    plans: [],
    query: "",
    detail: null,
    detailKind: "",
    bodyNodes: [],
    mediaUrl: "",
    coverUrl: "",
    qaQuestion: "",
    qaAnswer: null,
    qaLoading: false,
    knowledgeAvailable: api.wechatLoginEnabled !== false,
    contentAvailable: api.networkAvailable !== false,
    knowledgeNotice: "",
    loading: true,
    error: ""
  },

  onLoad: function (options) {
    var kind = options && ["article", "video", "plan", "qa"].indexOf(options.kind) >= 0 ? options.kind : "video";
    wx.setNavigationBarTitle({ title: "学一学" });
    this.setData({ kind: kind, knowledgeNotice: kind === "qa" && !this.data.knowledgeAvailable ? "知识问答暂不可用，其他科普内容仍可正常查看。" : "" });
    this.load();
  },

  onShow: function () {
    wx.setNavigationBarTitle({ title: this.data.detail ? (this.data.detail.title || this.data.detail.name || "学一学") : "学一学" });
  },

  switchKind: function (event) {
    var kind = event.currentTarget.dataset.kind;
    if (kind === this.data.kind) return;
    this.setData({ kind: kind, detail: null, detailKind: "", query: "", qaAnswer: null, knowledgeNotice: kind === "qa" && !this.data.knowledgeAvailable ? "知识问答暂不可用，其他科普内容仍可正常查看。" : "" });
    wx.setNavigationBarTitle({ title: "学一学" });
    this.load();
  },

  onSearch: function (event) {
    var query = event.detail.value;
    this.setData({ query: query, items: this.filterItems(this._allItems || [], query) });
  },

  filterItems: function (items, query) {
    var normalized = String(query || "").trim().toLocaleLowerCase();
    var visible = items;
    if (this.data.kind === "video" && this.data.activeCategory) {
      visible = visible.filter(function (item) { return learningCatalog.belongsToCategory(item, this.data.activeCategory); }.bind(this));
    }
    if (!normalized) return visible;
    return visible.filter(function (item) {
      return (String(item.title || "") + " " + String(item.summary || "") + " " + String(item.category || "")).toLocaleLowerCase().indexOf(normalized) >= 0;
    });
  },

  chooseAudience: function (event) {
    var view = firstCatalogView(this.data.catalogs, event.currentTarget.dataset.id);
    if (!view) return;
    this.setData(Object.assign({ audience: view.catalog.id }, view), function () {
      this.setData({ items: this.filterItems(this._allItems || [], this.data.query) });
    }.bind(this));
  },

  chooseSection: function (event) {
    var sectionId = event.currentTarget.dataset.id;
    var section = this.data.catalog.sections.find(function (item) { return item.id === sectionId; });
    if (!section) return;
    var category = section.categories[0];
    this.setData({ activeSectionId: section.id, activeSectionLabel: section.label, activeCategories: section.categories, activeCategoryId: category.id, activeCategory: category }, function () {
      this.setData({ items: this.filterItems(this._allItems || [], this.data.query) });
    }.bind(this));
  },

  chooseCategory: function (event) {
    var categoryId = event.currentTarget.dataset.id;
    var category = this.data.activeCategories.find(function (item) { return item.id === categoryId; });
    if (!category) return;
    this.setData({ activeCategoryId: category.id, activeCategory: category }, function () {
      this.setData({ items: this.filterItems(this._allItems || [], this.data.query) });
    }.bind(this));
  },

  load: function () {
    var self = this;
    self.setData({ loading: true, error: "", detail: null, detailKind: "" });
    if (self.data.kind === "qa") {
      self.setData({ loading: false });
      return;
    }
    if (api.networkAvailable === false) {
      self.setData({ loading: false, error: pageUtils.errorMessage({ code: "network_unavailable" }) });
      return;
    }
    if (self.data.kind === "plan") {
      api.command("browse plan list", {}, { auth: false })
        .then(function (result) { self.setData({ plans: result.items || [], loading: false }); })
        .catch(function (error) { self.setData({ plans: [], loading: false, error: pageUtils.errorMessage(error) }); });
      return;
    }
    var requests = [api.command("browse " + self.data.kind + " list", { limit: 100, offset: 0 }, { auth: false })];
    if (self.data.kind === "video") requests.push(api.command("browse video category-registry", {}, { auth: false }));
    Promise.all(requests)
      .then(function (results) {
        self._allItems = (results[0].items || []).map(contentView);
        if (self.data.kind === "video") {
          var catalogs = learningCatalog.catalogsFromRegistry(results[1].items || []);
          var view = firstCatalogView(catalogs, self.data.audience);
          if (!view) {
            self.setData({ catalogs: [], items: [], loading: false, error: "视频分类暂不可用，请稍后重试" });
            return;
          }
          self.setData(Object.assign({ catalogs: catalogs, audience: view.catalog.id }, view));
        }
        self.setData({ items: self.filterItems(self._allItems, self.data.query), loading: false });
      })
      .catch(function (error) { self._allItems = []; self.setData({ items: [], loading: false, error: pageUtils.errorMessage(error) }); });
  },

  openItem: function (event) {
    var self = this;
    var id = event.currentTarget.dataset.id;
    if (!id) return;
    self.setData({ loading: true, error: "", detail: null, detailKind: "content" });
    api.command("browse " + self.data.kind + " show", { id: id }, { auth: false })
      .then(function (item) {
        self.setData({ detail: item, mediaUrl: api.mediaUrl(item.mediaUrl), coverUrl: api.mediaUrl(item.coverUrl), bodyNodes: bodyParser.parseContentBody(item.body || item.summary || "", api.mediaUrl), loading: false });
        wx.setNavigationBarTitle({ title: item.title });
      })
      .catch(function (error) { self.setData({ loading: false, error: pageUtils.errorMessage(error) }); });
  },

  openPlan: function (event) {
    var self = this;
    var id = event.currentTarget.dataset.id;
    if (!id) return;
    self.setData({ loading: true, error: "", detail: null, detailKind: "plan" });
    api.command("browse plan show", { id: id }, { auth: false })
      .then(function (plan) {
        self.setData({ detail: Object.assign({}, plan, { steps: Array.isArray(plan.steps) ? plan.steps : [] }), loading: false });
        wx.setNavigationBarTitle({ title: plan.name });
      })
      .catch(function (error) { self.setData({ loading: false, error: pageUtils.errorMessage(error) }); });
  },

  closeDetail: function () {
    this.setData({ detail: null, detailKind: "", error: "" });
    wx.setNavigationBarTitle({ title: "学一学" });
  },

  switchPrimary: function (event) {
    var item = event.currentTarget.dataset;
    if (item.mode === "navigate") wx.navigateTo({ url: item.url });
    else wx.switchTab({ url: item.url });
  },

  onQuestionInput: function (event) { this.setData({ qaQuestion: event.detail.value }); },

  askKnowledge: function () {
    var self = this;
    var question = String(self.data.qaQuestion || "").trim();
    if (question.length < 2 || question.length > 500) {
      self.setData({ error: "问题长度需为 2 到 500 个字符" });
      return;
    }
    self.setData({ qaLoading: true, error: "", qaAnswer: null });
    api.command("agent knowledge ask", { question: question }, { auth: true })
      .then(function (answer) { self.setData({ qaAnswer: knowledgeView(answer), qaLoading: false }); })
      .catch(function (error) { self.setData({ qaLoading: false, error: pageUtils.errorMessage(error) }); });
  }
});
