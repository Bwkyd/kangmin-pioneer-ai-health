var api = require("../../utils/request");
var pageUtils = require("../../utils/page");
Page({
  data: { kind: "article", id: "", item: null, mediaUrl: "", coverUrl: "", loading: true, error: "" },
  onLoad: function (options) {
    var kind = options && options.kind === "video" ? "video" : "article";
    var id = options && options.id ? decodeURIComponent(options.id) : "";
    this.setData({ kind: kind, id: id });
    this.load();
  },
  load: function () {
    var self = this;
    if (!self.data.id) {
      self.setData({ loading: false, error: "内容标识缺失" });
      return;
    }
    api.command("browse " + self.data.kind + " show", { id: self.data.id }, { auth: false })
      .then(function (item) {
        self.setData({ item: item, mediaUrl: api.mediaUrl(item.mediaUrl), coverUrl: api.mediaUrl(item.coverUrl), loading: false });
        wx.setNavigationBarTitle({ title: item.title });
      })
      .catch(function (error) { self.setData({ loading: false, error: pageUtils.errorMessage(error) }); });
  }
});
