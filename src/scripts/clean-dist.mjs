import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/", import.meta.url);
await rm(fileURLToPath(dist), { recursive: true, force: true });
