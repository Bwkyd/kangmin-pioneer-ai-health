var api = require("../../utils/request");
var pageUtils = require("../../utils/page");
var questionnaire = require("../../utils/questionnaire");

var CONVERSATION_KEY = "kangmin.agent.conversationId";
var WELCOME_MESSAGE = {
  id: "welcome",
  role: "assistant",
  kind: "text",
  text: "敏友您好，本工具依据福建中医药大学抗敏先锋团队体质调理方案开发，为您推荐个性化外治建议"
};

function displayDate(value) {
  var date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return (date.getMonth() + 1) + "月" + date.getDate() + "日 " +
    String(date.getHours()).padStart(2, "0") + ":" +
    String(date.getMinutes()).padStart(2, "0");
}

function currentTimeLabel() {
  var date = new Date();
  return "今天 " + String(date.getHours()).padStart(2, "0") + ":" +
    String(date.getMinutes()).padStart(2, "0");
}

function stateLabel(state) {
  if (state === "active") return "进行中";
  if (state === "completed") return "已完成";
  if (state === "abandoned") return "已失效";
  return "未知状态";
}

function resultKind(content) {
  return content.indexOf("【急性发作期】") >= 0 || content.indexOf("【缓解期】") >= 0
    ? "result"
    : "text";
}

var PLAN_VIDEO_RULES = [
  { method: ["肺俞", "点揉"], title: ["肺俞", "点揉", "不灸"] },
  { method: ["肺俞"], title: ["肺俞"], rejectTitle: ["点揉"] },
  { method: ["鼻三线"], title: ["鼻三线"] }, { method: ["迎香"], title: ["迎香"] },
  { method: ["耳穴过敏区"], title: ["耳穴过敏区"] }, { method: ["身柱"], title: ["身柱"] },
  { method: ["风门"], title: ["风门"] }, { method: ["大椎"], title: ["大椎"] },
  { method: ["足三里"], title: ["足三里"] }, { method: ["揉天枢", "摩腹"], title: ["揉天枢", "摩腹"] },
  { method: ["天枢"], title: ["天枢"] }, { method: ["清肺经", "清大肠"], title: ["清肺经", "清大肠"] },
  { method: ["头面四大手法"], title: ["头面四大手法"] }, { method: ["鼻炎手法"], title: ["鼻炎手法"] },
  { method: ["过敏手法"], title: ["过敏手法"] }, { method: ["呼吸手法"], title: ["呼吸手法"] },
  { method: ["消化手法"], title: ["消化手法"] }, { method: ["清热手法"], title: ["清热手法"] }
];

function normalized(value) {
  return String(value || "").replace(/[\s·—–、，,：:()（）+]/g, "").toLocaleLowerCase("zh-CN");
}

function matchedPlanVideo(method, videos) {
  var normalizedMethod = normalized(method);
  var audience = /(?:小儿|儿童)/.test(method) ? "儿童" : "成人";
  var rule = PLAN_VIDEO_RULES.find(function (candidate) {
    return candidate.method.every(function (part) { return normalizedMethod.indexOf(normalized(part)) >= 0; });
  });
  if (!rule) return null;
  return (videos || []).find(function (video) {
    var title = normalized(video.title);
    return video.kind === "video" && String(video.category || "").indexOf(audience) >= 0 &&
      rule.title.every(function (part) { return title.indexOf(normalized(part)) >= 0; }) &&
      !(rule.rejectTitle || []).some(function (part) { return title.indexOf(normalized(part)) >= 0; });
  }) || null;
}

function resultBlocks(content, videos) {
  var lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  var blocks = [];
  var currentMethod = "";
  for (var index = 0; index < lines.length; index += 1) {
    var line = lines[index] || "";
    var trimmed = line.trim();
    var numbered = trimmed.match(/^\d+[.．、]\s*(.+)$/);
    if (numbered && numbered[1]) currentMethod = numbered[1].trim();
    if (trimmed === "方法：") currentMethod = (lines[index + 1] || "").trim();
    if (trimmed === "【操作视频】") {
      var video = matchedPlanVideo(currentMethod, videos);
      if (video) {
        blocks.push({ type: "video", id: video.id, method: currentMethod });
        var nextLine = (lines[index + 1] || "").trim();
        if (nextLine === "视频暂未上传（医学审核后补充）。" || nextLine === "操作视频已提供（见视频资源）。") index += 1;
        continue;
      }
    }
    blocks.push({ type: trimmed ? "text" : "space", text: line });
  }
  return blocks;
}

