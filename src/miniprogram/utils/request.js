var config = require("../config");

var TOKEN_KEY = "kangmin.session.token";
var AGENT_STREAM_PATH = "/v1/patient/agent/stream";
var SCHEMA_VERSION = "1";

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

  function bytesOf(value) {
    if (typeof value === "string") return null;
    if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (value && value.buffer && typeof Uint8Array !== "undefined") {
      return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
    }
    return null;
  }

  // 小程序端不能依赖浏览器 TextDecoder：这里保留跨 chunk 的 UTF-8 尾字节，
  // 避免中文刚好被切在 2/3/4 字节字符中间时出现乱码。
  function decodeUtf8Chunk(value, state, flush) {
    if (typeof value === "string") return value;
    var bytes = bytesOf(value);
    if (!bytes) return String(value || "");
    var source = [];
    (state.pending || []).forEach(function (byte) { source.push(byte); });
    for (var index = 0; index < bytes.length; index += 1) source.push(bytes[index]);
    state.pending = [];
    var output = "";
    var cursor = 0;
    while (cursor < source.length) {
      var first = source[cursor];
      var length = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
      if (!length) {
        output += "�";
        cursor += 1;
        continue;
      }
      if (cursor + length > source.length) {
        if (!flush) state.pending = source.slice(cursor);
        else output += "�";
        break;
      }
      var valid = true;
      for (var continuation = 1; continuation < length; continuation += 1) {
        if ((source[cursor + continuation] & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
      }
      if (!valid) {
        output += "�";
        cursor += 1;
        continue;
      }
      var codePoint = first & (length === 1 ? 0x7f : length === 2 ? 0x1f : length === 3 ? 0x0f : 0x07);
      for (var part = 1; part < length; part += 1) codePoint = (codePoint << 6) | (source[cursor + part] & 0x3f);
      if (codePoint > 0x10ffff || codePoint >= 0xd800 && codePoint <= 0xdfff || length === 3 && codePoint < 0x800 || length === 4 && codePoint < 0x10000) {
        output += "�";
      } else if (codePoint <= 0xffff) {
        output += String.fromCharCode(codePoint);
      } else {
        codePoint -= 0x10000;
        output += String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff));
      }
      cursor += length;
    }
    return output;
  }

  function parseStreamResponse(value) {
    if (typeof value === "string") {
      try { return JSON.parse(value); } catch (error) { return null; }
    }
    var bytes = bytesOf(value);
    if (!bytes) return value;
    return parseStreamResponse(decodeUtf8Chunk(bytes, { pending: [] }, true));
  }

  function createStreamParser(handlers) {
    var textBuffer = "";
    var utf8State = { pending: [] };
    var completed = null;

    function consumeLine(line) {
      if (!line.trim()) return;
      var event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new CommandError("bad_response", "流式事件不是有效 JSON", 200);
      }
      if (!event || typeof event.type !== "string") {
        throw new CommandError("bad_response", "流式事件格式不正确", 200);
      }
      if (event.type === "start") {
        if (handlers.onStart) handlers.onStart();
      } else if (event.type === "delta" && typeof event.content === "string") {
        if (handlers.onDelta) handlers.onDelta(event.content);
      } else if (event.type === "done") {
        completed = event.data;
        if (handlers.onDone) handlers.onDone(event.data);
      } else {
        throw new CommandError("bad_response", "流式事件类型不正确", 200);
      }
    }

    return {
      push: function (value) {
        textBuffer += decodeUtf8Chunk(value, utf8State, false);
        var lines = textBuffer.split("\n");
        textBuffer = lines.pop() || "";
        lines.forEach(consumeLine);
      },
      finish: function () {
        textBuffer += decodeUtf8Chunk(new Uint8Array(0), utf8State, true);
        if (textBuffer.trim()) consumeLine(textBuffer);
        textBuffer = "";
        return completed;
      }
    };
  }

  function rawStream(input, token, handlers, controller) {
    var parser = createStreamParser(handlers);
    var settled = false;
    var sawChunk = false;
    var task = null;
    var resolvePromise;
    var rejectPromise;
    var promise = new Promise(function (resolve, reject) {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    function settleError(error) {
      if (settled) return;
      settled = true;
      if (controller.abortImpl === abortStream) controller.abortImpl = null;
      if (controller.task === task) controller.task = null;
      if (handlers.onError) handlers.onError(error);
      rejectPromise(error);
    }

    function settleSuccess(response) {
      if (settled) return;
      try {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          settleError(toError(parseStreamResponse(response.data), response.statusCode));
          return;
        }
        // 少数基础库会把很短的响应只放在 success 中；仍按同一 NDJSON
        // 解析，但真正的流式能力必须由 RequestTask.onChunkReceived 提供。
        if (!sawChunk && response.data !== undefined && response.data !== null) parser.push(response.data);
        var completed = parser.finish();
        if (completed === null || completed === undefined) {
          settleError(new CommandError("stream_interrupted", "回答传输未完成，结果可能已保存，请刷新后恢复", response.statusCode));
          return;
        }
        settled = true;
        if (controller.abortImpl === abortStream) controller.abortImpl = null;
        if (controller.task === task) controller.task = null;
        resolvePromise(completed);
      } catch (error) {
        settleError(error instanceof CommandError ? error : new CommandError("bad_response", "流式回答解析失败", response.statusCode));
      }
    }

    function abortStream() {
      if (settled) return;
      if (task && typeof task.abort === "function") task.abort();
      settleError(new CommandError("stream_aborted", "回答已停止，结果可能已保存，请刷新后确认", 0, true));
    }

    controller.abortImpl = abortStream;

    try {
      task = wxApi.request({
        url: baseUrl + AGENT_STREAM_PATH,
        method: "POST",
        data: {
          schemaVersion: SCHEMA_VERSION,
          input: input || {},
          requestId: uuid()
        },
        header: {
          "content-type": "application/json",
          accept: "application/x-ndjson",
          Authorization: token ? "Bearer " + token : ""
        },
        timeout: timeout,
        responseType: "arraybuffer",
        enableChunked: true,
        enableHttp2: false,
        success: settleSuccess,
        fail: function (reason) {
          settleError(new CommandError("network_error", reason && reason.errMsg ? reason.errMsg : "回答传输中断，请稍后重试", 0, true));
        }
      });
      controller.task = task;
      if (!task || typeof task.onChunkReceived !== "function") {
        settleError(new CommandError("stream_unavailable", "当前微信基础库不支持流式回答，请升级微信后重试"));
        if (task && typeof task.abort === "function") task.abort();
        return promise;
      }
      task.onChunkReceived(function (chunk) {
        if (settled) return;
        sawChunk = true;
        try { parser.push(chunk && chunk.data); }
        catch (error) { settleError(error instanceof CommandError ? error : new CommandError("bad_response", "流式回答解析失败", 200)); }
      });
    } catch (error) {
      settleError(new CommandError("network_error", error && error.message ? error.message : "回答传输中断，请稍后重试", 0, true));
    }
    return promise;
  }

  function streamAgent(input, handlers) {
    var controller = { task: null, abortImpl: null, aborted: false, reject: null };
    function abortedError() {
      return new CommandError("stream_aborted", "回答已停止，结果可能已保存，请稍后确认", 0, true);
    }
    var promise = new Promise(function (resolve, reject) {
      var settled = false;
      function resolveOnce(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }
      function rejectOnce(error) {
        if (settled) return;
        settled = true;
        reject(error);
      }
      controller.reject = rejectOnce;
      controller.abort = function () {
        controller.aborted = true;
        if (controller.abortImpl) {
          controller.abortImpl();
          return;
        }
        if (controller.task && typeof controller.task.abort === "function") controller.task.abort();
        rejectOnce(abortedError());
      };
      function attempt(retried) {
        var existing = wxApi.getStorageSync(TOKEN_KEY) || "";
        var tokenPromise = existing ? Promise.resolve(existing) : login();
        tokenPromise.then(function (token) {
          if (controller.aborted) {
            rejectOnce(abortedError());
            return;
          }
          var stream = rawStream(input, token, handlers || {}, controller);
          stream.then(resolveOnce).catch(function (error) {
            if (!retried && error && error.code === "authentication_required") {
              wxApi.removeStorageSync(TOKEN_KEY);
              login().then(function (newToken) {
                if (controller.aborted) {
                  rejectOnce(abortedError());
                  return;
                }
                var retryStream = rawStream(input, newToken, handlers || {}, controller);
                retryStream.then(resolveOnce).catch(rejectOnce);
              }).catch(rejectOnce);
              return;
            }
            rejectOnce(error);
          });
        }).catch(rejectOnce);
      }
      attempt(false);
    });
    promise.abort = function () {
      controller.abort();
    };
    return promise;
  }

  function mediaUrl(path) {
    if (!path) return "";
    if (/^https?:\/\//.test(path)) return path;
    return baseUrl + (path.charAt(0) === "/" ? path : "/" + path);
  }

  return {
    command: command,
    login: login,
    streamAgent: streamAgent,
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
  streamAgent: client.streamAgent,
  mediaUrl: client.mediaUrl,
  tokenKey: client.tokenKey
};
