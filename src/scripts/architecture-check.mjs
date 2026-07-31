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
    if (/from\s+["'][^"']*legacy\//u.test(source) || /import\s*\(["'][^"']*legacy\//u.test(source)) {
      violations.push(`${relative(root, path)} imports legacy/`);
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
