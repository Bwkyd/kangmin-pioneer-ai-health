/**
 * 媒体/知识文件的类型与大小校验（双校验：扩展名 + 内容魔数嗅探）。
 *
 * 素材与知识两条链路共用，本地直写与远程直传（init/confirm）一致执行：
 * - init/本地上传：扩展名白名单 + 大小上限（fail-closed）；
 * - confirm/本地落库前：读取真实字节做魔数嗅探，扩展名声明的类型与
 *   内容不符即拒绝（类型伪装防线）。
 */
import { DomainError } from "../../kernel/errors.js";

export type MediaKind = "image" | "video" | "word" | "pdf" | "markdown";

/** 扩展名 → 素材类型（与既有 MEDIA_EXTENSIONS 白名单一致）。 */
export const MEDIA_EXTENSIONS: Record<string, MediaKind> = {
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".webp": "image",
  ".gif": "image",
  ".mp4": "video",
  ".webm": "video",
  ".docx": "word",
  ".doc": "word",
  ".pdf": "pdf",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "markdown"
};

export const MEDIA_MIME: Record<MediaKind, string> = {
  image: "image/*",
  video: "video/*",
  word: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  markdown: "text/markdown"
};

/** 知识源文件允许的扩展名（与既有 KNOWLEDGE_EXTENSIONS 一致）。 */
export const KNOWLEDGE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".pdf",
  ".docx"
]);

/** 默认大小上限（可用 KANGMIN_MEDIA_MAX_BYTES / KANGMIN_KNOWLEDGE_MAX_BYTES 覆盖）。 */
export const DEFAULT_MEDIA_MAX_BYTES = 200 * 1024 * 1024;
export const DEFAULT_KNOWLEDGE_MAX_BYTES = 50 * 1024 * 1024;

export function extensionOf(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index === -1 ? "" : filename.slice(index).toLowerCase();
}

export interface MediaTypeDecision {
  kind: MediaKind;
  mimeType: string;
}

/**
 * 扩展名解析素材类型；requestedKind 为显式 --kind 覆盖。
 * 不在白名单即 validation_failed（fail-closed）。
 */
export function resolveMediaType(
  filename: string,
  requestedKind?: string | undefined
): MediaTypeDecision {
  const extension = extensionOf(filename);
  const kind = (requestedKind ?? MEDIA_EXTENSIONS[extension]) as
    | MediaKind
    | undefined;
  if (kind === undefined || MEDIA_MIME[kind] === undefined) {
    throw new DomainError(
      "validation_failed",
      `不支持的素材类型：${filename}（支持图片/视频/Word/PDF/Markdown）`
    );
  }
  return { kind, mimeType: MEDIA_MIME[kind] };
}

/** 知识源文件扩展名校验。 */
export function assertKnowledgeExtension(filename: string): void {
  if (!KNOWLEDGE_EXTENSIONS.has(extensionOf(filename))) {
    throw new DomainError(
      "validation_failed",
      `不支持的知识文件类型：${filename}（支持 .md/.markdown/.txt/.pdf/.docx）`
    );
  }
}

/** 大小上限 fail-closed。 */
export function assertSizeWithinLimit(
  sizeBytes: number,
  maxBytes: number,
  label: string
): void {
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > maxBytes) {
    throw new DomainError(
      "validation_failed",
      `${label}大小超出限制（上限 ${Math.floor(maxBytes / 1024 / 1024)}MB）`
    );
  }
}

/**
 * 内容魔数嗅探：返回与文件头匹配的类型；无法识别返回 null。
 * 文本类（markdown/txt）没有魔数，由调用方按扩展名兜底。
 */
export function sniffMediaKind(head: Buffer): MediaKind | null {
  if (head.length >= 8) {
    // PNG
    if (
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    ) {
      return "image";
    }
    // GIF87a / GIF89a
    if (
      head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 &&
      head[3] === 0x38
    ) {
      return "image";
    }
    // RIFF WEBP
    if (
      head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
    ) {
      return "image";
    }
    // %PDF-
    if (
      head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 &&
      head[3] === 0x46 && head[4] === 0x2d
    ) {
      return "pdf";
    }
    // PK zip（docx 等 OOXML）
    if (head[0] === 0x50 && head[1] === 0x4b) {
      return "word";
    }
    // OLE2 复合文档（旧版 .doc）
    if (
      head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0
    ) {
      return "word";
    }
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    // JPEG
    return "image";
  }
  if (
    head.length >= 12 &&
    head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
  ) {
    // ISO BMFF（mp4 等）：ftyp 盒
    return "video";
  }
  if (
    head.length >= 4 &&
    head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3
  ) {
    // EBML（webm）
    return "video";
  }
  return null;
}

/**
 * 类型伪装双校验：声明类型（扩展名/--kind）与内容魔数必须一致；
 * 可嗅探类型与声明不符即拒绝。文本类无魔数，只要求内容不是其他
 * 已知二进制类型（例如把 exe/mp4 改名 .md 会被拦截）。
 */
export function assertContentMatchesDeclared(
  declared: MediaKind,
  head: Buffer
): void {
  const sniffed = sniffMediaKind(head);
  if (sniffed === null) {
    // 无法识别的内容：文本类型允许（无魔数），二进制类型拒绝。
    if (declared !== "markdown") {
      throw new DomainError(
        "validation_failed",
        "文件内容与声明的类型不符（无法识别的文件头）"
      );
    }
    return;
  }
  const compatible =
    sniffed === declared ||
    // 图片/视频内部格式差异视为同类（如 png vs jpeg、mp4 vs webm）。
    (sniffed === "image" && declared === "image") ||
    (sniffed === "video" && declared === "video");
  if (!compatible) {
    throw new DomainError(
      "validation_failed",
      "文件内容与声明的类型不符（类型伪装）"
    );
  }
}
