var api = require("../../utils/request");
var pageUtils = require("../../utils/page");

var SEX_LABELS = ["暂不填写", "女", "男", "其他"];
var SEX_VALUES = ["unspecified", "female", "male", "other"];
var ALLERGEN_GROUPS = [
  { name: "环境暴露", options: [{ code: "pollen", label: "花粉" }, { code: "dust_mite", label: "尘螨" }, { code: "mold", label: "霉菌" }, { code: "dust", label: "灰尘" }, { code: "smoke", label: "烟雾" }, { code: "air_pollution", label: "空气污染" }] },
  { name: "接触性物质", options: [{ code: "pet_dander", label: "宠物皮屑或动物毛" }, { code: "fragrance", label: "香水或香味产品" }, { code: "cleaning_products", label: "清洁用品" }, { code: "cosmetics", label: "化妆品或护肤品" }, { code: "metal_latex", label: "金属或乳胶" }] },
  { name: "饮食与作息", options: [{ code: "alcohol", label: "饮酒" }, { code: "spicy_food", label: "辛辣食物" }, { code: "sleep_deprivation", label: "睡眠不足" }, { code: "specific_food", label: "特定食物" }] },
  { name: "活动相关", options: [{ code: "exercise", label: "运动" }, { code: "cold_air", label: "冷空气" }, { code: "outdoor_activity", label: "户外活动" }, { code: "cleaning_bedding", label: "打扫或整理床品" }, { code: "work_study_place", label: "工作或学习场所" }] },
  { name: "其他", options: [{ code: "other", label: "其它（请简要描述）" }, { code: "none_identified", label: "未识别到明确因素" }] }
];

