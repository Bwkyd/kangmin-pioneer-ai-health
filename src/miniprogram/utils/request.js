var config = require("../config");

var TOKEN_KEY = "kangmin.session.token";

function CommandError(code, message, status, retryable) {
  this.name = "CommandError";
  this.code = code;
  this.message = message;
  this.status = status || 0;
  this.retryable = retryable === true;
}
CommandError.prototype = Object.create(Error.prototype);

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (char) {
    var random = Math.floor(Math.random() * 16);
    var value = char === "x" ? random : (random & 3) | 8;
    return value.toString(16);
  });
}

function createClient(wxApi, options) {
  var baseUrl = String(options.apiBaseUrl || "").replace(/\/$/, "");
  var timeout = options.requestTimeoutMs || 15000;
  var wechatLoginEnabled = options.wechatLoginEnabled === true;
  var loginPromise = null;

  function toError(payload, statusCode) {
    var error = payload && payload.error ? payload.error : {};
    return new CommandError(
      typeof error.code === "string" ? error.code : "bad_response",
      typeof error.message === "string" ? error.message : "服务返回格式不正确",
      statusCode,
      error.retryable === true
    );
  }

  function rawRequest(path, method, data, token) {
    return new Promise(function (resolve, reject) {
      var headers = { "content-type": "application/json", accept: "application/json" };
      if (token) headers.Authorization = "Bearer " + token;
      wxApi.request({
        url: baseUrl + path,
        method: method || "POST",
        data: data || {},
        header: headers,
        timeout: timeout,
        success: function (response) {
          var payload = response.data;
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(payload);
            return;
          }
          reject(toError(payload, response.statusCode));
        },
        fail: function (reason) {
          reject(new CommandError(
            "network_error",
            reason && reason.errMsg ? reason.errMsg : "服务暂时无法连接",
            0,
            true
          ));
        }
      });
    });
  }

  function login() {
    if (!wechatLoginEnabled) {
      return Promise.reject(new CommandError(
        "capability_unavailable",
        "微信登录尚未配置"
      ));
    }
    if (loginPromise) return loginPromise;
    loginPromise = new Promise(function (resolve, reject) {
      wxApi.login({
        success: function (result) {
          if (!result.code) {
            reject(new CommandError("authentication_required", "微信未返回登录凭证"));
            return;
          }
          rawRequest("/v1/auth/wechat", "POST", { code: result.code })
            .then(function (payload) {
              if (!payload || payload.ok !== true || !payload.data || !payload.data.token) {
                throw toError(payload, 200);
              }
              wxApi.setStorageSync(TOKEN_KEY, payload.data.token);
              resolve(payload.data.token);
            })
            .catch(reject);
        },
        fail: function () {
          reject(new CommandError("authentication_required", "微信登录失败，请稍后重试"));
        }
      });
    }).finally(function () {
      loginPromise = null;
    });
    return loginPromise;
  }

  function requestWithAuth(path, data, auth, retried) {
    var existing = auth ? wxApi.getStorageSync(TOKEN_KEY) : "";
    var tokenPromise = auth && !existing ? login() : Promise.resolve(existing);
    return tokenPromise.then(function (token) {
      return rawRequest(path, "POST", data, token).catch(function (error) {
        if (auth && !retried && error.code === "authentication_required") {
          wxApi.removeStorageSync(TOKEN_KEY);
          return login().then(function (newToken) {
            return rawRequest(path, "POST", data, newToken);
          });
        }
        throw error;
      });
    });
  }

  function command(name, input, optionsValue) {
    var settings = optionsValue || {};
    var auth = settings.auth !== false;
    var body = {
      schemaVersion: "1",
      command: name,
      input: input || {},
      requestId: uuid()
    };
    return requestWithAuth("/v1/patient/commands", body, auth, false).then(function (payload) {
      if (!payload || payload.ok !== true) throw toError(payload, 200);
      return payload.data;
    });
  }

  function mediaUrl(path) {
    if (!path) return "";
    if (/^https?:\/\//.test(path)) return path;
    return baseUrl + (path.charAt(0) === "/" ? path : "/" + path);
  }

  return {
    command: command,
    login: login,
    mediaUrl: mediaUrl,
    tokenKey: TOKEN_KEY
  };
}

var client = createClient(wx, config);
module.exports = {
  CommandError: CommandError,
  command: client.command,
  createClient: createClient,
  login: client.login,
  mediaUrl: client.mediaUrl,
  tokenKey: client.tokenKey
};
