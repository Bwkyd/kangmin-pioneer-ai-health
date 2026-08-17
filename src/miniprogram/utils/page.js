function selectTab(page, index) {
  if (page && typeof page.getTabBar === "function") {
    var tabBar = page.getTabBar();
    if (tabBar) tabBar.setData({ selected: index });
  }
}

function errorMessage(error) {
  if (error && error.code === "capability_unavailable") {
    return "微信登录尚未配置，文章和视频仍可浏览；症状记录将在正式微信联调时开放。";
  }
  if (error && typeof error.message === "string") return error.message;
  return "加载失败，请稍后重试";
}

module.exports = { errorMessage: errorMessage, selectTab: selectTab };
