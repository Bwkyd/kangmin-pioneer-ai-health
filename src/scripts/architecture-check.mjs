import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const violations = [];

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

await walk(root);

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("architecture-check: PASS\n");
}
