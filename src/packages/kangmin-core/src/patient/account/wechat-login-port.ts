/** 微信小程序登录码交换端口；只返回服务端所需 OpenID，不暴露 session_key。 */
export interface WechatLoginIdentity {
  appId: string;
  openId: string;
}

export interface WechatLoginPort {
  exchangeCode(code: string): Promise<WechatLoginIdentity>;
}
