import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = join(workspaceRoot, "apps/kangmin-miniprogram");
const root = join(projectRoot, "src");

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function json(relativePath) {
  return JSON.parse(read(relativePath));
}

const app = json("app.json");
const project = JSON.parse(readFileSync(join(projectRoot, "project.config.json"), "utf8"));
const expectedTabs = [
  "pages/home/index",
  "pages/assistant/index",
  "pages/calendar/index",
  "pages/mine/index"
];
const selectedIndexes = new Map([
  ["pages/home/index", 0],
  ["pages/assistant/index", 1],
  ["pages/calendar/index", 3],
  ["pages/mine/index", 4]
]);

if (project.appid !== "") {
  throw new Error("project.config.json 不得提交真实 AppID，具体标识只留在开发者工具本地配置");
}
if (JSON.stringify(project).toLowerCase().includes("secret")) {
  throw new Error("小程序项目配置不得包含 AppSecret");
}
if (project.miniprogramRoot !== "src/") {
  throw new Error("微信工程必须从统一 workspace 小壳的 src/ 加载小程序源码");
}
if (app.tabBar?.custom !== true) {
  throw new Error("小程序必须使用自定义 tabBar 保留中央症状记录动作");
}
const tabPaths = app.tabBar.list.map((item) => item.pagePath);
if (JSON.stringify(tabPaths) !== JSON.stringify(expectedTabs)) {
  throw new Error(`tabBar 页面不符合约定：${tabPaths.join(", ")}`);
}

for (const page of app.pages) {
  for (const extension of ["js", "json", "wxml", "wxss"]) {
    const path = join(root, `${page}.${extension}`);
    if (!statSync(path).isFile()) throw new Error(`缺少页面文件：${page}.${extension}`);
  }

  if (selectedIndexes.has(page)) {
    const source = read(`${page}.js`);
    const selected = selectedIndexes.get(page);
    if (!source.includes(`selectTab(this, ${selected})`)) {
      throw new Error(`${page}.js 的自定义底栏选中索引应为 ${selected}`);
    }
  }
}

const brandBanner = readFileSync(join(root, "assets/brand-banner.jpg"));
if (brandBanner.length < 1_024 || brandBanner.subarray(0, 2).toString("hex") !== "ffd8") {
  throw new Error("小程序品牌横幅必须是有效的 JPEG 资产");
}
const staticMascot = readFileSync(join(root, "assets/assistant-mascot-static.png"));
if (staticMascot.length < 1_024 || staticMascot.subarray(1, 4).toString("ascii") !== "PNG") {
  throw new Error("小程序静态吉祥物必须是有效的 PNG 资产");
}

const animatedMascot = readFileSync(join(root, "assets", "assistant-mascot-loop-v2.gif"));
if (!animatedMascot.subarray(0, 6).toString("ascii").startsWith("GIF8")) {
  throw new Error("小程序动画吉祥物必须是 GIF 资产");
}

const javascriptFiles = [
  "app.js",
  "config.js",
  "utils/date.js",
  "utils/page.js",
  "utils/request.js",
  "utils/learning-catalog.js",
  "utils/questionnaire.js",
  "custom-tab-bar/index.js",
  ...app.pages.map((page) => `${page}.js`)
];
for (const file of javascriptFiles) {
  new vm.Script(read(file), { filename: file });
}

const nativeTags = new Set(["button", "image", "input", "picker", "rich-text", "slider", "textarea", "text", "video", "view"]);
for (const page of app.pages) {
  const source = read(`${page}.wxml`);
  for (const match of source.matchAll(/<\/?([A-Za-z][\w-]*)\b/gu)) {
    if (!nativeTags.has(match[1])) {
      throw new Error(`${page}.wxml 使用了非原生 WXML 标签：${match[1]}`);
    }
  }

  const javascript = read(`${page}.js`);
  const handlers = source.matchAll(/(?:bind|catch)(?:tap|change|input|confirm|error)="([A-Za-z_$][\w$]*)"/gu);
  for (const match of handlers) {
    const handler = match[1];
    const declaration = new RegExp(`(?:^|[,{\\s])${handler}\\s*:`, "mu");
    if (!declaration.test(javascript)) {
      throw new Error(`${page}.wxml 绑定了不存在的处理函数：${handler}`);
    }
  }
}

