import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = join(workspaceRoot, "apps/kangmin-admin");

for (const relativePath of [
  "package.json",
  "README.md",
  "index.html",
  "src/main.tsx",
  "src/AdminApp.tsx",
  "src/client.ts",
  "tests/README.md",
  "tsconfig.json",
  "tsconfig.test.json",
  "vite.config.ts"
]) {
  if (!existsSync(join(appRoot, relativePath))) {
    throw new Error(`管理后台小壳缺少 ${relativePath}`);
  }
}

if (existsSync(join(workspaceRoot, "web"))) {
  throw new Error("旧 web/ 目录必须退役，患者端只保留微信小程序");
}

const manifest = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
if (manifest.name !== "@kangmin/admin" || manifest.private !== true) {
  throw new Error("管理后台包必须命名为 @kangmin/admin 且保持 private");
}

const html = readFileSync(join(appRoot, "index.html"), "utf8");
if (!html.includes('id="admin-root"') || html.includes("patient-root")) {
  throw new Error("管理后台首页必须只挂载 admin-root");
}

const server = readFileSync(join(workspaceRoot, "apps/kangmin-api/src/server.ts"), "utf8");
if (server.includes('"admin.html"') || !server.includes('requestUrl.pathname === "/admin"')) {
  throw new Error("HTTP 壳必须让 /admin 复用唯一 index.html，不能恢复第二份 admin.html");
}

console.log("check-admin-app: PASS");
