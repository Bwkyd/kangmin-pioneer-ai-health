var api = require("../../utils/request");
var pageUtils = require("../../utils/page");
Page({
  data: { privacy: null, privacyError: "" },
  onShow: function () {
    var self = this;
    pageUtils.selectTab(this, 4);
    api.command("account privacy", {}, { auth: false })
      .then(function (privacy) { self.setData({ privacy: privacy, privacyError: "" }); })
      .catch(function (error) { self.setData({ privacyError: pageUtils.errorMessage(error) }); });
  },
  openLearn: function () { wx.navigateTo({ url: "/pages/learn/index" }); },
  openCalendar: function () { wx.switchTab({ url: "/pages/calendar/index" }); }
});
