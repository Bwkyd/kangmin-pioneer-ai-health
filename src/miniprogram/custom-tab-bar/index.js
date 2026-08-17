Component({
  data: {
    selected: 0,
    items: [
      { pagePath: "/pages/home/index", text: "首页", iconClass: "nav-home" },
      { pagePath: "/pages/assistant/index", text: "问助手", iconClass: "nav-chat" },
      { pagePath: "/pages/symptom-edit/index", text: "记录", glyph: "+", action: true },
      { pagePath: "/pages/calendar/index", text: "日历", iconClass: "nav-calendar" },
      { pagePath: "/pages/mine/index", text: "我的", iconClass: "nav-profile" }
    ]
  },
  methods: {
    switchTab: function (event) {
      var item = event.currentTarget.dataset.item;
      if (item.action) {
        wx.navigateTo({ url: item.pagePath });
        return;
      }
      wx.switchTab({ url: item.pagePath });
    }
  }
});
