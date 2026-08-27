import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const violations = [];
const FINAL_DIRECTORIES = new Set(["apps", "packages", "scripts", "tests"]);
const CODE_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx"]);
const PACKAGE_NAMES = new Map([
  ["kangmin-admin", "@kangmin/admin"],
  ["kangmin-api", "@kangmin/api"],
  ["kangmin-cli", "@kangmin/cli"],
  ["kangmin-miniprogram", "@kangmin/miniprogram"],
  ["kangmin-core", "@kangmin/core"],
  ["kangmin-database", "@kangmin/database"],
  ["kangmin-integrations", "@kangmin/integrations"],
  ["kangmin-runtime", "@kangmin/runtime"]
]);
const ALLOWED_DEPENDENCIES = new Map([
  ["@kangmin/admin", new Set()],
  ["@kangmin/api", new Set(["@kangmin/core", "@kangmin/runtime"])],
  ["@kangmin/cli", new Set(["@kangmin/core", "@kangmin/runtime"])],
  ["@kangmin/miniprogram", new Set()],
  ["@kangmin/core", new Set()],
  ["@kangmin/database", new Set(["@kangmin/core"])],
  ["@kangmin/integrations", new Set(["@kangmin/core"])],
  ["@kangmin/runtime", new Set([
    "@kangmin/core",
    "@kangmin/database",
    "@kangmin/integrations"
  ])]
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["dist", "node_modules"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function isWithin(path, parent) {
  const value = relative(parent, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function workspaceDirectories(directory) {
  return ["apps", "packages"].flatMap((group) => {
    const groupPath = join(directory, group);
    if (!existsSync(groupPath)) return [];
    return readdirSync(groupPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(groupPath, entry.name));
  });
}

function validateWorkspace(directory) {
  const failures = [];
  const rootPackagePath = join(directory, "package.json");
  if (!existsSync(rootPackagePath)) return ["根目录缺少 package.json"];
  const rootPackage = readJson(rootPackagePath);
  for (const required of ["apps/*", "packages/*"]) {
    if (!(rootPackage.workspaces ?? []).includes(required)) {
      failures.push(`根 package.json 缺少 workspace：${required}`);
    }
  }

  const allowlistPath = join(directory, "scripts", "workspace-migration-allowlist.json");
  const allowlist = existsSync(allowlistPath) ? readJson(allowlistPath) : { legacyDirectories: [] };
  const legacyDirectories = new Set(allowlist.legacyDirectories ?? []);
  if (legacyDirectories.size > 0 && (!allowlist.owner || !allowlist.expiresOn || !allowlist.reason)) {
    failures.push("迁移白名单必须包含 owner、expiresOn 与 reason");
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || ["dist", "node_modules"].includes(entry.name)) continue;
    if (!FINAL_DIRECTORIES.has(entry.name) && !legacyDirectories.has(entry.name)) {
      failures.push(`未登记的 src 顶层目录：${entry.name}`);
    }
  }
  for (const oldDirectory of legacyDirectories) {
    if (!existsSync(join(directory, oldDirectory))) {
      failures.push(`迁移白名单只能缩小：已不存在的目录仍被登记：${oldDirectory}`);
    }
  }

  const workspacesByName = new Map();
  for (const workspace of workspaceDirectories(directory)) {
    const directoryName = workspace.split(sep).at(-1);
    for (const required of ["package.json", "README.md", "src", "tests"]) {
      if (!existsSync(join(workspace, required))) {
        failures.push(`${relative(directory, workspace)} 缺少统一小壳：${required}`);
      }
    }
    const packagePath = join(workspace, "package.json");
    if (!existsSync(packagePath)) continue;
    const packageJson = readJson(packagePath);
    const expectedName = PACKAGE_NAMES.get(directoryName);
    if (packageJson.name !== expectedName) {
      failures.push(`${relative(directory, workspace)} 包名应为 ${expectedName ?? "已登记的 @kangmin 名称"}`);
    }
    if (workspace.includes(`${sep}apps${sep}`) && packageJson.private !== true) {
      failures.push(`${packageJson.name} 应保持 private`);
    }
    if (workspace.includes(`${sep}packages${sep}`) && !packageJson.exports) {
      failures.push(`${packageJson.name} 必须声明显式 exports`);
    }
    if (existsSync(join(workspace, "src"))) {
      const sourceFiles = walkFiles(join(workspace, "src")).filter((file) => statSync(file).isFile());
      if (sourceFiles.length === 0) failures.push(`${packageJson.name} 的 src 不得为空壳`);
    }
    workspacesByName.set(packageJson.name, { directory: workspace, packageJson });
  }

  for (const [name, workspace] of workspacesByName) {
    const allowed = ALLOWED_DEPENDENCIES.get(name);
    if (!allowed) {
      failures.push(`未登记依赖规则的 workspace：${name}`);
      continue;
    }
    const dependencies = {
      ...(workspace.packageJson.dependencies ?? {}),
      ...(workspace.packageJson.devDependencies ?? {})
    };
    for (const dependency of Object.keys(dependencies).filter((item) => item.startsWith("@kangmin/"))) {
      if (!allowed.has(dependency)) failures.push(`${name} 不得依赖 ${dependency}`);
    }
    for (const file of walkFiles(workspace.directory).filter((item) => CODE_EXTENSIONS.has(extname(item)))) {
      const source = readFileSync(file, "utf8");
      const imports = source.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*["'](\.\.?\/[^"']+)["']/gu);
      for (const match of imports) {
        if (!isWithin(resolve(dirname(file), match[1]), workspace.directory)) {
          failures.push(`${relative(directory, file)} 使用跨 workspace 相对导入：${match[1]}`);
        }
      }
    }
  }
  return failures;
}

function writeFixture(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-workspace-layout-"));
  writeFixture(join(directory, "package.json"), JSON.stringify({
    name: "@kangmin/workspace",
    private: true,
    workspaces: ["apps/*", "packages/*"]
  }));
  const app = join(directory, "apps", "kangmin-miniprogram");
  if (!options.missingManifest) {
    writeFixture(join(app, "package.json"), JSON.stringify({
      name: "@kangmin/miniprogram",
      private: true,
      dependencies: options.illegalDependency ? { "@kangmin/runtime": "workspace:*" } : {}
    }));
  }
  writeFixture(join(app, "README.md"), "# fixture\n");
  if (options.emptySource) mkdirSync(join(app, "src"), { recursive: true });
  else writeFixture(join(app, "src", "app.js"), options.crossImport
    ? "require('../../../packages/kangmin-core/src/index.js')"
    : "module.exports = {};");
  writeFixture(join(app, "tests", "README.md"), "# tests\n");
  if (options.unknownDirectory) mkdirSync(join(directory, "unknown"));
  return directory;
}

function selfTest() {
  const valid = validateWorkspace(fixture());
  if (valid.length !== 0) throw new Error(`合法 fixture 被拒绝：${valid.join("; ")}`);
  for (const [options, expected] of [
    [{ missingManifest: true }, "缺少统一小壳：package.json"],
    [{ illegalDependency: true }, "不得依赖 @kangmin/runtime"],
    [{ crossImport: true }, "跨 workspace 相对导入"],
    [{ emptySource: true }, "src 不得为空壳"],
    [{ unknownDirectory: true }, "未登记的 src 顶层目录：unknown"]
  ]) {
    if (!validateWorkspace(fixture(options)).some((failure) => failure.includes(expected))) {
      throw new Error(`负例未被拦截：${expected}`);
    }
  }
  const checker = fileURLToPath(import.meta.url);
  const result = spawnSync(process.execPath, [checker, "--workspace-root", fixture({ unknownDirectory: true })], { encoding: "utf8" });
  if (result.status === 0 || !result.stderr.includes("未登记的 src 顶层目录：unknown")) {
    throw new Error("真实 CLI 未以非零状态拦截违规 workspace");
  }
  process.stdout.write("architecture-check self-test: PASS（5 类负例，真实 CLI 非零）\n");
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }

    if (![".ts", ".mjs"].includes(extname(entry.name))) {
      continue;
    }

    const source = await readFile(path, "utf8");
    const file = relative(root, path);
    if (/from\s+["'][^"']*legacy\//u.test(source) || /import\s*\(["'][^"']*legacy\//u.test(source)) {
      violations.push(`${file} imports legacy/`);
    }

    if (
      file.startsWith("modules/") &&
      /from\s+["'][^"']*(?:infrastructure|http|cli|dev|web)\//u.test(source)
    ) {
      violations.push(`${file} crosses from a core module into an adapter`);
    }

    if (
      file.startsWith("modules/") &&
      /from\s+["'][^"']*\.\.\/(?!kernel\/)/u.test(source)
    ) {
      // 跨模块导入只允许公开契约面（contracts.ts / domain.ts / *-ports.ts）。
      // media-validation.ts 是素材/知识双链路共用的类型与大小校验唯一来源
      // （对象存储接入，issue-141），视同公开契约面。
      const crossModule = /from\s+["'](\.\.\/[a-z0-9-]+\/)([^"']+)["']/gu;
      for (const match of source.matchAll(crossModule)) {
        const [, directory, target] = match;
        const targetFile = target.replace(/\.js$/u, ".ts");
        if (
          directory !== "../kernel/" &&
          !/(?:contracts|domain|-ports|media-validation)\.ts$/u.test(targetFile)
        ) {
          violations.push(
            `${file} imports ${directory}${target} outside the public contract surface`
          );
        }
      }
    }

    if (
      file === "app/application.ts" &&
      /from\s+["'][^"']*infrastructure\//u.test(source)
    ) {
      violations.push(
        `${file} imports infrastructure outside the composition root`
      );
    }

    if (
      file.startsWith("kernel/") &&
      /from\s+["'][^"']*(?:app|modules|infrastructure|http|cli|dev|web)\//u.test(source)
    ) {
      violations.push(`${file} depends on an outer application layer`);
    }

    if (
      /^(?:cli|http|dev)\//u.test(file) &&
      /from\s+["'][^"']*infrastructure\//u.test(source)
    ) {
      violations.push(`${file} bypasses the composition root`);
    }
  }
}

if (process.argv[2] === "--self-test") {
  selfTest();
  process.exit(0);
}

if (process.argv[2] === "--workspace-root") {
  const failures = validateWorkspace(resolve(process.argv[3]));
  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("workspace-layout: PASS\n");
  process.exit(0);
}

violations.push(...validateWorkspace(root));
await walk(root);

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("architecture-check: PASS\n");
}
