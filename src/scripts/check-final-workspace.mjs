import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(workspaceRoot, "..");
const expectedTopLevel = ["apps", "packages", "scripts", "tests"];
const actualTopLevel = readdirSync(workspaceRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !["dist", "node_modules"].includes(entry.name) && !entry.name.startsWith("."))
  .map((entry) => entry.name)
  .sort();
if (JSON.stringify(actualTopLevel) !== JSON.stringify(expectedTopLevel)) {
  throw new Error(`src 顶层必须精确为 ${expectedTopLevel.join("/")}，实际为 ${actualTopLevel.join("/")}`);
}

const allowlist = join(workspaceRoot, "scripts/workspace-migration-allowlist.json");
if (existsSync(allowlist)) throw new Error("最终 workspace 不得保留迁移白名单");

const expectedWorkspaces = new Set([
  "@kangmin/admin",
  "@kangmin/api",
  "@kangmin/cli",
  "@kangmin/miniprogram",
  "@kangmin/core",
  "@kangmin/database",
  "@kangmin/integrations",
  "@kangmin/runtime"
]);
for (const group of ["apps", "packages"]) {
  for (const entry of readdirSync(join(workspaceRoot, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = join(workspaceRoot, group, entry.name);
    for (const required of ["package.json", "README.md", "src", "tests"]) {
      if (!existsSync(join(root, required))) throw new Error(`${group}/${entry.name} 缺少统一小壳 ${required}`);
    }
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expectedWorkspaces.delete(manifest.name);
  }
}
if (expectedWorkspaces.size > 0) throw new Error(`缺少 workspace：${[...expectedWorkspaces].join("、")}`);

const packageJson = readFileSync(join(workspaceRoot, "package.json"), "utf8");
for (const name of ["core", "database", "integrations", "runtime", "cli", "api", "admin"]) {
  if (!packageJson.includes(`--workspace @kangmin/${name}`)) throw new Error(`根构建未覆盖 @kangmin/${name}`);
}

const delivery = [
  readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
  readFileSync(join(workspaceRoot, "Dockerfile"), "utf8"),
  packageJson
].join("\n");
if (/(?:^|[\s"'=,(])dist\/(?:app|cli|dev|http)\//mu.test(delivery)) {
  throw new Error("交付链不得恢复旧编译入口");
}
for (const current of ["apps/kangmin-api/dist/server.js", "apps/kangmin-cli/dist/kangmin.js"]) {
  if (!delivery.includes(current)) throw new Error(`交付链缺少当前入口 ${current}`);
}

console.log("check-final-workspace: PASS");
