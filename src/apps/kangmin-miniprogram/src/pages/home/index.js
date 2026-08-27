var api = require("../../utils/request");
var pageUtils = require("../../utils/page");

Page({
  data: {
    overview: null,
    hasOverviewData: false,
    loading: true,
    overviewError: ""
  },
  onShow: function () {
    pageUtils.selectTab(this, 0);
    this.load();
  },
  load: function () {
    var self = this;
    self.setData({ loading: true, overviewError: "" });
    api.command("record overview", {}, { auth: true })
      .then(function (overview) {
        self.setData({
          overview: overview,
          hasOverviewData: Boolean(overview && overview.recentSymptomDate && overview.monthRecordCount > 0),
          loading: false
        });
      })
      .catch(function (error) {
        self.setData({
          overview: null,
          hasOverviewData: false,
          loading: false,
          overviewError: error && error.code === "capability_unavailable" ? "" : pageUtils.errorMessage(error)
        });
      });
  },
  openAllergenRecord: function () { wx.navigateTo({ url: "/pages/health-profile/index?focus=exposure" }); },
  openLearn: function () { wx.navigateTo({ url: "/pages/learn/index" }); },
  openAssistant: function () { wx.switchTab({ url: "/pages/assistant/index" }); },
  openCalendar: function () { wx.switchTab({ url: "/pages/calendar/index" }); }
});
