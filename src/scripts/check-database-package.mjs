import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(workspaceRoot, "packages/kangmin-database");
const sourceRoot = join(packageRoot, "src");

for (const path of ["package.json", "README.md", "src/sqlite", "src/postgres", "src/shared", "tests", "tsconfig.json"]) {
  if (!existsSync(join(packageRoot, path))) throw new Error(`数据库包缺少 ${path}`);
}

const legacyRoot = join(workspaceRoot, "infrastructure");
for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
  if (entry.name === "database.ts" || entry.name === "encrypted-fields.ts" || entry.name === "idempotency.ts" || entry.name === "postgres" || entry.name.startsWith("sqlite-")) {
    throw new Error(`数据库实现仍残留在 infrastructure/${entry.name}`);
  }
}

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (manifest.name !== "@kangmin/database" || manifest.private !== true || manifest.exports?.["./*"] === undefined) {
  throw new Error("数据库包必须命名为 @kangmin/database、保持 private 并声明通配 exports");
}
if (manifest.dependencies?.["@kangmin/core"] === undefined || manifest.dependencies?.pg === undefined) {
  throw new Error("数据库包必须显式拥有 @kangmin/core 与 pg 依赖");
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const forbidden = /(?:^|\/)(?:apps|app|http|cli|dev|integrations)(?:\/|$)/u;
for (const file of filesUnder(sourceRoot)) {
  if (!file.endsWith(".ts")) continue;
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/gu)) {
    const dependency = match[2];
    if (forbidden.test(dependency)) {
      throw new Error(`数据库包存在外层依赖：${relative(packageRoot, file)} -> ${dependency}`);
    }
    if (!dependency.startsWith(".") && !dependency.startsWith("node:") && dependency !== "pg" && !dependency.startsWith("@kangmin/core/")) {
      throw new Error(`数据库包存在未声明边界依赖：${relative(packageRoot, file)} -> ${dependency}`);
    }
  }
}

console.log("check-database-package: PASS");
