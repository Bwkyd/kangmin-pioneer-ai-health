var STORAGE_KEY = "kangmin.preview.health-data.v1";
var POLICY_VERSION = "preview-local-v1";
var PRIVACY_STATEMENT = "客户体验阶段，健康数据只保存在当前设备的小程序本地缓存，不上传服务端；清理微信缓存或删除小程序后可能丢失。";

function emptyState() {
  return {
    consentGranted: false,
    profile: { revision: 0, displayName: null, birthDate: null, sex: "unspecified", allergyHistory: null },
    symptoms: [],
    exposures: [],
    medications: []
  };
}

function normalizedState(value) {
  var fallback = emptyState();
  if (!value || typeof value !== "object") return fallback;
  return {
    consentGranted: value.consentGranted === true,
    profile: value.profile && typeof value.profile === "object" ? Object.assign({}, fallback.profile, value.profile) : fallback.profile,
    symptoms: Array.isArray(value.symptoms) ? value.symptoms : [],
    exposures: Array.isArray(value.exposures) ? value.exposures : [],
    medications: Array.isArray(value.medications) ? value.medications : []
  };
}

function dateValue(date) {
  var value = date || new Date();
  return value.getFullYear() + "-" + String(value.getMonth() + 1).padStart(2, "0") + "-" + String(value.getDate()).padStart(2, "0");
}

function previousDate(value) {
  var parts = String(value).split("-").map(Number);
  return dateValue(new Date(parts[0], parts[1] - 1, parts[2] - 1));
}

function tnssTotal(item) {
  return ["sneezing", "runnyNose", "nasalCongestion", "nasalItching"].reduce(function (sum, key) {
    return sum + (Number(item[key]) || 0);
  }, 0);
}

function localError(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

function assertRecordDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) || value > dateValue()) {
    throw localError("validation_failed", "记录日期不能晚于今天");
  }
}

function assertSymptomScores(input) {
  ["sneezing", "runnyNose", "nasalCongestion", "nasalItching"].forEach(function (key) {
    if (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > 3) {
      throw localError("validation_failed", "症状评分应为 0 到 3 的整数");
    }
  });
}

function assertSameReplay(existing, input, fields) {
  var changed = fields.some(function (field) {
    return JSON.stringify(existing[field] == null ? null : existing[field]) !== JSON.stringify(input[field] == null ? null : input[field]);
  });
  if (changed) throw localError("conflict", "重复提交标识对应的内容不一致，请重新操作");
}

