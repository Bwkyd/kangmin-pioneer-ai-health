import { strFromU8, unzlibSync, unzipSync } from "fflate";

export const ARTICLE_IMPORT_MAX_BYTES = 30 * 1024 * 1024;
const MAX_EXTRACTED_TEXT = 60_000;
const MAX_DOCX_XML_BYTES = 4 * 1024 * 1024;
const PDF_SIGNATURE = "%PDF-";
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const MAX_CHAIN_SECTORS = 100_000;

export type ArticleImportFormat = "doc" | "docx" | "pdf";

export class DocumentImportError extends Error {
  readonly status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = "DocumentImportError";
    this.status = status;
  }
}

export type ArticleImportPreview = {
  filename: string;
  format: ArticleImportFormat;
  title: string;
  source: string;
  text: string;
  characterCount: number;
};

function readUint16(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 2 > bytes.length) throw new Error("读取文件结构越界");
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error("读取文件结构越界");
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] * 0x1000000)) >>> 0;
}

function readInt32(bytes: Uint8Array, offset: number) {
  return readUint32(bytes, offset) | 0;
}

function hasSignature(bytes: Uint8Array, signature: number[]) {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

function decodeUtf16Le(bytes: Uint8Array) {
  return new TextDecoder("utf-16le", { fatal: false }).decode(bytes);
}

function decodeUtf16Be(bytes: Uint8Array) {
  const swapped = new Uint8Array(bytes.length - (bytes.length % 2));
  for (let index = 0; index < swapped.length; index += 2) {
    swapped[index] = bytes[index + 1];
    swapped[index + 1] = bytes[index];
  }
  return new TextDecoder("utf-16le", { fatal: false }).decode(swapped);
}

function decodeTextBytes(bytes: Uint8Array) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16Be(bytes.slice(2));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16Le(bytes.slice(2));
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!utf8.includes("\ufffd")) return utf8;
  return strFromU8(bytes, true);
}

function normalizeText(value: string) {
  return value
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT);
}

function titleFromText(filename: string, text: string) {
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean);
  const baseName = filename.replace(/\.[^.]+$/u, "").replace(/[_-]+/gu, " ").trim();
  return (firstLine || baseName || "导入文章").slice(0, 160);
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/&#(\d+);/gu, (_match, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlToText(xml: string) {
  return decodeXmlEntities(xml
    .replace(/<w:tab\b[^>]*\/?\s*>/giu, "\t")
    .replace(/<w:br\b[^>]*\/?\s*>/giu, "\n")
    .replace(/<\/w:(?:p|tr)\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, ""));
}

function extractDocxText(bytes: Uint8Array) {
  try {
    const archive = unzipSync(bytes, {
      filter: (entry) => {
        if (entry.name !== "word/document.xml") return false;
        if (entry.originalSize > MAX_DOCX_XML_BYTES) throw new DocumentImportError("Word 正文展开后超过服务限制，请拆分文件后重试", 413);
        return true;
      },
    });
    const xml = archive["word/document.xml"];
    if (!xml) throw new DocumentImportError("Word 文件中没有可读取的正文", 422);
    return normalizeText(xmlToText(strFromU8(xml)));
  } catch (error) {
    if (error instanceof DocumentImportError) throw error;
    throw new DocumentImportError("Word 文件转换失败，请确认文件未损坏并包含正文", 422);
  }
}

function readPdfLiteral(value: string, start: number) {
  let index = start + 1;
  let depth = 1;
  const bytes: number[] = [];
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x5c) {
      index += 1;
      if (index >= value.length) break;
      const escaped = value[index];
      const mapped: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
      if (mapped[escaped]) {
        for (const character of mapped[escaped]) bytes.push(character.charCodeAt(0));
        index += 1;
        continue;
      }
      if (escaped === "\r") {
        index += value[index + 1] === "\n" ? 2 : 1;
        continue;
      }
      if (escaped === "\n") {
        index += 1;
        continue;
      }
      if (/[0-7]/u.test(escaped)) {
        let octal = escaped;
        index += 1;
        for (let count = 1; count < 3 && /[0-7]/u.test(value[index] ?? ""); count += 1, index += 1) octal += value[index];
        bytes.push(Number.parseInt(octal, 8));
        continue;
      }
      bytes.push(escaped.charCodeAt(0));
      index += 1;
      continue;
    }
    if (code === 0x28) depth += 1;
    if (code === 0x29) {
      depth -= 1;
      if (depth === 0) return { text: decodeTextBytes(new Uint8Array(bytes)), end: index + 1 };
    }
    bytes.push(code & 0xff);
    index += 1;
  }
  return { text: decodeTextBytes(new Uint8Array(bytes)), end: value.length };
}

