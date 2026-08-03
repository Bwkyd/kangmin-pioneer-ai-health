// 生成 CycloneDX SBOM 到 sbom.cyclonedx.json（dist 之外，不入库，
// 见 .gitignore）；CI 运行后以 artifact 上传，本地可手动执行。
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const target = fileURLToPath(new URL("../sbom.cyclonedx.json", import.meta.url));

const { stdout } = await execFileAsync(
  "npm",
  ["sbom", "--sbom-format", "cyclonedx"],
  { maxBuffer: 64 * 1024 * 1024 }
);

await writeFile(target, stdout);
process.stdout.write(`SBOM 已写入 ${target}\n`);
