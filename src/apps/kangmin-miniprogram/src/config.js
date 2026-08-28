/**
 * 当前体验版没有客户可登记的微信合法 HTTPS 域名，因此默认关闭网络请求；
 * 正式联调时必须同时注入客户合法 HTTPS 域名并打开 networkEnabled；
 * AppSecret 永远只留在服务端，不进入小程序工程。
 */
module.exports = {
  apiBaseUrl: "",
  networkEnabled: false,
  requestTimeoutMs: 15000,
  // 没有合法域名时不打开匿名问助手，避免把失败的网络入口伪装成可用能力。
  anonymousAgentEnabled: false,
  // 客户体验版的健康记录仅保存在当前小程序本地，不写入服务端患者库。
  anonymousRecordsEnabled: true,
  // 当前开发配置显式关闭微信登录；正式微信联调时由服务端配置后改为 true。
  wechatLoginEnabled: false
};
