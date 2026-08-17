/**
 * 小程序客户端只连接服务端 API。正式交付时通过客户合法 HTTPS 域名替换此值；
 * AppSecret 永远只留在服务端，不进入小程序工程。
 */
module.exports = {
  apiBaseUrl: "https://140.143.120.176",
  requestTimeoutMs: 15000,
  // 当前开发配置显式关闭微信登录；正式微信联调时由服务端配置后改为 true。
  wechatLoginEnabled: false
};
