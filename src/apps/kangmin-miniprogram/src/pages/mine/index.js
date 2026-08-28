var api = require("../../utils/request");
var pageUtils = require("../../utils/page");
Page({
  data: {
    privacy: null,
    privacyError: "",
    unreadCount: 0,
    unreadError: "",
    overview: null,
    overviewError: "",
    profile: null,
    profileError: "",
    consentGranted: false,
    consentBusy: false,
    consentError: "",
    privacyOpen: false,
    aboutOpen: false,
    localExperience: api.wechatLoginEnabled === false && api.anonymousRecordsEnabled === true
  },
  onShow: function () {
    var self = this;
    pageUtils.selectTab(this, 4);
    self.setData({ overviewError: "", profileError: "", unreadError: "", consentError: "" });
    api.command("account privacy", {}, { auth: false })
      .then(function (privacy) { self.setData({ privacy: privacy, privacyError: "" }); })
      .catch(function (error) { self.setData({ privacyError: pageUtils.errorMessage(error) }); });
    api.command("record overview", {}, { auth: true })
      .then(function (overview) { self.setData({ overview: overview }); })
      .catch(function (error) { self.setData({ overview: null, overviewError: pageUtils.errorMessage(error) }); });
    api.command("record profile show", {}, { auth: true })
      .then(function (profile) { self.setData({ profile: profile && profile.revision > 0 ? profile : null }); })
      .catch(function (error) { self.setData({ profile: null, profileError: pageUtils.errorMessage(error) }); });
    api.command("account consent show", {}, { auth: true })
      .then(function (result) {
        var item = (result.items || []).find(function (entry) { return entry.consentType === "health_data"; });
        self.setData({ consentGranted: Boolean(item && item.decision === "granted"), consentError: "" });
      })
      .catch(function (error) { self.setData({ consentError: pageUtils.errorMessage(error) }); });
    var unreadRequest = (self._unreadRequest || 0) + 1;
    self._unreadRequest = unreadRequest;
    api.command("browse message unread-count", {}, { auth: true })
      .then(function (result) {
        if (self._unreadRequest !== unreadRequest) return;
        self.setData({ unreadCount: Number(result.count) || 0 });
      })
      .catch(function () {
        if (self._unreadRequest !== unreadRequest) return;
        self.setData({ unreadCount: 0, unreadError: "消息数量暂时无法读取" });
      });
  },
  openLearn: function () { wx.navigateTo({ url: "/pages/learn/index" }); },
  openHealthProfile: function () { wx.navigateTo({ url: "/pages/health-profile/index" }); },
  openCalendar: function () { wx.switchTab({ url: "/pages/calendar/index" }); },
  openMessages: function () { wx.navigateTo({ url: "/pages/messages/index" }); },
  openPrivacy: function () { this.setData({ privacyOpen: true, aboutOpen: false }); },
  openAbout: function () { this.setData({ privacyOpen: false, aboutOpen: true }); },
  closeInfo: function () { this.setData({ privacyOpen: false, aboutOpen: false }); },
  noop: function () {},
  toggleConsent: function () {
    var self = this;
    if (self.data.consentBusy) return;
    var granted = !self.data.consentGranted;
    self.setData({ consentBusy: true, consentError: "" });
    api.command("account consent update", {
      consentType: "health_data",
      decision: granted ? "granted" : "denied",
      policyVersion: self.data.privacy && self.data.privacy.policyVersion || "",
      requestId: "mini-mine-consent-" + Date.now()
    }, { auth: true })
      .then(function () { self.setData({ consentGranted: granted, consentBusy: false, consentError: "" }); })
      .catch(function (error) { self.setData({ consentBusy: false, consentError: pageUtils.errorMessage(error) }); });
  }
});
