import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(workspaceRoot, "packages/kangmin-integrations");
const sourceRoot = join(packageRoot, "src");
const capabilities = [
  "ai",
  "storage",
  "identity",
  "security",
  "environment",
  "clinical",
  "operations"
];

for (const path of ["package.json", "README.md", "tests", "tsconfig.json", ...capabilities.map((name) => `src/${name}`)]) {
  if (!existsSync(join(packageRoot, path))) throw new Error(`集成包缺少 ${path}`);
}

const legacyRoot = join(workspaceRoot, "infrastructure");
if (existsSync(legacyRoot)) {
  const leftovers = readdirSync(legacyRoot, { withFileTypes: true });
  if (leftovers.length > 0) {
    throw new Error(`外部适配器仍残留在 infrastructure：${leftovers.map((entry) => entry.name).join("、")}`);
  }
}

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (manifest.name !== "@kangmin/integrations" || manifest.private !== true || manifest.exports?.["./*"] === undefined) {
  throw new Error("集成包必须命名为 @kangmin/integrations、保持 private 并声明通配 exports");
}
for (const dependency of ["@kangmin/core", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"]) {
  if (manifest.dependencies?.[dependency] === undefined) throw new Error(`集成包必须显式拥有 ${dependency} 依赖`);
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const forbidden = /(?:^|\/)(?:apps|app|http|cli|dev|database|evals)(?:\/|$)/u;
const allowedExternal = new Set(["@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"]);
for (const file of filesUnder(sourceRoot)) {
  if (!file.endsWith(".ts")) continue;
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/gu)) {
    const dependency = match[2];
    if (forbidden.test(dependency)) {
      throw new Error(`集成包存在外层依赖：${relative(packageRoot, file)} -> ${dependency}`);
    }
    if (!dependency.startsWith(".") && !dependency.startsWith("node:") && !dependency.startsWith("@kangmin/core/") && !allowedExternal.has(dependency)) {
      throw new Error(`集成包存在未声明边界依赖：${relative(packageRoot, file)} -> ${dependency}`);
    }
  }
}

console.log("check-integrations-package: PASS");