const requestSource = read("utils/request.js");
for (const forbidden of ["AppSecret", "session_key", "openId", "openid"]) {
  if (requestSource.includes(forbidden)) {
    throw new Error(`小程序请求层不得持有服务端身份字段：${forbidden}`);
  }
}

const assistantSource = read("pages/assistant/index.js");
for (const requiredCommand of ["agent conversations list", "agent conversations show", "streamAgent"]) {
  if (!assistantSource.includes(requiredCommand)) {
    throw new Error(`原生问助手缺少服务端会话命令：${requiredCommand}`);
  }
}

const questionnaireSource = read("utils/questionnaire.js");
if (!questionnaireSource.includes("题面正本只在 assessment-questionnaire.ts")) {
  throw new Error("小程序问卷必须由共享题面正本机械生成");
}

function loadCommonJs(relativePath) {
  const module = { exports: {} };
  new vm.Script(read(relativePath), { filename: relativePath }).runInNewContext({
    module,
    exports: module.exports,
    console
  });
  return module.exports;
}

function parseWxmlElements(source, className) {
  const elements = [];
  const stack = [];
  const tokenPattern = /<!--[\s\S]*?-->|<\/?([A-Za-z][\w-]*)([^<>]*?)>/gu;
  let match;
  while ((match = tokenPattern.exec(source)) !== null) {
    const token = match[0];
    if (token.startsWith("<!--")) continue;
    const tag = match[1];
    const attributes = match[2] || "";
    if (token.startsWith("</")) {
      const opening = stack.pop();
      if (!opening || opening.tag !== tag) {
        throw new Error(`WXML 标签嵌套无法解析：${tag}`);
      }
      if (opening.classNames.has(className)) {
        elements.push({
          attributes: opening.attributes,
          body: source.slice(opening.bodyStart, match.index ?? source.length)
        });
      }
      continue;
    }
    if (/\/\s*>$/u.test(token)) continue;
    const classMatch = attributes.match(/\bclass\s*=\s*"([^"]*)"/u);
    const classNames = new Set((classMatch?.[1] || "").split(/\s+/u).filter(Boolean));
    stack.push({
      tag,
      attributes,
      classNames,
      bodyStart: (match.index ?? 0) + token.length
    });
  }
  if (stack.length > 0) throw new Error("WXML 存在未闭合标签");
  return elements;
}

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`, "u"));
  return match?.[1] || "";
}

function runRegressionChecks() {
  const checks = [
    {
      id: "#378/API",
      name: "患者端网络能力使用 HTTPS 域名或明确进入安全降级",
      run() {
        const config = loadCommonJs("config.js");
        const networkEnabled = config.networkEnabled !== false;
        if (!networkEnabled) {
          if (config.anonymousAgentEnabled || config.wechatLoginEnabled) {
            throw new Error("网络关闭时不得打开微信登录或匿名问助手");
          }
          if (!read("utils/request.js").includes("network_unavailable")) {
            throw new Error("安全降级必须由请求层返回 network_unavailable，而不是继续调用 wx.request");
          }
          return;
        }
        const url = new URL(String(config.apiBaseUrl || ""));
        const isIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(url.hostname);
        if (url.protocol !== "https:" || isIpv4) {
          throw new Error(`当前 apiBaseUrl 为 ${url.origin}；微信请求入口必须使用已配置的 HTTPS 域名`);
        }
      }
    },
    {
      id: "#378/文案",
      name: "问助手与学一学不向患者暴露微信网络运行时错误",
      run() {
        const pageUtils = loadCommonJs("utils/page.js");
        const assistantSource = read("pages/assistant/index.js");
        const learnSource = read("pages/learn/index.js");
        if (!assistantSource.includes("pageUtils.errorMessage(error)") || !learnSource.includes("pageUtils.errorMessage(error)")) {
          throw new Error("问助手和学一学必须共同使用 pageUtils.errorMessage(error)");
        }
        const message = String(pageUtils.errorMessage({
          code: "network_error",
          message: "request:fail url not in domain list"
        }) || "");
        if (!message || /request:fail|url not in domain list|errMsg/iu.test(message)) {
          throw new Error(`网络失败提示仍暴露平台细节：${message || "<空>"}`);
        }
      }
    },
    {
      id: "#379/结构",
      name: "健康档案记录行具备窄屏布局兜底",
      run() {
        const source = read("pages/health-profile/index.wxss");
        const row = cssRule(source, ".record-row");
        const actions = cssRule(source, ".row-actions");
        const buttons = cssRule(source, ".row-actions button");
        const rowWraps = /\bflex-wrap\s*:\s*wrap\b/u.test(row);
        const actionsWrap = /\bflex-wrap\s*:\s*wrap\b/u.test(actions);
        const actionsCanShrink = /\bmin-width\s*:\s*0\b/u.test(actions) && /\bflex\s*:/u.test(actions);
        const responsiveActions = /@media[^{}]*max-width[^{}]*\{[\s\S]*?\.row-actions[\s\S]*?(?:flex-wrap|flex-direction|width|max-width|min-width|flex)\s*:/u.test(source);
        const gridFallback = /\bdisplay\s*:\s*grid\b/u.test(row) && /grid-template-columns\s*:[^;]*minmax\(\s*0\s*,\s*1fr\s*\)/u.test(row) && (/\bmin-width\s*:\s*0\b/u.test(actions) || /\bwidth\s*:\s*100%\b/u.test(actions));
        const buttonCanShrink = /\bmin-width\s*:\s*0\b/u.test(buttons) && /\bflex\s*:/u.test(buttons);
        if (!(rowWraps && (actionsWrap || actionsCanShrink || responsiveActions || buttonCanShrink)) && !gridFallback) {
          throw new Error(".record-row/.row-actions 未声明换行、收缩或窄屏媒体兜底；必须继续用 DevTools 验证实际像素边界");
        }
      }
    },
    {
      id: "#380/行为",
      name: "我的页所有带箭头入口都有明确点击行为",
      run() {
        const items = parseWxmlElements(read("pages/mine/index.wxml"), "profile-item");
        const arrowItems = items.filter((item) => item.body.includes("›"));
        const missing = arrowItems.filter((item) => !/(?:bindtap|catchtap)\s*=\s*"[^"]+"/u.test(item.attributes));
        if (missing.length > 0) {
          const labels = missing.map((item) => {
            const textNodes = [...item.body.matchAll(/<text(?:\s[^>]*)?>([^<]*)<\/text>/gu)];
            return textNodes.map((node) => String(node[1]).trim()).find((value) => value && value !== "›") || "未命名入口";
          });
          throw new Error(`发现 ${missing.length} 个带箭头但无 bindtap/catchtap 的入口：${labels.join("、")}`);
        }
      }
    }
  ];
  const failures = [];
  for (const check of checks) {
    try {
      check.run();
      console.log(`ok - ${check.id} ${check.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${check.id} ${check.name}：${message}`);
      console.error(`not ok - ${check.id} ${check.name}：${message}`);
    }
  }
  if (failures.length > 0) {
    console.error(`check-miniprogram-regression: FAIL（${failures.length}/${checks.length} 项未通过）`);
    process.exit(1);
  }
  console.log(`check-miniprogram-regression: PASS（${checks.length}/${checks.length} 项通过）`);
}

if (process.argv.includes("--regression")) runRegressionChecks();

console.log("check-miniprogram: PASS");
