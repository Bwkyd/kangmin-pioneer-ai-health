var api = require("../../utils/request");
var dates = require("../../utils/date");
var pageUtils = require("../../utils/page");

Page({
  data: {
    date: dates.localDateValue(),
    today: dates.localDateValue(),
    scores: { sneezing: 0, runnyNose: 0, nasalCongestion: 0, nasalItching: 0 },
    current: null,
    consentGranted: false,
    policyVersion: "",
    privacyStatement: "",
    consentAccepted: false,
    loading: true,
    saving: false,
    error: ""
  },
  onLoad: function (options) {
    if (options && /^\d{4}-\d{2}-\d{2}$/.test(options.date || "")) {
      this.setData({ date: options.date });
    }
    this.loadConsent();
  },
  loadConsent: function () {
    var self = this;
    self.setData({ loading: true, error: "" });
    Promise.all([
      api.command("account consent show", {}, { auth: true }),
      api.command("account privacy", {}, { auth: false })
    ]).then(function (results) {
      var item = (results[0].items || []).find(function (entry) {
        return entry.consentType === "health_data";
      });
      var granted = Boolean(item && item.decision === "granted");
      self.setData({
        consentGranted: granted,
        policyVersion: results[1].policyVersion,
        privacyStatement: results[1].statement,
        loading: false
      });
      if (granted) self.loadRecord();
    }).catch(function (error) {
      self.setData({ loading: false, error: pageUtils.errorMessage(error) });
    });
  },
  toggleConsent: function () { this.setData({ consentAccepted: !this.data.consentAccepted }); },
  grantConsent: function () {
    var self = this;
    if (!self.data.consentAccepted) {
      wx.showToast({ title: "请先阅读并同意", icon: "none" });
      return;
    }
    self.setData({ loading: true, error: "" });
    api.command("account consent update", {
      consentType: "health_data",
      decision: "granted",
      policyVersion: self.data.policyVersion,
      requestId: "mini-consent-" + Date.now()
    }, { auth: true }).then(function () {
      self.setData({ consentGranted: true, loading: false });
      self.loadRecord();
    }).catch(function (error) {
      self.setData({ loading: false, error: pageUtils.errorMessage(error) });
    });
  },
  loadRecord: function () {
    var self = this;
    api.command("record symptom list", {}, { auth: true }).then(function (result) {
      var current = (result.items || []).find(function (item) { return item.localDate === self.data.date; }) || null;
      self.setData({
        current: current,
        scores: current ? {
          sneezing: current.sneezing,
          runnyNose: current.runnyNose,
          nasalCongestion: current.nasalCongestion,
          nasalItching: current.nasalItching
        } : { sneezing: 0, runnyNose: 0, nasalCongestion: 0, nasalItching: 0 },
        loading: false
      });
    }).catch(function (error) {
      self.setData({ loading: false, error: pageUtils.errorMessage(error) });
    });
  },
  changeDate: function (event) {
    this.setData({ date: event.detail.value, current: null });
    if (this.data.consentGranted) this.loadRecord();
  },
  changeScore: function (event) {
    var key = event.currentTarget.dataset.key;
    this.setData({ ["scores." + key]: Number(event.detail.value) });
  },
  save: function () {
    var self = this;
    var current = self.data.current;
    var input = Object.assign({}, self.data.scores);
    var name;
    if (current) {
      name = "record symptom update";
      input.id = current.id;
      input.expectedRevision = current.revision;
    } else {
      name = "record symptom add";
      input.localDate = self.data.date;
      input.notes = null;
      input.idempotencyKey = "mini-symptom-" + self.data.date;
    }
    self.setData({ saving: true, error: "" });
    api.command(name, input, { auth: true }).then(function () {
      wx.showToast({ title: "已保存", icon: "success" });
      setTimeout(function () { wx.switchTab({ url: "/pages/calendar/index" }); }, 350);
    }).catch(function (error) {
      self.setData({ saving: false, error: pageUtils.errorMessage(error) });
    });
  }
});