function readPdfHex(value: string, start: number) {
  const end = value.indexOf(">", start + 1);
  if (end < 0) return { text: "", end: value.length };
  const hex = value.slice(start + 1, end).replace(/\s+/gu, "");
  const bytes = new Uint8Array(Math.ceil(hex.length / 2));
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2).padEnd(2, "0"), 16) || 0;
  return { text: decodeTextBytes(bytes), end: end + 1 };
}

function skipPdfWhitespace(value: string, start: number) {
  let index = start;
  while (index < value.length && /[\s\0]/u.test(value[index])) index += 1;
  return index;
}

function readPdfOperator(value: string, start: number) {
  const index = skipPdfWhitespace(value, start);
  if (value[index] === "'" || value[index] === '"') return { operator: value[index], end: index + 1 };
  const match = value.slice(index).match(/^(?:Tj|TJ)\b/u);
  return match ? { operator: match[0], end: index + match[0].length } : null;
}

function extractPdfOperators(value: string) {
  const chunks: string[] = [];
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (character === "(") {
      const literal = readPdfLiteral(value, index);
      const operator = readPdfOperator(value, literal.end);
      if (operator) {
        chunks.push(literal.text);
        if (operator.operator !== "Tj") chunks.push("\n");
      }
      index = literal.end;
      continue;
    }
    if (character === "<" && value[index + 1] !== "<") {
      const hex = readPdfHex(value, index);
      const operator = readPdfOperator(value, hex.end);
      if (operator) {
        chunks.push(hex.text);
        if (operator.operator !== "Tj") chunks.push("\n");
      }
      index = hex.end;
      continue;
    }
    if (character === "[") {
      const values: string[] = [];
      let cursor = index + 1;
      while (cursor < value.length && value[cursor] !== "]") {
        if (value[cursor] === "(") {
          const literal = readPdfLiteral(value, cursor);
          values.push(literal.text);
          cursor = literal.end;
        } else if (value[cursor] === "<" && value[cursor + 1] !== "<") {
          const hex = readPdfHex(value, cursor);
          values.push(hex.text);
          cursor = hex.end;
        } else {
          cursor += 1;
        }
      }
      const arrayEnd = cursor < value.length ? cursor + 1 : value.length;
      const operator = readPdfOperator(value, arrayEnd);
      if (operator?.operator === "TJ") {
        chunks.push(values.join(""), "\n");
      }
      index = arrayEnd;
      continue;
    }
    index += 1;
  }
  return chunks.join("");
}

function extractPdfText(bytes: Uint8Array) {
  const source = strFromU8(bytes, true);
  const candidates = [source];
  let cursor = 0;
  while (cursor < source.length) {
    const streamMarker = source.indexOf("stream", cursor);
    if (streamMarker < 0) break;
    let streamStart = streamMarker + "stream".length;
    if (source.slice(streamStart, streamStart + 2) === "\r\n") streamStart += 2;
    else if (source[streamStart] === "\n" || source[streamStart] === "\r") streamStart += 1;
    const streamEnd = source.indexOf("endstream", streamStart);
    if (streamEnd < 0) break;
    const dictionaryStart = source.lastIndexOf("<<", streamMarker);
    const dictionary = dictionaryStart >= 0 ? source.slice(dictionaryStart, streamMarker) : "";
    if (/\/FlateDecode\b/u.test(dictionary)) {
      try {
        candidates.push(strFromU8(unzlibSync(bytes.slice(streamStart, streamEnd)), true));
      } catch {
        // Other filters, malformed streams, and image streams are ignored; the
        // caller will still reject the file if no readable text is found.
      }
    }
    cursor = streamEnd + "endstream".length;
  }
  return normalizeText(candidates.map(extractPdfOperators).filter(Boolean).join("\n"));
}

type CfbEntry = { name: string; type: number; start: number; size: number };

function readRegularSector(bytes: Uint8Array, sectorSize: number, sector: number) {
  const offset = sectorSize + sector * sectorSize;
  if (!Number.isSafeInteger(offset) || offset < sectorSize || offset + sectorSize > bytes.length) throw new Error("CFB 扇区越界");
  return bytes.slice(offset, offset + sectorSize);
}

