import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(workspaceRoot, "..");
const workspaces = [
  ["packages/kangmin-runtime", "@kangmin/runtime"],
  ["apps/kangmin-cli", "@kangmin/cli"],
  ["apps/kangmin-api", "@kangmin/api"]
];

for (const [directory, name] of workspaces) {
  for (const path of ["package.json", "README.md", "src", "tests", "tsconfig.json"]) {
    if (!existsSync(join(workspaceRoot, directory, path))) throw new Error(`${name} 缺少 ${path}`);
  }
}

for (const directory of ["app", "cli", "dev", "evals", "http"]) {
  if (existsSync(join(workspaceRoot, directory))) throw new Error(`旧顶层目录仍残留：${directory}`);
}

const runtime = JSON.parse(readFileSync(join(workspaceRoot, "packages/kangmin-runtime/package.json"), "utf8"));
for (const dependency of ["@kangmin/core", "@kangmin/database", "@kangmin/integrations"]) {
  if (runtime.dependencies?.[dependency] === undefined) throw new Error(`runtime 必须显式依赖 ${dependency}`);
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

for (const [directory, name] of workspaces.slice(1)) {
  const packageRoot = join(workspaceRoot, directory);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== name || manifest.private !== true) throw new Error(`${directory} 的包名或 private 声明错误`);
  if (manifest.dependencies?.["@kangmin/runtime"] === undefined || manifest.dependencies?.["@kangmin/core"] === undefined) {
    throw new Error(`${name} 必须只通过 core/runtime 取得业务与组合能力`);
  }
  for (const forbidden of ["@kangmin/database", "@kangmin/integrations"]) {
    if (manifest.dependencies?.[forbidden] !== undefined) throw new Error(`${name} 不得依赖 ${forbidden}`);
  }
  for (const file of filesUnder(join(packageRoot, "src"))) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(file, "utf8");
    if (/from\s+["']@kangmin\/(?:database|integrations)(?:\/|["'])/u.test(source)) {
      throw new Error(`${relative(packageRoot, file)} 绕过 runtime 直连数据库或集成实现`);
    }
  }
}

const cli = JSON.parse(readFileSync(join(workspaceRoot, "apps/kangmin-cli/package.json"), "utf8"));
if (cli.bin?.kangmin !== "./dist/kangmin.js" || cli.bin?.["kangmin-admin"] !== "./dist/kangmin-admin.js") {
  throw new Error("CLI app 必须保留 kangmin 与 kangmin-admin 两个稳定命令名");
}

const deliveryFiles = [
  join(repositoryRoot, ".github/workflows/ci.yml"),
  join(workspaceRoot, "Dockerfile"),
  join(workspaceRoot, "package.json")
];
for (const file of deliveryFiles) {
  const source = readFileSync(file, "utf8");
  if (/(?:^|[\s"'=,(])dist\/(?:app|cli|dev|http)\//mu.test(source)) {
    throw new Error(`交付链仍引用旧编译入口：${relative(repositoryRoot, file)}`);
  }
}
const ci = readFileSync(deliveryFiles[0], "utf8");
if (!ci.includes("apps/kangmin-cli/dist/kangmin.js")) {
  throw new Error("镜像 CI 必须从新的 CLI workspace 执行容器冒烟");
}

console.log("check-runtime-entrypoints: PASS");
