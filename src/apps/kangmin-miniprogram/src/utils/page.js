function selectTab(page, index) {
  if (page && typeof page.getTabBar === "function") {
    var tabBar = page.getTabBar();
    if (tabBar) tabBar.setData({ selected: index });
  }
}

function errorMessage(error) {
  var code = error && error.code;
  var message = error && typeof error.message === "string" ? error.message : "";
  if (code === "network_unavailable") {
    return "当前体验版尚未配置可用的内容服务，文章、视频和问助手将在正式微信联调后开放。";
  }
  if (error && error.code === "capability_unavailable") {
    return "微信登录尚未配置，患者记录、问助手和消息中心将在正式微信联调时开放；文章和视频仍可浏览。";
  }
  if (code === "network_error" || /request:fail|url not in domain list|errMsg|ERR_[A-Z_]+/iu.test(message)) {
    return "网络暂时不可用，请稍后重试。";
  }
  if (message) return message;
  return "加载失败，请稍后重试";
}

module.exports = { errorMessage: errorMessage, selectTab: selectTab };
