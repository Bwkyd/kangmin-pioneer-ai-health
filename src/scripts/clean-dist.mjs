import { readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const workspaceRoot = new URL("../", import.meta.url);
const outputs = [new URL("dist/", workspaceRoot)];
for (const group of ["apps", "packages"]) {
  const groupUrl = new URL(`${group}/`, workspaceRoot);
  for (const entry of await readdir(groupUrl, { withFileTypes: true })) {
    if (entry.isDirectory()) outputs.push(new URL(`${entry.name}/dist/`, groupUrl));
  }
}
for (const output of outputs) {
  await rm(fileURLToPath(output), { recursive: true, force: true });
}