function resultPhase(content) {
  return String(content || "").indexOf("【急性发作期】") >= 0 ? "急性发作期" : "缓解期";
}

function enrichResultMessage(message, videos) {
  if (message.kind !== "result") return message;
  return Object.assign({}, message, {
    resultPhase: resultPhase(message.text),
    resultBlocks: resultBlocks(message.text, videos)
  });
}

function visibleUserText(content) {
  var value = String(content || "");
  var questionAnswer = questionnaire.visibleAnswer(value);
  if (questionAnswer) return questionAnswer;
  var option = /^q(\d+)=([A-D])$/i.exec(value.trim());
  if (option) return "第 " + option[1] + " 题：选择 " + option[2].toUpperCase();
  var field = /^([a-z][a-z0-9_]*)(?:=|:)(yes|no|unknown)$/i.exec(value.trim());
  if (field) {
    var labels = { yes: "是", no: "否", unknown: "不清楚" };
    var fieldLabels = {
      urgent_help: "急救",
      urgentHelp: "急救",
      high_fever: "高热",
      epistaxis_foul_discharge: "鼻出血",
      severe_neuro_symptoms: "剧烈头痛",
      skin_lesion: "皮肤破损",
      pregnancy: "怀孕",
      child_under_12: "未满12周岁",
      paroxysmal_sneezing: "阵发性喷嚏",
      watery_rhinorrhea: "清水样涕",
      nasal_itching: "鼻痒",
      nasal_congestion: "鼻塞",
      cold_like_symptoms: "感冒样表现",
      sinusitis_like_symptoms: "鼻窦炎样表现",
      sleep_affected: "影响睡眠",
      daily_activity_affected: "影响日常活动",
      activity_affected: "影响日常活动",
      work_study_affected: "影响工作学习",
      work_affected: "影响工作学习",
      symptoms_intolerable: "难以忍受",
      unbearable: "难以忍受",
      thirst: "口渴",
      fatigue: "倦怠乏力",
      limbs_not_warm: "四肢不温",
      fear_wind: "怕风",
      cold_intolerance: "形寒肢冷",
      diagnosed_confirmed: "确诊过敏性鼻炎",
      heat_imbalance: "怕热",
      step1_q10: "第1步口干",
      step2_q8: "第2步疲倦",
      step3_q6: "第3步怕风怕冷",
      step4_q9: "第4步手脚冰凉",
      step5_q8_confirm: "第5步疲倦二次确认",
      step6_q10_confirm: "第6步口干二次确认"
    };
    if (fieldLabels[field[1]] && labels[field[2].toLowerCase()]) {
      return fieldLabels[field[1]] + "：" + labels[field[2].toLowerCase()];
    }
  }
  return value;
}

function historyView(item) {
  return Object.assign({}, item, {
    stateLabel: stateLabel(item.state),
    displayDate: displayDate(item.updatedAt || item.createdAt)
  });
}

function messageView(message, videos) {
  var role = message.role === "user"
    ? "user"
    : message.role === "system_notice" ? "notice" : "assistant";
  var text = role === "user" ? visibleUserText(message.content) : String(message.content || "");
  return enrichResultMessage({
    id: message.id,
    role: role,
    kind: role === "assistant" ? resultKind(text) : role,
    text: text,
    displayDate: displayDate(message.createdAt)
  }, videos);
}

function restoreMessages(detail, videos) {
  return [WELCOME_MESSAGE].concat((detail.messages || []).map(function (message) { return messageView(message, videos); }));
}

