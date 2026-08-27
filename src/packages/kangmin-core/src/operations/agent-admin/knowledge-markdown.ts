import type { ChunkInput } from "./agent-admin-ports.js";

const CHUNK_TARGET_LENGTH = 1200;

function cleanHeading(value: string): string {
  return value.replace(/[*_`]/gu, "").replace(/^[-\s]+/u, "").trim();
}

function splitLongBlock(value: string, maxLength: number): string[] {
  if (value.length <= maxLength) return [value];
  const sentences = value.split(/(?<=[。！？；])\s*/u).filter(Boolean);
  const pieces: string[] = [];
  let buffer = "";
  for (const sentence of sentences) {
    if (sentence.length > maxLength) {
      if (buffer !== "") pieces.push(buffer);
      buffer = "";
      for (let start = 0; start < sentence.length; start += maxLength) {
        pieces.push(sentence.slice(start, start + maxLength));
      }
    } else if (buffer !== "" && buffer.length + sentence.length > maxLength) {
      pieces.push(buffer);
      buffer = sentence;
    } else {
      buffer += sentence;
    }
  }
  if (buffer !== "") pieces.push(buffer);
  return pieces;
}

/**
 * Markdown 知识分块：保留最近标题作为每块上下文，并强制每块不超过
 * 1200 字符。分块器遵循标准 Markdown 标题层级；非标准编校稿应在
 * 入库准备阶段先规范层级，避免把相邻兄弟标题误拼成父子关系。
 */
export function chunkKnowledgeText(
  text: string,
  documentLabel?: string
): ChunkInput[] {
  const blocks = text
    .replace(/\r\n?/gu, "\n")
    .split(/\n\s*\n/u)
    .map((block) => block.trim())
    .filter(Boolean);
  const chunks: ChunkInput[] = [];
  const headings: string[] = [];
  const label = documentLabel?.trim() ?? "";
  let buffer = "";
  let prefix = label === "" ? "" : `资料章节：${label}\n`;

  const flush = (): void => {
    if (buffer === "") return;
    chunks.push({ index: chunks.length, text: `${prefix}${buffer}`.trim() });
    buffer = "";
  };

  for (const block of blocks) {
    const heading = /^(#{1,6})\s*(.+)$/u.exec(block);
    if (heading !== null) {
      flush();
      const title = cleanHeading(heading[2] ?? "");
      if (title !== "") {
        const level = heading[1]?.length ?? 1;
        headings.length = level - 1;
        headings[level - 1] = title;
      }
      prefix = [
        label === "" ? "" : `资料章节：${label}`,
        headings.filter(Boolean).length === 0
          ? ""
          : `知识主题：${headings.filter(Boolean).join(" > ")}`
      ].filter(Boolean).join("\n");
      if (prefix !== "") prefix += "\n";
      continue;
    }
    const available = Math.max(200, CHUNK_TARGET_LENGTH - prefix.length);
    for (const piece of splitLongBlock(block, available)) {
      if (
        buffer !== "" &&
        prefix.length + buffer.length + piece.length + 1 > CHUNK_TARGET_LENGTH
      ) {
        flush();
      }
      buffer = buffer === "" ? piece : `${buffer}\n${piece}`;
    }
  }
  flush();
  if (chunks.length === 0 && prefix.trim() !== "") {
    chunks.push({ index: 0, text: prefix.trim() });
  }
  return chunks;
}
