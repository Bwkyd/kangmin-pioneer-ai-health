var api = require("../../utils/request");
var pageUtils = require("../../utils/page");
Page({
  data: { privacy: null, privacyError: "", unreadCount: 0 },
  onShow: function () {
    var self = this;
    pageUtils.selectTab(this, 4);
    api.command("account privacy", {}, { auth: false })
      .then(function (privacy) { self.setData({ privacy: privacy, privacyError: "" }); })
      .catch(function (error) { self.setData({ privacyError: pageUtils.errorMessage(error) }); });
    var unreadRequest = (self._unreadRequest || 0) + 1;
    self._unreadRequest = unreadRequest;
    api.command("browse message unread-count", {}, { auth: true })
      .then(function (result) {
        if (self._unreadRequest !== unreadRequest) return;
        self.setData({ unreadCount: Number(result.count) || 0 });
      })
      .catch(function () {
        if (self._unreadRequest !== unreadRequest) return;
        self.setData({ unreadCount: 0 });
      });
  },
  openLearn: function () { wx.navigateTo({ url: "/pages/learn/index" }); },
  openCalendar: function () { wx.switchTab({ url: "/pages/calendar/index" }); },
  openMessages: function () { wx.navigateTo({ url: "/pages/messages/index" }); }
});