function createLocalExperience(wxApi, enabled) {
  function load() {
    if (!enabled) return emptyState();
    try {
      var stored = wxApi.getStorageSync(STORAGE_KEY);
      return normalizedState(typeof stored === "string" && stored ? JSON.parse(stored) : stored);
    } catch (error) {
      return emptyState();
    }
  }

  function save(state) {
    wxApi.setStorageSync(STORAGE_KEY, state);
    return state;
  }

  function id(prefix) {
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function findRequired(items, itemId) {
    var item = items.find(function (entry) { return entry.id === itemId; });
    if (!item) throw localError("not_found", "记录不存在或已删除");
    return item;
  }

  function assertRevision(item, expectedRevision) {
    if (Number(expectedRevision) !== Number(item.revision)) {
      throw localError("conflict", "记录已发生变化，请重新打开后再试");
    }
  }

  function replayOf(items, idempotencyKey) {
    if (!idempotencyKey) return null;
    return items.find(function (entry) { return entry.idempotencyKey === idempotencyKey; }) || null;
  }

  function overview(state) {
    var symptoms = state.symptoms.slice().sort(function (left, right) { return right.localDate.localeCompare(left.localDate); });
    var latest = symptoms[0] || null;
    var currentMonth = dateValue().slice(0, 7);
    var recorded = {};
    symptoms.forEach(function (item) { recorded[item.localDate] = true; });
    var consecutiveDays = 0;
    var cursor = latest && latest.localDate;
    while (cursor && recorded[cursor]) {
      consecutiveDays += 1;
      cursor = previousDate(cursor);
    }
    return {
      consecutiveDays: consecutiveDays,
      monthRecordCount: symptoms.filter(function (item) { return item.localDate.slice(0, 7) === currentMonth; }).length,
      lastTnss: latest ? tnssTotal(latest) : null,
      recentSymptomDate: latest ? latest.localDate : null
    };
  }

  function execute(name, inputValue) {
    var input = inputValue || {};
    var state = load();
    var item;

    if (name === "account privacy") return { policyVersion: POLICY_VERSION, statement: PRIVACY_STATEMENT };
    if (name === "account consent show") {
      return { items: [{ consentType: "health_data", decision: state.consentGranted ? "granted" : "denied", policyVersion: POLICY_VERSION }] };
    }
    if (name === "account consent update") {
      state.consentGranted = input.decision === "granted";
      save(state);
      return { consentType: "health_data", decision: state.consentGranted ? "granted" : "denied", policyVersion: POLICY_VERSION };
    }
    if (name === "record overview") return overview(state);
    if (name === "record symptom list") return { items: state.symptoms.slice().sort(function (left, right) { return right.localDate.localeCompare(left.localDate); }) };
    if (name === "record symptom add") {
      assertRecordDate(input.localDate);
      assertSymptomScores(input);
      item = replayOf(state.symptoms, input.idempotencyKey);
      if (item) {
        assertSameReplay(item, input, ["localDate", "sneezing", "runnyNose", "nasalCongestion", "nasalItching", "notes"]);
        return item;
      }
      if (state.symptoms.some(function (entry) { return entry.localDate === input.localDate; })) {
        throw localError("conflict", "当天已有症状记录，请打开原记录修改");
      }
      item = Object.assign({ id: id("symptom"), revision: 1 }, input);
      state.symptoms.push(item);
      save(state);
      return item;
    }
    if (name === "record symptom update") {
      item = findRequired(state.symptoms, input.id);
      assertRevision(item, input.expectedRevision);
      Object.assign(item, input, { revision: item.revision + 1 });
      delete item.expectedRevision;
      save(state);
      return item;
    }
    if (name === "record calendar") {
      return {
        month: input.month,
        days: state.symptoms.filter(function (entry) { return entry.localDate.slice(0, 7) === input.month; }).map(function (entry) {
          return { localDate: entry.localDate, symptomId: entry.id, tnssTotal: tnssTotal(entry) };
        })
      };
    }
    if (name === "record trend") {
      return {
        items: state.symptoms.filter(function (entry) { return entry.localDate >= input.from && entry.localDate <= input.to; }).sort(function (left, right) { return left.localDate.localeCompare(right.localDate); }).map(function (entry) {
          return { localDate: entry.localDate, symptomId: entry.id, tnssTotal: tnssTotal(entry) };
        })
      };
    }
    if (name === "record profile show") return Object.assign({}, state.profile);
    if (name === "record profile update") {
      assertRevision(state.profile, input.expectedRevision);
      state.profile = {
        revision: state.profile.revision + 1,
        displayName: input.displayName || null,
        birthDate: input.birthDate || null,
        sex: input.sex || "unspecified",
        allergyHistory: input.allergyHistory || null
      };
      save(state);
      return Object.assign({}, state.profile);
    }
    if (name === "record exposure list") return { items: state.exposures.slice().sort(function (left, right) { return right.localDate.localeCompare(left.localDate); }) };
    if (name === "record exposure add") {
      assertRecordDate(input.localDate);
      item = replayOf(state.exposures, input.idempotencyKey);
      if (item) {
        assertSameReplay(item, input, ["localDate", "factors", "otherDescription", "notes"]);
        return item;
      }
      if (state.exposures.some(function (entry) { return entry.localDate === input.localDate; })) {
        throw localError("conflict", "当天已有过敏原记录，请打开原记录修改");
      }
      item = Object.assign({ id: id("exposure"), revision: 1 }, input);
      state.exposures.push(item);
      save(state);
      return item;
    }
    if (name === "record exposure update") {
      item = findRequired(state.exposures, input.id);
      assertRevision(item, input.expectedRevision);
      Object.assign(item, input, { revision: item.revision + 1 });
      delete item.expectedRevision;
      save(state);
      return item;
    }
    if (name === "record exposure delete") {
      item = findRequired(state.exposures, input.id);
      assertRevision(item, input.expectedRevision);
      state.exposures = state.exposures.filter(function (entry) { return entry.id !== input.id; });
      save(state);
      return { id: input.id, deleted: true };
    }
    if (name === "record medication list") return { items: state.medications.slice().sort(function (left, right) { return right.localDate.localeCompare(left.localDate); }) };
    if (name === "record medication add") {
      assertRecordDate(input.localDate);
      item = replayOf(state.medications, input.idempotencyKey);
      if (item) {
        assertSameReplay(item, input, ["localDate", "name", "dosage", "actualUse", "notes"]);
        return item;
      }
      item = Object.assign({ id: id("medication"), revision: 1 }, input);
      state.medications.push(item);
      save(state);
      return item;
    }
    if (name === "record medication update") {
      item = findRequired(state.medications, input.id);
      assertRevision(item, input.expectedRevision);
      Object.assign(item, input, { revision: item.revision + 1 });
      delete item.expectedRevision;
      save(state);
      return item;
    }
    if (name === "record medication delete") {
      item = findRequired(state.medications, input.id);
      assertRevision(item, input.expectedRevision);
      state.medications = state.medications.filter(function (entry) { return entry.id !== input.id; });
      save(state);
      return { id: input.id, deleted: true };
    }
    if (name === "browse message unread-count") return { count: 0 };
    if (name === "browse message list") return { items: [] };

    throw localError("unsupported_local_command", "当前体验模式不支持此操作");
  }

  var supported = [
    "account privacy", "account consent show", "account consent update",
    "record overview", "record symptom list", "record symptom add", "record symptom update", "record calendar", "record trend",
    "record profile show", "record profile update",
    "record exposure list", "record exposure add", "record exposure update", "record exposure delete",
    "record medication list", "record medication add", "record medication update", "record medication delete",
    "browse message unread-count", "browse message list"
  ];

  return {
    enabled: enabled === true,
    execute: execute,
    supports: function (name) { return supported.indexOf(name) >= 0; },
    storageKey: STORAGE_KEY
  };
}

module.exports = { createLocalExperience: createLocalExperience, storageKey: STORAGE_KEY };
