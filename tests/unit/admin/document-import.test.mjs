import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync, zlibSync } from "fflate";

const { ARTICLE_IMPORT_MAX_BYTES, DocumentImportError, parseArticleImport } = await import("../../../lib/admin/document-import.ts");

function asFile(bytes, name, type) {
  return new File([bytes], name, { type });
}

function joinBytes(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function putUint16(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function putUint32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function putCfbDirectoryEntry(bytes, offset, name, type, start, size) {
  for (let index = 0; index < name.length; index += 1) putUint16(bytes, offset + index * 2, name.charCodeAt(index));
  putUint16(bytes, offset + 64, (name.length + 1) * 2);
  bytes[offset + 66] = type;
  bytes.fill(0xff, offset + 68, offset + 116);
  putUint32(bytes, offset + 116, start);
  putUint32(bytes, offset + 120, size);
  putUint32(bytes, offset + 124, 0);
}

function binaryDocFixture() {
  const sectorSize = 512;
  const bytes = new Uint8Array(sectorSize * 19);
  bytes.fill(0xff);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  putUint16(bytes, 24, 0x003e);
  putUint16(bytes, 26, 3);
  putUint16(bytes, 28, 0xfffe);
  putUint16(bytes, 30, 9);
  putUint16(bytes, 32, 6);
  putUint32(bytes, 44, 1);
  putUint32(bytes, 48, 1);
  putUint32(bytes, 56, 4096);
  putUint32(bytes, 60, 0xfffffffe);
  putUint32(bytes, 64, 0);
  putUint32(bytes, 68, 0xfffffffe);
  putUint32(bytes, 72, 0);
  putUint32(bytes, 76, 0);

  const fat = sectorSize;
  putUint32(bytes, fat + 0 * 4, 0xfffffffd);
  putUint32(bytes, fat + 1 * 4, 0xfffffffe);
  for (const [start, end] of [[2, 9], [10, 17]]) {
    for (let sector = start; sector < end; sector += 1) putUint32(bytes, fat + sector * 4, sector + 1);
    putUint32(bytes, fat + end * 4, 0xfffffffe);
  }

  const directory = sectorSize * 2;
  bytes.fill(0, directory, directory + sectorSize);
  putCfbDirectoryEntry(bytes, directory, "Root Entry", 5, 0xfffffffe, 0);
  putCfbDirectoryEntry(bytes, directory + 128, "WordDocument", 2, 2, 4096);
  putCfbDirectoryEntry(bytes, directory + 256, "0Table", 2, 10, 4096);

  const word = sectorSize * 3;
  const text = strToU8("Binary Word text\r");
  bytes.set(text, word + 0x300);
  putUint16(bytes, word, 0xa5ec);
  putUint16(bytes, word + 0x0a, 0);
  putUint32(bytes, word + 0x4c, text.length);
  putUint32(bytes, word + 0x1a2, 0);
  putUint32(bytes, word + 0x1a6, 21);

  const table = sectorSize * 11;
  bytes[table] = 0x02;
  putUint32(bytes, table + 1, 16);
  putUint32(bytes, table + 5, 0);
  putUint32(bytes, table + 9, text.length);
  putUint32(bytes, table + 5 + 8 + 2, (0x300 * 2) | 1);
  return bytes;
}

test("DOCX 导入只读取正文 XML 并返回可确认预览", async () => {
  const docx = zipSync({
    "word/document.xml": strToU8("<w:document xmlns:w=\"x\"><w:body><w:p><w:r><w:t>鼻健康导入标题</w:t></w:r></w:p><w:p><w:r><w:t>正文第一段</w:t></w:r><w:br/><w:r><w:t>正文第二段</w:t></w:r></w:p></w:body></w:document>"),
    "word/media/ignored.bin": new Uint8Array([1, 2, 3]),
  });
  const preview = await parseArticleImport(asFile(docx, "鼻健康.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
  assert.equal(preview.format, "docx");
  assert.equal(preview.title, "鼻健康导入标题");
  assert.match(preview.text, /正文第一段\n正文第二段/u);
  assert.match(preview.source, /Word 导入/u);
});

test("PDF 导入支持 Flate 文本流，但扫描 PDF 明确要求 OCR 后再确认", async () => {
  const stream = zlibSync(strToU8("BT\n(可复制的 PDF 正文) Tj\nET"));
  const header = new TextEncoder().encode(`%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`);
  const tail = new TextEncoder().encode("\nendstream\nendobj\n%%EOF");
  const preview = await parseArticleImport(asFile(joinBytes(header, stream, tail), "pdf文章.pdf", "application/pdf"));
  assert.equal(preview.format, "pdf");
  assert.match(preview.text, /可复制的 PDF 正文/u);

  const scanned = asFile(new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nstream\nBT ET\nendstream\n%%EOF"), "扫描件.pdf", "application/pdf");
  await assert.rejects(() => parseArticleImport(scanned), (error) => {
    assert.ok(error instanceof DocumentImportError);
    assert.match(error.message, /扫描件需要先完成 OCR/u);
    return true;
  });
});

test("旧版 .doc 的 RTF 兼容文本和真实二进制签名均经过格式门禁", async () => {
  const rtf = new TextEncoder().encode("{\\rtf1\\ansi 标题\\par 正文内容}");
  const preview = await parseArticleImport(asFile(rtf, "旧文章.doc", "application/msword"));
  assert.equal(preview.format, "doc");
  assert.match(preview.text, /标题\n正文内容/u);

  const notDoc = asFile(new TextEncoder().encode("plain text"), "伪装.doc", "application/msword");
  await assert.rejects(() => parseArticleImport(notDoc), /文件内容与 DOC 扩展名不一致/u);

  const binary = await parseArticleImport(asFile(binaryDocFixture(), "二进制文章.doc", "application/msword"));
  assert.match(binary.text, /Binary Word text/u);
});

test("不支持格式、空正文和超限文件不会进入导入流程", async () => {
  await assert.rejects(() => parseArticleImport(asFile(new Uint8Array([1]), "notes.txt", "text/plain")), /不支持该文件格式/u);
  await assert.rejects(() => parseArticleImport(asFile(new TextEncoder().encode("%PDF-1.4"), "empty.pdf", "application/pdf")), /可复制文本/u);
  await assert.rejects(() => parseArticleImport(new File([new Uint8Array(ARTICLE_IMPORT_MAX_BYTES + 1)], "large.pdf", { type: "application/pdf" })), /超过 30 MB/u);
});
