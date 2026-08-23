import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import TurndownService from "turndown";

import { DomainError } from "../../kernel/errors.js";

const MAX_EXTRACTED_CHARACTERS = 2_000_000;
const MAX_IMPORTED_IMAGES = 20;
const MAX_IMPORTED_IMAGE_BYTES = 12 * 1024 * 1024;
const PDFJS_DIRECTORY = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));

export interface ArticleDocumentImage {
  token: string;
  filename: string;
  mimeType: string;
  dataBase64: string;
}

export interface ArticleDocumentDraft {
  title: string;
  body: string;
  source: string;
  images: ArticleDocumentImage[];
}

function cleanExtractedText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/^-- \d+ of \d+ --$/gmu, "")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function splitTitleAndBody(filename: string, text: string): { title: string; body: string } {
  const lines = text.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim() !== "");
  const firstLine = firstIndex === -1 ? "" : lines[firstIndex]!.trim();
  const remainder = firstIndex === -1 ? "" : lines.slice(firstIndex + 1).join("\n").trim();
  if (firstLine !== "" && firstLine.length <= 80 && remainder !== "") {
    const title = firstLine
      .replace(/^#{1,6}\s+/u, "")
      .replace(/^\*\*(.+)\*\*$/u, "$1")
      .replace(/^__(.+)__$/u, "$1")
      .trim();
    return { title, body: remainder };
  }
  return { title: filename.replace(/\.(?:docx|pdf)$/iu, ""), body: text };
}

function imageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  throw new DomainError("validation_failed", `Word 中包含暂不支持的图片格式：${mimeType}`);
}

function assertImportedImages(images: ArticleDocumentImage[]): void {
  if (images.length > MAX_IMPORTED_IMAGES) {
    throw new DomainError("validation_failed", `文档图片超过 ${MAX_IMPORTED_IMAGES} 张，请拆分后上传`);
  }
  const totalBytes = images.reduce((sum, image) => sum + Buffer.byteLength(image.dataBase64, "base64"), 0);
  if (totalBytes > MAX_IMPORTED_IMAGE_BYTES) {
    throw new DomainError("validation_failed", "文档图片总量过大，请压缩图片后重试");
  }
}

async function extractWord(filename: string, buffer: Buffer): Promise<ArticleDocumentDraft> {
  const images: ArticleDocumentImage[] = [];
  const converted = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const index = images.length + 1;
        if (index > MAX_IMPORTED_IMAGES) {
          throw new DomainError("validation_failed", `文档图片超过 ${MAX_IMPORTED_IMAGES} 张，请拆分后上传`);
        }
        const mimeType = image.contentType.toLowerCase();
        const extension = imageExtension(mimeType);
        const token = `KANGMIN_ARTICLE_IMAGE_${index}`;
        images.push({
          token,
          filename: `${filename.replace(/\.docx$/iu, "")}-图片${index}.${extension}`,
          mimeType,
          dataBase64: (await image.readAsBuffer()).toString("base64")
        });
        return { src: token };
      })
    }
  );
  assertImportedImages(images);
  let markdown = cleanExtractedText(new TurndownService({ headingStyle: "atx", bulletListMarker: "-" }).turndown(converted.value));
  for (const [index, image] of images.entries()) {
    markdown = markdown.replaceAll(`![](${image.token})`, `![文档图片${index + 1}](${image.token})`);
  }
  if (markdown === "") {
    throw new DomainError("validation_failed", "没有提取到可编辑文字");
  }
  if (markdown.length > MAX_EXTRACTED_CHARACTERS) {
    throw new DomainError("validation_failed", "文档正文过长，请拆分后再上传");
  }
  return { ...splitTitleAndBody(filename, markdown), source: filename, images };
}

async function extractPdf(filename: string, buffer: Buffer): Promise<ArticleDocumentDraft> {
  const parser = new PDFParse({
    data: buffer,
    cMapUrl: `${join(PDFJS_DIRECTORY, "cmaps")}/`,
    cMapPacked: true,
    standardFontDataUrl: `${join(PDFJS_DIRECTORY, "standard_fonts")}/`,
    wasmUrl: `${join(PDFJS_DIRECTORY, "wasm")}/`,
    useSystemFonts: true
  });
  try {
    const info = await parser.getInfo();
    if (info.total > MAX_IMPORTED_IMAGES) {
      throw new DomainError("validation_failed", `PDF 超过 ${MAX_IMPORTED_IMAGES} 页，请拆分后上传`);
    }
    const text = cleanExtractedText((await parser.getText()).text);
    let images: ArticleDocumentImage[] = [];
    if (text !== "") {
      const extracted = await parser.getImage({ imageBuffer: true, imageDataUrl: false, imageThreshold: 80 });
      images = extracted.pages.flatMap((page) => page.images.map((image, imageIndex) => {
        return {
          token: `KANGMIN_ARTICLE_IMAGE_${page.pageNumber}_${imageIndex + 1}`,
          filename: `${filename.replace(/\.pdf$/iu, "")}-第${page.pageNumber}页图片${imageIndex + 1}.png`,
          mimeType: "image/png",
          dataBase64: Buffer.from(image.data).toString("base64")
        };
      }));
    } else {
      const screenshots = await parser.getScreenshot({
        desiredWidth: 1200,
        imageBuffer: true,
        imageDataUrl: false
      });
      images = screenshots.pages.map((page) => ({
        token: `KANGMIN_ARTICLE_IMAGE_PAGE_${page.pageNumber}`,
        filename: `${filename.replace(/\.pdf$/iu, "")}-第${page.pageNumber}页.png`,
        mimeType: "image/png",
        dataBase64: Buffer.from(page.data).toString("base64")
      }));
    }
    assertImportedImages(images);
    const imageBody = images.map((image, index) => `![PDF 图片${index + 1}](${image.token})`).join("\n\n");
    if (text === "" && imageBody === "") throw new DomainError("validation_failed", "PDF 没有可导入内容");
    const split = text === "" ? null : splitTitleAndBody(filename, text);
    return {
      title: split?.title ?? filename.replace(/\.pdf$/iu, ""),
      body: [split?.body ?? "", imageBody].filter(Boolean).join("\n\n"),
      source: filename,
      images
    };
  } finally {
    await parser.destroy();
  }
}

export async function extractArticleDocument(
  filename: string,
  buffer: Buffer
): Promise<ArticleDocumentDraft> {
  const extension = extname(filename).toLowerCase();
  try {
    if (extension === ".docx") {
      return await extractWord(filename, buffer);
    } else if (extension === ".pdf") {
      return await extractPdf(filename, buffer);
    } else if (extension === ".doc") {
      throw new DomainError(
        "validation_failed",
        "暂不支持旧版 .doc，请在 Word 中另存为 .docx 后上传"
      );
    } else {
      throw new DomainError(
        "validation_failed",
        "文章导入仅支持 .docx 和 .pdf 文件"
      );
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "validation_failed",
      "文档解析失败，请确认文件未损坏、未加密后重试",
      { cause: error }
    );
  }
}