function readChainFromBytes(bytes: Uint8Array, first: number, table: number[], unitSize: number, limit: number) {
  if (first === ENDOFCHAIN || first === FREESECT) return new Uint8Array();
  const pieces: Uint8Array[] = [];
  const visited = new Set<number>();
  let current = first >>> 0;
  let total = 0;
  while (current !== ENDOFCHAIN) {
    if (current >= table.length || visited.has(current) || visited.size >= MAX_CHAIN_SECTORS) throw new Error("CFB 链结构无效");
    const offset = current * unitSize;
    if (offset + unitSize > bytes.length) throw new Error("CFB 链数据越界");
    visited.add(current);
    pieces.push(bytes.slice(offset, offset + unitSize));
    total += unitSize;
    if (total > limit) throw new Error("CFB 流超过服务限制");
    current = table[current] >>> 0;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    output.set(piece, offset);
    offset += piece.length;
  }
  return output;
}

function readRegularChain(bytes: Uint8Array, first: number, fat: number[], sectorSize: number, limit: number) {
  if (first === ENDOFCHAIN || first === FREESECT) return new Uint8Array();
  const pieces: Uint8Array[] = [];
  const visited = new Set<number>();
  let current = first >>> 0;
  let total = 0;
  while (current !== ENDOFCHAIN) {
    if (current >= fat.length || visited.has(current) || visited.size >= MAX_CHAIN_SECTORS) throw new Error("CFB FAT 链结构无效");
    visited.add(current);
    pieces.push(readRegularSector(bytes, sectorSize, current));
    total += sectorSize;
    if (total > limit) throw new Error("CFB 流超过服务限制");
    current = fat[current] >>> 0;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    output.set(piece, offset);
    offset += piece.length;
  }
  return output;
}

function parseCfb(bytes: Uint8Array) {
  if (bytes.length < 512 || !hasSignature(bytes, CFB_SIGNATURE)) throw new Error("不是有效的 CFB 文件");
  const sectorSize = 1 << readUint16(bytes, 30);
  const miniSectorSize = 1 << readUint16(bytes, 32);
  const firstDirectorySector = readUint32(bytes, 48);
  const numberOfFatSectors = readUint32(bytes, 44);
  const firstMiniFatSector = readUint32(bytes, 60);
  const numberOfMiniFatSectors = readUint32(bytes, 64);
  const firstDifatSector = readUint32(bytes, 68);
  const numberOfDifatSectors = readUint32(bytes, 72);
  const miniStreamCutoff = readUint32(bytes, 56);
  if (![512, 4096].includes(sectorSize) || miniSectorSize !== 64 || numberOfFatSectors > MAX_CHAIN_SECTORS) throw new Error("CFB 文件版本不受支持");

  const fatSectorIds: number[] = [];
  for (let index = 0; index < 109 && fatSectorIds.length < numberOfFatSectors; index += 1) {
    const sector = readUint32(bytes, 76 + index * 4);
    if (sector !== FREESECT) fatSectorIds.push(sector);
  }
  let nextDifat = firstDifatSector;
  for (let count = 0; count < numberOfDifatSectors && fatSectorIds.length < numberOfFatSectors; count += 1) {
    if (nextDifat === ENDOFCHAIN || nextDifat === FREESECT) throw new Error("CFB DIFAT 链结构无效");
    const sector = readRegularSector(bytes, sectorSize, nextDifat);
    for (let index = 0; index < sectorSize / 4 - 1 && fatSectorIds.length < numberOfFatSectors; index += 1) {
      const fatSector = readUint32(sector, index * 4);
      if (fatSector !== FREESECT) fatSectorIds.push(fatSector);
    }
    nextDifat = readUint32(sector, sectorSize - 4);
  }
  if (fatSectorIds.length !== numberOfFatSectors) throw new Error("CFB FAT 不完整");
  const fat: number[] = [];
  for (const sectorId of fatSectorIds) {
    const sector = readRegularSector(bytes, sectorSize, sectorId);
    for (let index = 0; index < sectorSize; index += 4) fat.push(readUint32(sector, index));
  }

  const directoryBytes = readRegularChain(bytes, firstDirectorySector, fat, sectorSize, ARTICLE_IMPORT_MAX_BYTES);
  const entries: CfbEntry[] = [];
  for (let offset = 0; offset + 128 <= directoryBytes.length; offset += 128) {
    const nameLength = readUint16(directoryBytes, offset + 64);
    if (nameLength < 2 || nameLength > 64 || offset + nameLength > directoryBytes.length) continue;
    const name = decodeUtf16Le(directoryBytes.slice(offset, offset + nameLength - 2));
    const type = directoryBytes[offset + 66];
    const start = readUint32(directoryBytes, offset + 116);
    const size = readUint32(directoryBytes, offset + 120) + readUint32(directoryBytes, offset + 124) * 0x100000000;
    if (size > ARTICLE_IMPORT_MAX_BYTES) throw new Error("CFB 流超过服务限制");
    entries.push({ name, type, start, size });
  }
  const root = entries.find((entry) => entry.type === 5);
  if (!root) throw new Error("CFB 根目录不存在");
  const miniFatBytes = numberOfMiniFatSectors > 0
    ? readRegularChain(bytes, firstMiniFatSector, fat, sectorSize, ARTICLE_IMPORT_MAX_BYTES)
    : new Uint8Array();
  const miniFat: number[] = [];
  for (let offset = 0; offset + 4 <= miniFatBytes.length; offset += 4) miniFat.push(readUint32(miniFatBytes, offset));
  const miniStream = root.size > 0 ? readRegularChain(bytes, root.start, fat, sectorSize, ARTICLE_IMPORT_MAX_BYTES) : new Uint8Array();
  function readStream(entry: CfbEntry) {
    if (entry.size === 0) return new Uint8Array();
    const data = entry.size < miniStreamCutoff
      ? readChainFromBytes(miniStream, entry.start, miniFat, miniSectorSize, entry.size + miniSectorSize)
      : readRegularChain(bytes, entry.start, fat, sectorSize, ARTICLE_IMPORT_MAX_BYTES);
    return data.slice(0, entry.size);
  }
  return { entries, readStream };
}

