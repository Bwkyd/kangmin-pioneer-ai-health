import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";

import { extractArticleDocument } from "../modules/admin/article-document-import.js";

async function docxWithParagraphs(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const content = paragraphs.map((value) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${content}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

function textPdf(lines: string[]): Buffer {
  const escaped = lines.map((line) => line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"));
  const stream = `BT /F1 16 Tf 72 740 Td (${escaped[0] ?? ""}) Tj /F1 12 Tf 0 -28 Td (${escaped[1] ?? ""}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "ascii");
}

test("Word 文章导入提取首段标题并保留正文", async () => {
  const draft = await extractArticleDocument(
    "客户文章.docx",
    await docxWithParagraphs(["换季鼻敏感护理", "第一段正文。", "第二段正文。"])
  );
  assert.equal(draft.title, "换季鼻敏感护理");
  assert.equal(draft.body, "第一段正文。\n\n第二段正文。");
  assert.equal(draft.source, "客户文章.docx");
  assert.deepEqual(draft.images, []);
});

test("可提取文字的 PDF 生成可编辑正文", async () => {
  const draft = await extractArticleDocument(
    "allergy.pdf",
    textPdf(["Allergy Article", "Editable body text."])
  );
  assert.equal(draft.title, "Allergy Article");
  assert.match(draft.body, /Editable body text/u);
  assert.deepEqual(draft.images, []);
});

test("无可提取文字的 PDF 仍按页生成可见草稿", async () => {
  const draft = await extractArticleDocument("empty.pdf", textPdf(["", ""]));
  assert.equal(draft.title, "empty");
  assert.equal(draft.images.length, 1);
  assert.match(draft.body, /KANGMIN_ARTICLE_IMAGE_PAGE_1/u);
});
