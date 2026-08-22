import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { basename, join, resolve } from "node:path";

interface ManualEntry {
  input: string;
  output: string;
}

export const MANUAL_ENTRIES: readonly ManualEntry[] = [
  { input: "第一章/第一章 第一节 编委李丽娜.md", output: "01-过敏性鼻炎定义与古籍记载.md" },
  { input: "第一章/第一章 第二节 编委李丽娜.md", output: "02-过敏性鼻炎发病机制.md" },
  { input: "第一章/第一章 第三节 编委李丽娜.md", output: "03-诊断与鉴别诊断.md" },
  { input: "第一章/第一章 第四节 编委李丽娜.md", output: "04-中西医治疗概述.md" },
  { input: "第一章/第一章 第五节 编委李丽娜.md", output: "05-研究进展.md" },
  { input: "第二章/中篇  过敏性鼻炎的临床治疗-郑敏钦-第一节.md", output: "06-针刺类技术.md" },
  { input: "第二章/第二章 第二节 编委何玲玲-2024.8.1.md", output: "07-灸类技术.md" },
  { input: "第二章/第二章 第三节 编委袁永昌.md", output: "08-刮痧类技术.md" },
  { input: "第二章/第二章 第四节 编委袁永昌.md", output: "09-拔罐类技术.md" },
  { input: "第二章/第二章 第五节 编委何玲玲 -2024.8.1.md", output: "10-推拿类技术.md" },
  { input: "第三章/第三章 第一节 编委张彩云增加内容后.md", output: "11-临床常用腧穴.md" },
  { input: "第三章/过敏性鼻炎分期治疗文稿-范怀玲.md", output: "12-分期治疗.md" },
  { input: "第三章/名医名家治疗过敏性鼻炎-叶开欢.md", output: "13-名医名法.md" },
  { input: "第四章/第四章 第一节 编委何玲玲-V1.md", output: "14-专家共识背景与范围.md" },
  { input: "第四章/第四章 第二节 编委何玲玲 - V1.md", output: "15-全周期推荐方案.md" },
  { input: "第四章/第四章 第三节 编委何玲玲-V1.md", output: "16-分度推荐方案.md" },
  { input: "第四章/第四章 第四节 编委何玲玲 -V1.md", output: "17-对症推荐方案.md" }
];

const EXCLUDED_AGGREGATE = "第一章/鼻鼽第一章样本编辑20240801.md";
const SOURCE_NAME = "《福建省中医药适宜技术手册》原始编校资料（完整收集版）";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\s*\n[\s\S]*?\n---\s*\n/u, "");
}

