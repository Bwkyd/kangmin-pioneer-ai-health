import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sourceRoot = new URL("../web/", import.meta.url);
const targetRoot = new URL("../dist/web/", import.meta.url);

await mkdir(fileURLToPath(targetRoot), { recursive: true });
await Promise.all(
  ["index.html", "app.js", "styles.css"].map((filename) =>
    copyFile(
      fileURLToPath(new URL(filename, sourceRoot)),
      fileURLToPath(new URL(filename, targetRoot))
    )
  )
);
