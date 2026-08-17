var pageUtils = require("../../utils/page");
Page({
  onShow: function () { pageUtils.selectTab(this, 1); },
  goCalendar: function () { wx.switchTab({ url: "/pages/calendar/index" }); }
});