function normalizeHeadingLevels(text: string): string {
  const methodHeading = /^(?:治疗方法|常规毫针刺法|透穴针刺法|蝶腭神经节刺激术|热敏灸(?:技术|法)|隔物灸法|耳穴疗法|穴位注射法|穴位敷贴法|刮痧法)$/u;
  return text.replace(/^(#{1,6})\s*(.+)$/gmu, (_line, marks: string, rawTitle: string) => {
    if (marks.length < 3) return `${marks} ${rawTitle.trim()}`;
    const title = rawTitle.replace(/[*_`]/gu, "").replace(/^[-\s]+/u, "").trim();
    let level = marks.length;
    if (/^第[一二三四五六七八九十]+节/u.test(title)) level = 3;
    else if (/^[一二三四五六七八九十]+[、.]/u.test(title) || /^(?:轻度|中重度|鼻塞|流清涕|咳嗽|头痛)$/u.test(title)) level = 4;
    else if (/^[（(][一二三四五六七八九十]+[）)]/u.test(title) || methodHeading.test(title)) level = 5;
    else if (/^\d+[、.]/u.test(title)) level = 6;
    return `${"#".repeat(level)} ${rawTitle.trim()}`;
  });
}

/** 去编校元数据与重复整书目录；正文、参考文献和操作风险原样保留。 */
export function normalizeManualMarkdown(raw: string, sourcePath: string): {
  text: string;
  imageCaptions: number;
} {
  let body = stripFrontmatter(raw).replace(/\r\n?/gu, "\n");
  const repeatedBodySeparator = /\n---\s*\n+(?=#)/u.exec(body);
  if (repeatedBodySeparator?.index !== undefined) {
    body = body.slice(repeatedBodySeparator.index + repeatedBodySeparator[0].length);
  }
  let imageCaptions = 0;
  body = body.replace(
    /!\[([^\]]*)\]\(<([^>]+)>\)|!\[([^\]]*)\]\(([^\n)]+)\)/gu,
    (_match, angleAlt: string | undefined, anglePath: string | undefined,
      plainAlt: string | undefined, plainPath: string | undefined) => {
      imageCaptions += 1;
      const alt = (angleAlt ?? plainAlt ?? "原文插图").trim() || "原文插图";
      const path = (anglePath ?? plainPath ?? "").trim();
      return `插图说明：${alt}。原图位置：${path}（文本知识库不解析图像细节）。`;
    }
  );
  body = body
    .replace(/^\|(?:\s*:?-+:?\s*\|)+\s*$/gmu, "")
    .replace(/^\|(?:\s*\|)+\s*$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  body = normalizeHeadingLevels(body);
  const header = [
    `# ${SOURCE_NAME}`,
    "",
    `> 来源文件：${sourcePath}`,
    "> 资料边界：本文件仅供知识检索与科普转译，不作为证型、分期、个体方案或操作参数的裁决依据。",
    ""
  ].join("\n");
  return { text: `${header}${body}\n`, imageCaptions };
}

export function prepareManualKnowledge(sourceRoot: string, outputRoot: string): {
  files: number;
  imageCaptions: number;
  manifestSha256: string;
} {
  const resolvedSource = resolve(sourceRoot);
  const resolvedOutput = resolve(outputRoot);
  if (resolvedSource === resolvedOutput) {
    throw new Error("输出目录不能与原始资料目录相同");
  }
  mkdirSync(resolvedOutput, { recursive: true });
  const allowedOutputs = new Set([
    ...MANUAL_ENTRIES.map((entry) => entry.output),
    "manifest.json"
  ]);
  const unexpected = readdirSync(resolvedOutput)
    .filter((name) => !allowedOutputs.has(name));
  if (unexpected.length > 0) {
    throw new Error(`输出目录包含非本脚本文件，拒绝覆盖：${unexpected.join("、")}`);
  }
  const manifestFiles: Array<{
    input: string;
    inputSha256: string;
    output: string;
    outputSha256: string;
    imageCaptions: number;
  }> = [];
  for (const entry of MANUAL_ENTRIES) {
    const input = readFileSync(join(resolvedSource, entry.input));
    const normalized = normalizeManualMarkdown(input.toString("utf8"), entry.input);
    writeFileSync(join(resolvedOutput, entry.output), normalized.text, "utf8");
    manifestFiles.push({
      input: entry.input,
      inputSha256: sha256(input),
      output: entry.output,
      outputSha256: sha256(normalized.text),
      imageCaptions: normalized.imageCaptions
    });
  }
  // 明确读取排除稿，确保路径存在；它是五个第一章分稿的汇编重复，不再入库。
  const excluded = readFileSync(join(resolvedSource, EXCLUDED_AGGREGATE));
  const manifest = {
    formatVersion: 1,
    sourceName: SOURCE_NAME,
    sourceRoot: basename(resolvedSource),
    excluded: [{ path: EXCLUDED_AGGREGATE, reason: "第一章五个分稿的汇编重复", sha256: sha256(excluded) }],
    files: manifestFiles
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(resolvedOutput, "manifest.json"), manifestText, "utf8");
  return {
    files: manifestFiles.length,
    imageCaptions: manifestFiles.reduce((sum, file) => sum + file.imageCaptions, 0),
    manifestSha256: sha256(manifestText)
  };
}

async function main(): Promise<void> {
  const [sourceRoot, outputRoot] = process.argv.slice(2);
  if (sourceRoot === undefined || outputRoot === undefined) {
    throw new Error("用法：prepare-manual-knowledge <原始资料目录> <输出目录>");
  }
  process.stdout.write(`${JSON.stringify(prepareManualKnowledge(sourceRoot, outputRoot))}\n`);
}

if (process.argv[1]?.endsWith("prepare-manual-knowledge.js")) {
  await main();
}