const SPECIAL_COMPRESSED_CHARS: Record<number, string> = {
  0x82: "\u201a", 0x83: "\u0192", 0x84: "\u201e", 0x85: "\u2026", 0x86: "\u2020", 0x87: "\u2021", 0x88: "\u02c6", 0x89: "\u2030",
  0x8a: "\u0160", 0x8b: "\u2039", 0x8c: "\u0152", 0x91: "\u2018", 0x92: "\u2019", 0x93: "\u201c", 0x94: "\u201d", 0x95: "\u2022",
  0x96: "\u2013", 0x97: "\u2014", 0x98: "\u02dc", 0x99: "\u2122", 0x9a: "\u0161", 0x9b: "\u203a", 0x9c: "\u0153", 0x9f: "\u0178",
};

function decodeCompressedWordBytes(bytes: Uint8Array) {
  const mapped = Array.from(bytes, (value) => SPECIAL_COMPRESSED_CHARS[value] ?? String.fromCharCode(value));
  return mapped.join("");
}

function extractLegacyWordText(bytes: Uint8Array) {
  const cfb = parseCfb(bytes);
  const wordEntry = cfb.entries.find((entry) => entry.type === 2 && entry.name === "WordDocument");
  if (!wordEntry) throw new Error("WordDocument 流不存在");
  const word = cfb.readStream(wordEntry);
  if (word.length < 0x1aa || readUint16(word, 0) !== 0xa5ec) throw new Error("Word FIB 无效");
  const flags = readUint16(word, 0x0a);
  if ((flags & 0x0100) !== 0 || (flags & 0x8000) !== 0) throw new DocumentImportError("受密码保护或加密的 Word 文档不能直接导入，请先解密后重试", 422);
  const ccpText = readInt32(word, 0x4c);
  const fcClx = readUint32(word, 0x1a2);
  const lcbClx = readUint32(word, 0x1a6);
  if (ccpText <= 0 || lcbClx <= 0 || fcClx + lcbClx > 0x7fffffff) throw new Error("Word 正文索引无效");
  const tableName = (flags & 0x0200) !== 0 ? "1Table" : "0Table";
  const tableEntry = cfb.entries.find((entry) => entry.type === 2 && entry.name === tableName);
  if (!tableEntry) throw new Error("Word 表流不存在");
  const table = cfb.readStream(tableEntry);
  if (fcClx + lcbClx > table.length) throw new Error("Word 正文索引越界");
  const clx = table.slice(fcClx, fcClx + lcbClx);
  let cursor = 0;
  while (cursor < clx.length) {
    if (clx[cursor] === 0x01) {
      const size = readUint32(clx, cursor + 1);
      cursor += 5 + size;
      continue;
    }
    if (clx[cursor] !== 0x02) break;
    const plcSize = readUint32(clx, cursor + 1);
    const plc = clx.slice(cursor + 5, cursor + 5 + plcSize);
    const pieceCount = (plc.length - 4) / 12;
    if (!Number.isInteger(pieceCount) || pieceCount <= 0) throw new Error("Word Piece Table 无效");
    const cpOffset = 0;
    const pcdOffset = 4 * (pieceCount + 1);
    const chunks: string[] = [];
    for (let index = 0; index < pieceCount; index += 1) {
      const cpStart = readUint32(plc, cpOffset + index * 4);
      const cpEnd = readUint32(plc, cpOffset + (index + 1) * 4);
      const characterCount = cpEnd - cpStart;
      if (characterCount <= 0 || characterCount > MAX_EXTRACTED_TEXT) throw new Error("Word 文本范围无效");
      const fcCompressed = readUint32(plc, pcdOffset + index * 8 + 2);
      const compressed = (fcCompressed & 1) !== 0;
      const fc = fcCompressed & 0xfffffffe;
      if (compressed) {
        const byteOffset = Math.floor(fc / 2);
        if (byteOffset + characterCount > word.length) throw new Error("Word 压缩文本越界");
        chunks.push(decodeCompressedWordBytes(word.slice(byteOffset, byteOffset + characterCount)));
      } else {
        const byteOffset = fc;
        if (byteOffset + characterCount * 2 > word.length) throw new Error("Word Unicode 文本越界");
        chunks.push(decodeUtf16Le(word.slice(byteOffset, byteOffset + characterCount * 2)));
      }
    }
    return normalizeText(chunks.join(""));
  }
  throw new Error("Word 正文 Piece Table 不存在");
}

