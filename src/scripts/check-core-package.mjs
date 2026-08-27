import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(workspaceRoot, "packages/kangmin-core");
const sourceRoot = join(packageRoot, "src");

for (const relativePath of ["package.json", "README.md", "src", "tests", "tsconfig.json"]) {
  if (!existsSync(join(packageRoot, relativePath))) {
    throw new Error(`核心包缺少 ${relativePath}`);
  }
}

for (const retiredDirectory of ["kernel", "modules"]) {
  if (existsSync(join(workspaceRoot, retiredDirectory))) {
    throw new Error(`核心能力仍残留在旧目录 ${retiredDirectory}/`);
  }
}

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (manifest.name !== "@kangmin/core" || manifest.private !== true || manifest.exports?.["./*"] === undefined) {
  throw new Error("核心包必须命名为 @kangmin/core、保持 private 并声明通配 exports");
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const forbidden = /(?:^|\/)(?:infrastructure|http|cli|apps|database|integrations)(?:\/|$)/u;
for (const file of filesUnder(sourceRoot)) {
  if (!statSync(file).isFile() || !file.endsWith(".ts")) continue;
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/gu)) {
    if (forbidden.test(match[2])) {
      throw new Error(`核心包存在外层依赖：${relative(packageRoot, file)} -> ${match[2]}`);
    }
  }
}

console.log("check-core-package: PASS");