function today() {
  var date = new Date();
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function displayDate(value) {
  if (!value) return "日期未知";
  var parts = String(value).split("-");
  return parts.length === 3 ? parts[0] + "年" + Number(parts[1]) + "月" + Number(parts[2]) + "日" : value;
}

function labelOfCode(code) {
  for (var groupIndex = 0; groupIndex < ALLERGEN_GROUPS.length; groupIndex += 1) {
    for (var optionIndex = 0; optionIndex < ALLERGEN_GROUPS[groupIndex].options.length; optionIndex += 1) {
      if (ALLERGEN_GROUPS[groupIndex].options[optionIndex].code === code) return ALLERGEN_GROUPS[groupIndex].options[optionIndex].label;
    }
  }
  return code;
}

function codeOfLabel(label) {
  for (var groupIndex = 0; groupIndex < ALLERGEN_GROUPS.length; groupIndex += 1) {
    for (var optionIndex = 0; optionIndex < ALLERGEN_GROUPS[groupIndex].options.length; optionIndex += 1) {
      if (ALLERGEN_GROUPS[groupIndex].options[optionIndex].label === label) return ALLERGEN_GROUPS[groupIndex].options[optionIndex].code;
    }
  }
  return label;
}

function uuidPart() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function groupsView(selected) {
  return ALLERGEN_GROUPS.map(function (group) {
    return {
      name: group.name,
      options: group.options.map(function (option) {
        return Object.assign({}, option, { selected: selected.indexOf(option.label) >= 0 });
      })
    };
  });
}

function exposureView(item) {
  var factors = (item.factors || []).map(labelOfCode);
  return Object.assign({}, item, {
    factors: factors,
    factorsText: factors.join("、"),
    displayDate: displayDate(item.localDate)
  });
}

function medicationView(item) {
  return Object.assign({}, item, {
    dosageText: item.dosage || "剂量不详",
    actualUseText: item.actualUse || "实际用量不详",
    displayDate: displayDate(item.localDate)
  });
}

Page({
  data: {
    today: today(),
    loading: true,
    saving: false,
    error: "",
    consentGranted: false,
    consentAccepted: false,
    policyVersion: "",
    privacyStatement: "",
    profile: { displayName: "", birthDate: "", sex: "unspecified", allergyHistory: "" },
    profileRevision: 0,
    sexLabels: SEX_LABELS,
    sexIndex: 0,
    factorGroups: groupsView([]),
    exposureItems: [],
    exposureDate: today(),
    exposureFactors: [],
    exposureOther: "",
    hasOtherExposure: false,
    exposureEditingId: "",
    exposureEditingRevision: 0,
    medicationItems: [],
    medicationDate: today(),
    medicationName: "",
    medicationDosage: "",
    medicationDosageUnit: "",
    medicationDosageUnknown: false,
    medicationActualUse: "",
    medicationActualUseUnknown: false,
    medicationEditingId: "",
    medicationEditingRevision: 0
  },

  onLoad: function (options) {
    this._focusExposure = Boolean(options && options.focus === "exposure");
    this.loadConsent();
  },

  scrollToExposure: function () {
    if (!this._focusExposure || typeof wx.pageScrollTo !== "function") return;
    this._focusExposure = false;
    wx.pageScrollTo({ selector: "#exposure-record", duration: 300 });
  },

  loadConsent: function () {
    var self = this;
    self.setData({ loading: true, error: "" });
    Promise.all([
      api.command("account consent show", {}, { auth: true }),
      api.command("account privacy", {}, { auth: false })
    ]).then(function (results) {
      var item = (results[0].items || []).find(function (entry) { return entry.consentType === "health_data"; });
      var granted = Boolean(item && item.decision === "granted");
      self.setData({
        consentGranted: granted,
        policyVersion: results[1].policyVersion || "",
        privacyStatement: results[1].statement || "",
        loading: false
      }, function () { self.scrollToExposure(); });
      if (granted) self.loadData();
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
      requestId: "mini-profile-consent-" + uuidPart()
    }, { auth: true }).then(function () {
      self.setData({ consentGranted: true, consentAccepted: false, loading: false });
      self.loadData();
    }).catch(function (error) { self.setData({ loading: false, error: pageUtils.errorMessage(error) }); });
  },

  loadData: function () {
    var self = this;
    self.setData({ loading: true, error: "" });
    Promise.all([
      api.command("record profile show", {}, { auth: true }),
      api.command("record exposure list", {}, { auth: true }),
      api.command("record medication list", {}, { auth: true })
    ]).then(function (results) {
      var profile = results[0] || {};
      var sex = profile.sex || "unspecified";
      self.setData({
        profile: {
          displayName: profile.displayName || "",
          birthDate: profile.birthDate || "",
          sex: sex,
          allergyHistory: profile.allergyHistory || ""
        },
        profileRevision: Number(profile.revision) || 0,
        sexIndex: Math.max(0, SEX_VALUES.indexOf(sex)),
        exposureItems: (results[1].items || []).map(exposureView),
        medicationItems: (results[2].items || []).map(medicationView),
        loading: false
      });
    }).catch(function (error) {
      self.setData({ loading: false, error: pageUtils.errorMessage(error) });
    });
  },

  onProfileInput: function (event) {
    var field = event.currentTarget.dataset.field;
    this.setData({ ["profile." + field]: event.detail.value });
  },

  changeProfileDate: function (event) { this.setData({ "profile.birthDate": event.detail.value }); },

  changeSex: function (event) {
    var index = Number(event.detail.value) || 0;
    this.setData({ sexIndex: index, "profile.sex": SEX_VALUES[index] || "unspecified" });
  },

  saveProfile: function () {
    var self = this;
    if (self.data.saving) return;
    self.setData({ saving: true, error: "" });
    api.command("record profile update", {
      expectedRevision: self.data.profileRevision,
      displayName: self.data.profile.displayName.trim() || null,
      birthDate: self.data.profile.birthDate || null,
      sex: self.data.profile.sex,
      allergyHistory: self.data.profile.allergyHistory.trim() || null
    }, { auth: true }).then(function (profile) {
      self.setData({
        profile: {
          displayName: profile.displayName || "",
          birthDate: profile.birthDate || "",
          sex: profile.sex || "unspecified",
          allergyHistory: profile.allergyHistory || ""
        },
        profileRevision: Number(profile.revision) || 0,
        sexIndex: Math.max(0, SEX_VALUES.indexOf(profile.sex || "unspecified")),
        saving: false
      });
      wx.showToast({ title: "档案已保存", icon: "success" });
    }).catch(function (error) {
      self.setData({ saving: false, error: pageUtils.errorMessage(error) });
    });
  },

  changeExposureDate: function (event) { this.setData({ exposureDate: event.detail.value }); },

  toggleFactor: function (event) {
    var label = event.currentTarget.dataset.label;
    var factors = this.data.exposureFactors.slice();
    if (label === "未识别到明确因素") {
      factors = factors.indexOf(label) >= 0 ? [] : [label];
    } else {
      factors = factors.filter(function (item) { return item !== "未识别到明确因素"; });
      var index = factors.indexOf(label);
      if (index >= 0) factors.splice(index, 1); else factors.push(label);
    }
    this.setData({ exposureFactors: factors, hasOtherExposure: factors.indexOf("其它（请简要描述）") >= 0, factorGroups: groupsView(factors) });
  },

  onExposureOtherInput: function (event) { this.setData({ exposureOther: event.detail.value }); },

  editExposure: function (event) {
    var item = this.data.exposureItems.find(function (entry) { return entry.id === event.currentTarget.dataset.id; });
    if (!item) return;
    this.setData({ exposureDate: item.localDate, exposureFactors: item.factors, hasOtherExposure: item.factors.indexOf("其它（请简要描述）") >= 0, exposureOther: item.otherDescription || "", exposureEditingId: item.id, exposureEditingRevision: item.revision, factorGroups: groupsView(item.factors) });
  },

  resetExposure: function () {
    this.setData({ exposureDate: this.data.today, exposureFactors: [], hasOtherExposure: false, exposureOther: "", exposureEditingId: "", exposureEditingRevision: 0, factorGroups: groupsView([]) });
  },

  saveExposure: function () {
    var self = this;
    var factors = self.data.exposureFactors;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(self.data.exposureDate)) { self.setData({ error: "请选择过敏原记录日期" }); return; }
    if (!factors.length) { self.setData({ error: "请至少选择一项患者自述因素" }); return; }
    if (factors.indexOf("其它（请简要描述）") >= 0 && !self.data.exposureOther.trim()) { self.setData({ error: "请补充其它因素的简要描述" }); return; }
    if (factors.indexOf("其它（请简要描述）") < 0 && self.data.exposureOther.trim()) { self.setData({ error: "请先选择其它因素再填写描述" }); return; }
    if (factors.indexOf("未识别到明确因素") >= 0 && factors.length > 1) { self.setData({ error: "未识别到明确因素不能与其它选项同时选择" }); return; }
    var input = { factors: factors.map(codeOfLabel), otherDescription: factors.indexOf("其它（请简要描述）") >= 0 ? self.data.exposureOther.trim() : null };
    var command = self.data.exposureEditingId ? "record exposure update" : "record exposure add";
    if (self.data.exposureEditingId) {
      input.id = self.data.exposureEditingId;
      input.expectedRevision = self.data.exposureEditingRevision;
    } else {
      input.localDate = self.data.exposureDate;
      input.notes = "患者自述当天接触";
      input.idempotencyKey = "mini-exposure-" + self.data.exposureDate + "-" + uuidPart();
    }
    self.setData({ saving: true, error: "" });
    api.command(command, input, { auth: true }).then(function () {
      self.resetExposure();
      self.setData({ saving: false });
      self.loadData();
      wx.showToast({ title: "已保存", icon: "success" });
    }).catch(function (error) { self.setData({ saving: false, error: pageUtils.errorMessage(error) }); });
  },

  deleteExposure: function (event) {
    var self = this;
    var item = self.data.exposureItems.find(function (entry) { return entry.id === event.currentTarget.dataset.id; });
    if (!item) return;
    wx.showModal({ title: "删除记录", content: "删除后不能恢复，确定删除这条过敏原记录吗？", confirmText: "删除", confirmColor: "#b34d43", success: function (result) {
      if (!result.confirm) return;
      self.setData({ saving: true, error: "" });
      api.command("record exposure delete", { id: item.id, expectedRevision: item.revision, yes: true }, { auth: true }).then(function () {
        self.setData({ saving: false });
        self.loadData();
      }).catch(function (error) { self.setData({ saving: false, error: pageUtils.errorMessage(error) }); });
    } });
  },

  changeMedicationDate: function (event) { this.setData({ medicationDate: event.detail.value }); },
  onMedicationInput: function (event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); },
  toggleMedicationUnknown: function (event) {
    var field = event.currentTarget.dataset.field;
    this.setData({ [field]: !this.data[field] });
  },

  editMedication: function (event) {
    var item = this.data.medicationItems.find(function (entry) { return entry.id === event.currentTarget.dataset.id; });
    if (!item) return;
    var dosageParts = String(item.dosage || "").trim().split(/\s+/u);
    this.setData({ medicationDate: item.localDate, medicationName: item.medicationName || "", medicationDosage: item.dosage ? dosageParts.shift() : "", medicationDosageUnit: item.dosage ? dosageParts.join(" ") : "", medicationDosageUnknown: !item.dosage, medicationActualUse: item.actualUse || "", medicationActualUseUnknown: !item.actualUse, medicationEditingId: item.id, medicationEditingRevision: item.revision });
  },

  resetMedication: function () {
    this.setData({ medicationDate: this.data.today, medicationName: "", medicationDosage: "", medicationDosageUnit: "", medicationDosageUnknown: false, medicationActualUse: "", medicationActualUseUnknown: false, medicationEditingId: "", medicationEditingRevision: 0 });
  },

  saveMedication: function () {
    var self = this;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(self.data.medicationDate)) { self.setData({ error: "请选择用药日期" }); return; }
    if (!self.data.medicationName.trim()) { self.setData({ error: "请填写药物名称" }); return; }
    if (!self.data.medicationDosageUnknown && (!self.data.medicationDosage.trim() || !self.data.medicationDosageUnit.trim())) { self.setData({ error: "请填写剂量和单位，或勾选剂量不详" }); return; }
    if (!self.data.medicationActualUseUnknown && !self.data.medicationActualUse.trim()) { self.setData({ error: "请填写实际用量情况，或勾选实际用量不详" }); return; }
    var input = {
      medicationName: self.data.medicationName.trim(),
      dosage: self.data.medicationDosageUnknown ? null : (self.data.medicationDosage.trim() + " " + self.data.medicationDosageUnit.trim()).trim(),
      actualUse: self.data.medicationActualUseUnknown ? null : self.data.medicationActualUse.trim()
    };
    var command = self.data.medicationEditingId ? "record medication update" : "record medication add";
    if (self.data.medicationEditingId) {
      input.id = self.data.medicationEditingId;
      input.expectedRevision = self.data.medicationEditingRevision;
    } else {
      input.localDate = self.data.medicationDate;
      input.notes = null;
      input.idempotencyKey = "mini-medication-" + self.data.medicationDate + "-" + uuidPart();
    }
    self.setData({ saving: true, error: "" });
    api.command(command, input, { auth: true }).then(function () {
      self.resetMedication();
      self.setData({ saving: false });
      self.loadData();
      wx.showToast({ title: "已保存", icon: "success" });
    }).catch(function (error) { self.setData({ saving: false, error: pageUtils.errorMessage(error) }); });
  },

  deleteMedication: function (event) {
    var self = this;
    var item = self.data.medicationItems.find(function (entry) { return entry.id === event.currentTarget.dataset.id; });
    if (!item) return;
    wx.showModal({ title: "删除记录", content: "删除后不能恢复，确定删除这条用药记录吗？", confirmText: "删除", confirmColor: "#b34d43", success: function (result) {
      if (!result.confirm) return;
      self.setData({ saving: true, error: "" });
      api.command("record medication delete", { id: item.id, expectedRevision: item.revision, yes: true }, { auth: true }).then(function () {
        self.setData({ saving: false });
        self.loadData();
      }).catch(function (error) { self.setData({ saving: false, error: pageUtils.errorMessage(error) }); });
    } });
  }
});
