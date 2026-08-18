import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

const root = resolve("miniprogram");

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function json(relativePath) {
  return JSON.parse(read(relativePath));
}

const app = json("app.json");
const project = json("project.config.json");
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

for (const asset of ["brand-banner.jpg", "assistant-mascot-static.png"]) {
  const webAsset = readFileSync(resolve("web/public", asset));
  const miniAsset = readFileSync(join(root, "assets", asset));
  if (!webAsset.equals(miniAsset)) {
    throw new Error(`小程序视觉资产未与 Web 正本同步：${asset}`);
  }
}

const javascriptFiles = [
  "app.js",
  "config.js",
  "utils/date.js",
  "utils/page.js",
  "utils/request.js",
  "custom-tab-bar/index.js",
  ...app.pages.map((page) => `${page}.js`)
];
for (const file of javascriptFiles) {
  new vm.Script(read(file), { filename: file });
}

const nativeTags = new Set(["button", "image", "input", "picker", "rich-text", "slider", "text", "video", "view"]);
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
for (const requiredCommand of ["agent exec", "agent conversations list", "agent conversations show"]) {
  if (!assistantSource.includes(requiredCommand)) {
    throw new Error(`原生问助手缺少服务端会话命令：${requiredCommand}`);
  }
}

console.log("check-miniprogram: PASS");
