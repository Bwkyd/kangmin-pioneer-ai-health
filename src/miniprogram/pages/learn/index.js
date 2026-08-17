var api = require("../../utils/request");
var pageUtils = require("../../utils/page");
Page({
  data: { kind: "article", items: [], loading: true, error: "" },
  onLoad: function (options) {
    if (options && options.kind === "video") this.setData({ kind: "video" });
    this.load();
  },
  switchKind: function (event) {
    var kind = event.currentTarget.dataset.kind;
    if (kind === this.data.kind) return;
    this.setData({ kind: kind });
    this.load();
  },
  load: function () {
    var self = this;
    self.setData({ loading: true, error: "" });
    api.command("browse " + self.data.kind + " list", { limit: 50, offset: 0 }, { auth: false })
      .then(function (result) {
        self.setData({
          items: (result.items || []).map(function (item) {
            return Object.assign({}, item, { coverUrl: api.mediaUrl(item.coverUrl) });
          }),
          loading: false
        });
      })
      .catch(function (error) { self.setData({ items: [], loading: false, error: pageUtils.errorMessage(error) }); });
  },
  openItem: function (event) {
    var id = event.currentTarget.dataset.id;
    wx.navigateTo({ url: "/pages/content-detail/index?kind=" + this.data.kind + "&id=" + encodeURIComponent(id) });
  }
});
