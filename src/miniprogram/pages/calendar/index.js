var api = require("../../utils/request");
var dates = require("../../utils/date");
var pageUtils = require("../../utils/page");

Page({
  data: {
    month: dates.monthValue(),
    weekdays: ["日", "一", "二", "三", "四", "五", "六"],
    cells: [],
    trend: [],
    loading: true,
    error: ""
  },
  onShow: function () {
    pageUtils.selectTab(this, 3);
    this.load();
  },
  load: function () {
    var self = this;
    var range = dates.monthRange(self.data.month);
    self.setData({ loading: true, error: "" });
    Promise.all([
      api.command("record calendar", { month: self.data.month }, { auth: true }),
      api.command("record trend", range, { auth: true })
    ]).then(function (results) {
      var trend = (results[1].items || []).map(function (item) {
        return Object.assign({}, item, {
          height: Math.max(8, Math.round((item.tnssTotal / 12) * 180)),
          shortDate: item.localDate.slice(5)
        });
      });
      self.setData({
        cells: dates.buildCalendarCells(self.data.month, results[0].days || []),
        trend: trend,
        loading: false
      });
    }).catch(function (error) {
      self.setData({ loading: false, error: pageUtils.errorMessage(error), cells: [], trend: [] });
    });
  },
  previousMonth: function () {
    this.setData({ month: dates.shiftMonth(this.data.month, -1) });
    this.load();
  },
  nextMonth: function () {
    this.setData({ month: dates.shiftMonth(this.data.month, 1) });
    this.load();
  },
  openDate: function (event) {
    var cell = event.currentTarget.dataset.cell;
    if (!cell || cell.muted) return;
    wx.navigateTo({ url: "/pages/symptom-edit/index?date=" + cell.date });
  },
  addToday: function () {
    wx.navigateTo({ url: "/pages/symptom-edit/index?date=" + dates.localDateValue() });
  }
});