function turnMessages(turn, videos) {
  var messages = [];
  if (turn.message && turn.message.content) {
    messages.push(enrichResultMessage({
      id: "assistant-" + Date.now(),
      role: "assistant",
      kind: resultKind(turn.message.content),
      text: turn.message.content,
      displayDate: displayDate(new Date().toISOString())
    }, videos));
  }
  (turn.notices || []).forEach(function (notice, index) {
    messages.push({
      id: "notice-" + Date.now() + "-" + index,
      role: "notice",
      kind: "notice",
      text: notice.content,
      displayDate: displayDate(new Date().toISOString())
    });
  });
  return messages;
}

function nextQuestionsOf(verdict) {
  return verdict && Array.isArray(verdict.nextQuestions)
    ? verdict.nextQuestions.map(questionnaire.view)
    : [];
}

function isCapabilityUnavailable(error) {
  return !!error && error.code === "capability_unavailable";
}

function agentAvailable() {
  return api.wechatLoginEnabled !== false || api.anonymousAgentEnabled === true;
}

/** 匿名体验没有患者级历史会话权限，不能把一次性会话 ID 带到下次页面恢复。 */
function anonymousExperience() {
  return api.wechatLoginEnabled === false && api.anonymousAgentEnabled === true;
}

Page({
  data: {
    hydrated: false,
    loading: true,
    sending: false,
    input: "",
    error: "",
    retryMessage: "",
    messages: [WELCOME_MESSAGE],
    conversationId: "",
    conversationState: "",
    pendingQuestions: [],
    followUpEnabled: false,
    canSend: agentAvailable(),
    startAvailable: agentAvailable(),
    capabilityUnavailable: !agentAvailable(),
    endReason: "",
    nextStartMode: "inherit_assessment",
    historyOpen: false,
    historyLoading: false,
    historyError: "",
    historyUnavailable: false,
    history: [],
    statusBarHeight: 20,
    navigationBarHeight: 44,
    timeLabel: currentTimeLabel()
  },

  onShow: function () {
    pageUtils.selectTab(this, 1);
  },

  onLoad: function () {
    this.initNavigation();
    this.hydrate();
  },

  onUnload: function () {
    this.setTabBarHidden(false);
    if (this._streamTask && typeof this._streamTask.abort === "function") {
      this._streamTask.abort();
    }
    this._streamTask = null;
    if (this._streamFlushTimer) clearTimeout(this._streamFlushTimer);
  },

  onHide: function () {
    this.setTabBarHidden(false);
  },

  nextRequest: function () {
    this._requestVersion = (this._requestVersion || 0) + 1;
    return this._requestVersion;
  },

  isCurrentRequest: function (version) {
    return this._requestVersion === version;
  },

  setTabBarHidden: function (hidden) {
    if (typeof this.getTabBar !== "function") return;
    var tabBar = this.getTabBar();
    if (tabBar && typeof tabBar.setData === "function") tabBar.setData({ hidden: !!hidden });
  },

  initNavigation: function () {
    var windowInfo = {};
    try {
      windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
    } catch (error) {
      windowInfo = {};
    }
    var statusBarHeight = Number(windowInfo.statusBarHeight) || 20;
    var navigationBarHeight = 44;
    try {
      if (typeof wx.getMenuButtonBoundingClientRect === "function") {
        var capsule = wx.getMenuButtonBoundingClientRect();
        if (capsule && capsule.height && capsule.top >= statusBarHeight) {
          navigationBarHeight = capsule.height + (capsule.top - statusBarHeight) * 2;
        }
      }
    } catch (error) {
      navigationBarHeight = 44;
    }
    this.setData({ statusBarHeight: statusBarHeight, navigationBarHeight: navigationBarHeight });
  },

  loadPlanVideos: function () {
    var self = this;
    if (self._planVideosLoading || self._planVideosLoaded) return;
    self._planVideosLoading = true;
    self._planVideos = [];
    api.command("browse video list", { limit: 100, offset: 0 }, { auth: false })
      .then(function (result) {
        self._planVideos = result.items || [];
        self._planVideosLoaded = true;
        self._planVideosLoading = false;
        self.setData({ messages: self.data.messages.map(function (message) { return enrichResultMessage(message, self._planVideos); }) });
      })
      .catch(function () {
        self._planVideosLoading = false;
        self._planVideos = [];
      });
  },

  clearStoredConversation: function () {
    try {
      wx.removeStorageSync(CONVERSATION_KEY);
    } catch (error) {
      // 本地存储不可用时不阻断当前页面；服务端仍是会话真值。
    }
  },

  storeConversation: function (id) {
    if (anonymousExperience()) return;
    try {
      wx.setStorageSync(CONVERSATION_KEY, id);
    } catch (error) {
      // 本地存储不可用时仅保留本次页面生命周期内的会话。
    }
  },

  markCapabilityUnavailable: function () {
    this.clearStoredConversation();
    this.setData({
      hydrated: true,
      loading: false,
      sending: false,
      input: "",
      error: "",
      retryMessage: "",
      messages: [WELCOME_MESSAGE],
      conversationId: "",
      conversationState: "",
      pendingQuestions: [],
      followUpEnabled: false,
      canSend: false,
      startAvailable: false,
      capabilityUnavailable: true,
      endReason: "",
      historyOpen: false,
      historyLoading: false,
      historyError: "",
      historyUnavailable: true,
      history: []
    });
    this.setTabBarHidden(false);
  },

  hydrate: function () {
    var self = this;
    if (anonymousExperience()) {
      self.clearStoredConversation();
      self.setData({
        hydrated: true,
        loading: false,
        error: "",
        capabilityUnavailable: false,
        canSend: true,
        startAvailable: true
      });
      return;
    }
    var id = "";
    try {
      id = wx.getStorageSync(CONVERSATION_KEY) || "";
    } catch (error) {
      id = "";
    }
    if (!id) {
      self.setData({
        hydrated: true,
        loading: false,
        error: "",
        capabilityUnavailable: !agentAvailable(),
        canSend: agentAvailable(),
        startAvailable: agentAvailable()
      });
      return;
    }

    var requestVersion = self.nextRequest();
    self.setData({ loading: true, hydrated: false, error: "" });
    api.command("agent conversations show", { id: id }, { auth: true })
      .then(function (detail) {
        if (!self.isCurrentRequest(requestVersion)) return;
        self.applyConversation(detail);
      })
      .catch(function (error) {
        if (!self.isCurrentRequest(requestVersion)) return;
        if (isCapabilityUnavailable(error)) {
          self.markCapabilityUnavailable();
          return;
        }
        if (error && error.code === "resource_not_found") {
          self.clearStoredConversation();
          self.setData({
            hydrated: true,
            loading: false,
            conversationId: "",
            conversationState: "",
            messages: [WELCOME_MESSAGE],
            startAvailable: true,
            canSend: true,
            error: "上次对话已过期，请重新开始。"
          });
          return;
        }
        self.setData({ hydrated: true, loading: false, error: pageUtils.errorMessage(error) });
      });
  },

  applyConversation: function (detail) {
    var session = detail.session || {};
    var state = session.state || "";
    var lastDecision = detail.lastDecision || null;
    var followUp = state === "completed" && lastDecision && lastDecision.outcome === "classified";
    var pending = state === "active" ? nextQuestionsOf(lastDecision) : [];
    if (session.id) this.storeConversation(session.id);
    this.setData({
      hydrated: true,
      loading: false,
      error: "",
      retryMessage: "",
      messages: restoreMessages(detail, this._planVideos),
      conversationId: session.id || "",
      conversationState: state,
      capabilityUnavailable: false,
      pendingQuestions: pending,
      followUpEnabled: !!followUp,
      canSend: state === "active" || !!followUp,
      startAvailable: false,
      endReason: state === "abandoned" ? "评估规则已更新，请新建对话后重新评估。" : ""
    });
    if (state === "completed") this.loadPlanVideos();
  },

  toggleHistory: function () {
    if (this.data.historyOpen) {
      this.setData({ historyOpen: false });
      this.setTabBarHidden(false);
      return;
    }
    this.setData({ historyOpen: true });
    this.setTabBarHidden(true);
    this.loadHistory();
  },

  closeHistory: function () {
    this.setData({ historyOpen: false });
    this.setTabBarHidden(false);
  },

  loadHistory: function () {
    var self = this;
    var version = (self._historyRequestVersion || 0) + 1;
    self._historyRequestVersion = version;
    self.setData({ historyLoading: true, historyError: "", historyUnavailable: false });
    api.command("agent conversations list", {}, { auth: true })
      .then(function (result) {
        if (self._historyRequestVersion !== version) return;
        self.setData({
          history: (result.items || []).map(historyView),
          historyLoading: false,
          historyUnavailable: false
        });
      })
      .catch(function (error) {
        if (self._historyRequestVersion !== version) return;
        if (error && error.code === "capability_unavailable") {
          self.setData({ history: [], historyLoading: false, historyError: "", historyUnavailable: true });
          return;
        }
        self.setData({ historyLoading: false, historyError: pageUtils.errorMessage(error) });
      });
  },

  selectConversation: function (event) {
    var self = this;
    if (self.data.sending) return;
    var id = event.currentTarget.dataset.id;
    if (!id) return;
    var requestVersion = self.nextRequest();
    self.setData({ sending: true, historyError: "", error: "" });
    api.command("agent conversations show", { id: id }, { auth: true })
      .then(function (detail) {
        if (!self.isCurrentRequest(requestVersion)) return;
        self.applyConversation(detail);
        self.setData({ historyOpen: false, sending: false });
        self.setTabBarHidden(false);
      })
      .catch(function (error) {
        if (!self.isCurrentRequest(requestVersion)) return;
        if (isCapabilityUnavailable(error)) {
          self.markCapabilityUnavailable();
          return;
        }
        self.setData({ sending: false, historyError: pageUtils.errorMessage(error) });
      });
  },

  startNewConversation: function () {
    if (this._streamTask && typeof this._streamTask.abort === "function") this._streamTask.abort();
    this._streamTask = null;
    this.nextRequest();
    this.setData({
      hydrated: true,
      loading: false,
      sending: false,
      input: "",
      error: "",
      retryMessage: "",
      messages: [WELCOME_MESSAGE],
      conversationId: "",
      conversationState: "",
      pendingQuestions: [],
      followUpEnabled: false,
      canSend: agentAvailable(),
      startAvailable: agentAvailable(),
      capabilityUnavailable: !agentAvailable(),
      endReason: "",
      nextStartMode: "inherit_assessment",
      historyOpen: false
    });
    this.clearStoredConversation();
    this.setTabBarHidden(false);
  },

  startReassessment: function () {
    this.startNewConversation();
    this.setData({ nextStartMode: "reassess" });
  },

  beginConsultation: function () {
    if (!this.data.startAvailable || this.data.sending || this.data.capabilityUnavailable) return;
    this.sendMessage(
      this.data.nextStartMode === "reassess"
        ? "我想重新评估我的鼻炎情况"
        : "请结合我最近的评估，告诉我当前方案重点",
      true
    );
  },

  onInput: function (event) {
    this.setData({ input: event.detail.value, retryMessage: "" });
  },

  sendFromInput: function (event) {
    this.sendMessage(event.detail.value, true);
  },

  sendCurrent: function () {
    this.sendMessage(this.data.input, true);
  },

  openPlanVideo: function (event) {
    var id = event.currentTarget.dataset.id;
    if (!id || this.data.sending) return;
    wx.navigateTo({ url: "/pages/content-detail/index?kind=video&id=" + encodeURIComponent(id) });
  },

  answerPending: function (event) {
    if (this.data.sending) return;
    this.sendMessage(event.currentTarget.dataset.value, true);
  },

  retry: function () {
    if (!this.data.retryMessage || this.data.sending) return;
    this.sendMessage(this.data.retryMessage, false);
  },

  sendMessage: function (value, echoUser) {
    var self = this;
    var message = String(value || "").trim();
    if (!message || self.data.sending || !self.data.hydrated || !self.data.canSend || self.data.capabilityUnavailable) return;

    var conversationId = self.data.conversationId;
    var input = { message: message };
    if (conversationId) {
      input.conversationId = conversationId;
    } else {
      input.startMode = self.data.nextStartMode;
    }

    var requestVersion = self.nextRequest();
    var outgoing = echoUser === false ? self.data.messages : self.data.messages.concat([{
      id: "user-" + Date.now(),
      role: "user",
      kind: "user",
      text: visibleUserText(message),
      displayDate: displayDate(new Date().toISOString())
    }]);
    self.setData({
      messages: outgoing.concat([{
        id: "thinking-" + requestVersion,
        role: "assistant",
        kind: "thinking",
        text: "正在根据服务端规则处理…"
      }]),
      input: "",
      sending: true,
      startAvailable: false,
      error: "",
      retryMessage: ""
    });

    var streamText = "";
    var streamMessageId = "thinking-" + requestVersion;
    function flushStreamText() {
      self._streamFlushTimer = null;
      if (!self.isCurrentRequest(requestVersion)) return;
      self.setData({
        messages: self.data.messages.map(function (item) {
          return item.id === streamMessageId ? Object.assign({}, item, { kind: "streaming", text: streamText || "正在等待服务端回答…" }) : item;
        })
      });
    }
    function appendStreamText(content) {
      streamText += content;
      if (!self._streamFlushTimer) self._streamFlushTimer = setTimeout(flushStreamText, 80);
    }
    var streamTask = api.streamAgent(input, {
      onStart: function () {
        if (!self.isCurrentRequest(requestVersion)) return;
        self.setData({ messages: self.data.messages.map(function (item) {
          return item.id === streamMessageId ? Object.assign({}, item, { kind: "streaming", text: "正在生成已校验回答…" }) : item;
        }) });
      },
      onDelta: function (content) { appendStreamText(content); }
    });
    self._streamTask = streamTask;
    streamTask
      .then(function (turn) {
        if (!self.isCurrentRequest(requestVersion)) return;
        if (self._streamFlushTimer) clearTimeout(self._streamFlushTimer);
        self._streamFlushTimer = null;
        var followUp = turn.verdict && turn.verdict.outcome === "classified";
        var state = turn.state || "active";
        var messages = self.data.messages
          .filter(function (item) { return item.id !== streamMessageId && item.kind !== "thinking"; })
          .concat(turnMessages(turn, self._planVideos));
        if (turn.conversationId) self.storeConversation(turn.conversationId);
        self._streamTask = null;
        self.setData({
          messages: messages,
          conversationId: turn.conversationId || conversationId || "",
          conversationState: state,
          capabilityUnavailable: false,
          pendingQuestions: turn.closed ? [] : nextQuestionsOf(turn.verdict),
          followUpEnabled: !!followUp,
          canSend: state === "active" || !!followUp,
          endReason: "",
          sending: false,
          error: "",
          retryMessage: ""
        });
        if (turn.message && resultKind(turn.message.content) === "result") self.loadPlanVideos();
      })
      .catch(function (error) {
        if (!self.isCurrentRequest(requestVersion)) return;
        if (self._streamFlushTimer) clearTimeout(self._streamFlushTimer);
        self._streamFlushTimer = null;
        self._streamTask = null;
        var messages = self.data.messages.filter(function (item) { return item.id !== streamMessageId && item.kind !== "thinking"; });
        if (isCapabilityUnavailable(error)) {
          self.markCapabilityUnavailable();
          return;
        }
        if (error && error.code === "protocol_incompatible") {
          self.setData({
            messages: messages,
            sending: false,
            canSend: false,
            conversationState: "abandoned",
            pendingQuestions: [],
            followUpEnabled: false,
            endReason: "评估规则已更新，请新建对话后重新评估。",
            error: ""
          });
          return;
        }
        if (error && error.code === "resource_not_found") {
          self.clearStoredConversation();
          self.setData({
            messages: messages,
            sending: false,
            conversationId: "",
            conversationState: "",
            canSend: true,
            pendingQuestions: [],
            followUpEnabled: false,
            endReason: "",
            input: message,
            retryMessage: message,
            error: "当前对话已过期或不可用，请重新开始后再发送。"
          });
          return;
        }
        self.setData({
          messages: messages,
          sending: false,
          input: message,
          retryMessage: message,
          error: pageUtils.errorMessage(error)
        });
      });
  }
});
