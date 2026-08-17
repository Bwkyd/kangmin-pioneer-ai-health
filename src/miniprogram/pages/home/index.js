var api = require("../../utils/request");
var pageUtils = require("../../utils/page");

Page({
  data: {
    overview: null,
    articles: [],
    videos: [],
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
      .catch(function (error) { self.setData({ overviewError: pageUtils.errorMessage(error) }); });
    Promise.all([
      api.command("browse article list", { limit: 3, offset: 0 }, { auth: false }),
      api.command("browse video list", { limit: 3, offset: 0 }, { auth: false })
    ]).then(function (results) {
      self.setData({
        articles: (results[0].items || []).map(function (item) {
          return Object.assign({}, item, { coverUrl: api.mediaUrl(item.coverUrl) });
        }),
        videos: (results[1].items || []).map(function (item) {
          return Object.assign({}, item, { coverUrl: api.mediaUrl(item.coverUrl) });
        })
      });
    }).catch(function (error) {
      self.setData({ contentError: pageUtils.errorMessage(error) });
    }).finally(function () {
      self.setData({ loading: false });
    });
  },
  openAssessment: function () { wx.navigateTo({ url: "/pages/symptom-edit/index" }); },
  openLearn: function () { wx.navigateTo({ url: "/pages/learn/index" }); },
  openAssistant: function () { wx.switchTab({ url: "/pages/assistant/index" }); },
  openCalendar: function () { wx.switchTab({ url: "/pages/calendar/index" }); }
});