function extractRtfText(bytes: Uint8Array) {
  let value = strFromU8(bytes, true);
  value = value.replace(/\\'([0-9a-f]{2})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  value = value.replace(/\\(par|line)\b\s?/giu, "\n").replace(/\\tab\b\s?/giu, "\t");
  value = value.replace(/\\[a-z]+-?\d*\s?/giu, "").replace(/[{}]/gu, "");
  return normalizeText(decodeTextBytes(Uint8Array.from(value, (character) => character.charCodeAt(0) & 0xff)));
}

function extractLegacyDocText(bytes: Uint8Array) {
  if (strFromU8(bytes.slice(0, 5), true) === "{\\rtf") return extractRtfText(bytes);
  return extractLegacyWordText(bytes);
}

function detectFormat(file: File, bytes: Uint8Array): ArticleImportFormat {
  const extension = file.name.toLowerCase().match(/\.(docx?|pdf)$/u)?.[1];
  if (!extension) throw new DocumentImportError("不支持该文件格式，仅支持 Word（.doc/.docx）和 PDF（.pdf）", 415);
  if (extension === "pdf") {
    if (!strFromU8(bytes.slice(0, PDF_SIGNATURE.length), true).startsWith(PDF_SIGNATURE)) throw new DocumentImportError("文件内容与 PDF 扩展名不一致，请重新选择文件", 415);
    return "pdf";
  }
  if (extension === "docx") {
    if (!hasSignature(bytes, ZIP_SIGNATURE)) throw new DocumentImportError("文件内容与 DOCX 扩展名不一致，请重新导出 Word 文件", 415);
    return "docx";
  }
  if (!hasSignature(bytes, CFB_SIGNATURE) && strFromU8(bytes.slice(0, 5), true) !== "{\\rtf") throw new DocumentImportError("文件内容与 DOC 扩展名不一致，请选择 Word 文档", 415);
  return "doc";
}

export async function parseArticleImport(file: File): Promise<ArticleImportPreview> {
  if (!(file instanceof File)) throw new DocumentImportError("请选择 Word 或 PDF 文件", 400);
  if (file.size <= 0) throw new DocumentImportError("文件为空，不能导入文章", 422);
  if (file.size > ARTICLE_IMPORT_MAX_BYTES) throw new DocumentImportError("文件为空或超过 30 MB 限制，请选择更小的文件", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = detectFormat(file, bytes);
  let text = "";
  try {
    if (format === "docx") text = extractDocxText(bytes);
    else if (format === "doc") text = extractLegacyDocText(bytes);
    else text = extractPdfText(bytes);
  } catch (error) {
    if (error instanceof DocumentImportError) throw error;
    throw new DocumentImportError(format === "pdf"
      ? "PDF 文件转换失败，请确认文件未损坏且包含可复制的正文"
      : "Word 文件转换失败，请确认文件未损坏并包含正文", 422);
  }
  if (!text) {
    if (format === "pdf") throw new DocumentImportError("PDF 未提取到可复制文本；扫描件需要先完成 OCR 并经预览确认", 422);
    throw new DocumentImportError("文件正文为空，不能导入文章", 422);
  }
  return {
    filename: file.name.slice(0, 160),
    format,
    title: titleFromText(file.name, text),
    source: `${format === "pdf" ? "PDF" : "Word"} 导入：${file.name.slice(0, 160)}`,
    text,
    characterCount: text.length,
  };
}
