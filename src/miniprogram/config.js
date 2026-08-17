/**
 * 当前只连接公开 Web 试用环境。正式交付时通过客户合法域名替换此值；
 * AppSecret 永远只留在服务端，不进入小程序工程。
 */
module.exports = {
  apiBaseUrl: "https://140.143.120.176",
  requestTimeoutMs: 15000,
  // 当前 Web 试用服务器显式关闭微信登录；正式微信联调时改为 true。
  wechatLoginEnabled: false
};
