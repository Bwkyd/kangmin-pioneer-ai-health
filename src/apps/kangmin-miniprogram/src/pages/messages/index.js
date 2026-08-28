var api = require("../../utils/request");
var pageUtils = require("../../utils/page");

function displayDate(value) {
  if (!value) return "时间未知";
  var date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.getFullYear() + "年" + (date.getMonth() + 1) + "月" + date.getDate() + "日";
}

function viewOf(item) {
  return Object.assign({}, item, { displayDate: displayDate(item.publishedAt) });
}

Page({
  data: {
    items: [],
    unreadCount: 0,
    unreadCountKnown: false,
    unreadError: "",
    selected: null,
    loading: true,
    detailLoading: false,
    error: ""
  },
  onLoad: function () {
    this.load();
  },
  onShow: function () {
    if (this._hasLoaded && !this.data.selected && !this.data.loading) this.load();
  },
  nextRequest: function () {
    this._requestVersion = (this._requestVersion || 0) + 1;
    return this._requestVersion;
  },
  isCurrentRequest: function (version) {
    return this._requestVersion === version;
  },
  loadUnreadCount: function (requestVersion) {
    var self = this;
    api.command("browse message unread-count", {}, { auth: true })
      .then(function (result) {
        if (!self.isCurrentRequest(requestVersion)) return;
        var count = Number(result && result.count);
        if (!Number.isInteger(count) || count < 0) {
          throw { code: "bad_response", message: "消息数量返回格式不正确" };
        }
        self.setData({ unreadCount: count, unreadCountKnown: true, unreadError: "" });
      })
      .catch(function (error) {
        if (!self.isCurrentRequest(requestVersion)) return;
        self.setData({ unreadCountKnown: false, unreadError: pageUtils.errorMessage(error) });
      });
  },
  load: function () {
    var self = this;
    var requestVersion = self.nextRequest();
    self._hasLoaded = true;
    self.setData({ loading: true, error: "", unreadError: "", unreadCountKnown: false, selected: null, detailLoading: false });
    self.loadUnreadCount(requestVersion);
    api.command("browse message list", {}, { auth: true })
      .then(function (result) {
        if (!self.isCurrentRequest(requestVersion)) return;
        self.setData({
          items: (result.items || []).map(viewOf),
          loading: false
        });
        wx.setNavigationBarTitle({ title: "消息中心" });
      })
      .catch(function (error) {
        if (!self.isCurrentRequest(requestVersion)) return;
        self.setData({ loading: false, error: pageUtils.errorMessage(error) });
      });
  },
  openItem: function (event) {
    var self = this;
    var id = event.currentTarget.dataset.id;
    if (!id) return;
    var item = self.data.items.find(function (entry) { return entry.id === id; });
    var requestVersion = self.nextRequest();
    self.setData({ selected: item || null, detailLoading: true, error: "" });
    wx.setNavigationBarTitle({ title: "消息详情" });
    api.command("browse message show", { id: id }, { auth: true })
      .then(function (message) {
        if (!self.isCurrentRequest(requestVersion)) return null;
        if (message.readAt !== null) return message;
        return api.command("browse message read", { id: id }, { auth: true });
      })
      .then(function (message) {
        if (!message || !self.isCurrentRequest(requestVersion)) return;
        var next = viewOf(message);
        self.setData({
          selected: next,
          items: self.data.items.map(function (entry) { return entry.id === next.id ? next : entry; }),
          detailLoading: false
        });
        self.loadUnreadCount(requestVersion);
      })
      .catch(function (error) {
        if (!self.isCurrentRequest(requestVersion)) return;
        self.setData({ selected: null, detailLoading: false, error: pageUtils.errorMessage(error) });
      });
  },
  backToList: function () {
    this.nextRequest();
    this.setData({ selected: null, detailLoading: false, error: "" });
    wx.setNavigationBarTitle({ title: "消息中心" });
  },
  retry: function () {
    this.load();
  }
});
