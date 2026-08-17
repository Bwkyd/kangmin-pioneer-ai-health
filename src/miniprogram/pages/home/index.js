var api = require("../../utils/request");
var pageUtils = require("../../utils/page");

Page({
  data: {
    overview: null,
    articles: [],
    videos: [],
    featured: null,
    loading: true,
    overviewError: "",
    contentError: ""
  },
  onShow: function () {
    pageUtils.selectTab(this, 0);
    this.load();
  },
  load: function () {
    var self = this;
    self.setData({ loading: true, overviewError: "", contentError: "" });
    api.command("record overview", {}, { auth: true })
      .then(function (overview) { self.setData({ overview: overview }); })
      .catch(function (error) {
        self.setData({
          overview: null,
          overviewError: error && error.code === "capability_unavailable" ? "" : pageUtils.errorMessage(error)
        });
      });
    Promise.all([
      api.command("browse article list", { limit: 3, offset: 0 }, { auth: false }),
      api.command("browse video list", { limit: 3, offset: 0 }, { auth: false })
    ]).then(function (results) {
      var articles = (results[0].items || []).map(function (item) {
        return Object.assign({}, item, { kind: "article", coverUrl: api.mediaUrl(item.coverUrl) });
      });
      var videos = (results[1].items || []).map(function (item) {
        return Object.assign({}, item, { kind: "video", coverUrl: api.mediaUrl(item.coverUrl) });
      });
      self.setData({ articles: articles, videos: videos, featured: articles[0] || videos[0] || null });
    }).catch(function (error) {
      self.setData({ contentError: pageUtils.errorMessage(error), featured: null });
    }).finally(function () {
      self.setData({ loading: false });
    });
  },
  openAssessment: function () { wx.navigateTo({ url: "/pages/symptom-edit/index" }); },
  openLearn: function () { wx.navigateTo({ url: "/pages/learn/index" }); },
  openMessages: function () { wx.navigateTo({ url: "/pages/messages/index" }); },
  openAssistant: function () { wx.switchTab({ url: "/pages/assistant/index" }); },
  openCalendar: function () { wx.switchTab({ url: "/pages/calendar/index" }); },
  openFeatured: function () {
    var item = this.data.featured;
    if (!item) { this.openLearn(); return; }
    wx.navigateTo({ url: "/pages/content-detail/index?kind=" + item.kind + "&id=" + encodeURIComponent(item.id) });
  }
});
