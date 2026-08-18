import type { ReactNode } from "react";

const MEDIA_PATH_PATTERN = /^\/v1\/media\/(med_[0-9a-f]{12})$/u;
const ADMIN_MEDIA_PATH_PATTERN = /^\/v1\/admin\/media\/(med_[0-9a-f]{12})$/u;

function safeLink(raw: string, media = false): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("//")) return null;
  try {
    const parsed = new URL(trimmed, window.location.origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (media && !MEDIA_PATH_PATTERN.test(parsed.pathname) && !ADMIN_MEDIA_PATH_PATTERN.test(parsed.pathname)) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function mediaHref(raw: string, mediaPathPrefix: string): string | null {
  const trimmed = raw.trim();
  const match = MEDIA_PATH_PATTERN.exec(trimmed);
  if (match === null || match[1] === undefined) return null;
  return `${mediaPathPrefix}/${match[1]}`;
}

function inlineNodes(text: string, keyPrefix: string, mediaPathPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(!?)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
  let cursor = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const whole = match[0];
    const imageMarker = match[1] === "!";
    const label = match[2] ?? "链接";
    const rawHref = match[3] ?? "";
    if (start > cursor) nodes.push(text.slice(cursor, start));
    if (imageMarker) {
      const href = mediaHref(rawHref, mediaPathPrefix);
      if (href !== null && safeLink(href, true) !== null) {
        nodes.push(<img key={`${keyPrefix}-image-${index}`} src={href} alt={label} loading="lazy" />);
      } else {
        nodes.push(label);
      }
    } else {
      const href = safeLink(rawHref);
      if (href !== null) {
        nodes.push(<a key={`${keyPrefix}-link-${index}`} href={href} target="_blank" rel="noreferrer">{label}</a>);
      } else {
        nodes.push(label);
      }
    }
    cursor = start + whole.length;
    index += 1;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function isBlockStart(line: string): boolean {
  return /^(#{1,3})\s+|^>\s+|^[-*]\s+|^\d+\.\s+/u.test(line);
}

/**
 * 受控 Markdown：只支持标题、段落、列表、引用、同源媒体图片和安全链接。
 * 不解析 HTML，避免科普正文把脚本或任意标签带到患者端。
 */
export function ContentBody({
  body,
  mediaPathPrefix = "/v1/media"
}: {
  body: string | null | undefined;
  mediaPathPrefix?: string;
}) {
  const lines = (body ?? "").replaceAll("\r\n", "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ").trim();
    if (text !== "") {
      blocks.push(<p key={`paragraph-${index}`}>{inlineNodes(text, `paragraph-${index}`, mediaPathPrefix)}</p>);
      index += 1;
    }
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index]?.trimEnd() ?? "";
    if (line.trim() === "") {
      flushParagraph();
      index += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading !== null) {
      flushParagraph();
      const level = heading[1]?.length ?? 1;
      const content = heading[2] ?? "";
      if (level === 1) blocks.push(<h3 key={`heading-${index}`}>{inlineNodes(content, `heading-${index}`, mediaPathPrefix)}</h3>);
      else if (level === 2) blocks.push(<h4 key={`heading-${index}`}>{inlineNodes(content, `heading-${index}`, mediaPathPrefix)}</h4>);
      else blocks.push(<h5 key={`heading-${index}`}>{inlineNodes(content, `heading-${index}`, mediaPathPrefix)}</h5>);
      index += 1;
      continue;
    }
    const quote = /^>\s+(.+)$/u.exec(line);
    if (quote !== null) {
      flushParagraph();
      blocks.push(<blockquote key={`quote-${index}`}>{inlineNodes(quote[1] ?? "", `quote-${index}`, mediaPathPrefix)}</blockquote>);
      index += 1;
      continue;
    }
    const unordered = /^[-*]\s+(.+)$/u.exec(line);
    if (unordered !== null) {
      flushParagraph();
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = /^[-*]\s+(.+)$/u.exec(lines[index]?.trimEnd() ?? "");
        if (item === null) break;
        items.push(<li key={`unordered-${index}`}>{inlineNodes(item[1] ?? "", `unordered-${index}`, mediaPathPrefix)}</li>);
        index += 1;
      }
      blocks.push(<ul key={`unordered-list-${index}`}>{items}</ul>);
      continue;
    }
    const ordered = /^\d+\.\s+(.+)$/u.exec(line);
    if (ordered !== null) {
      flushParagraph();
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = /^\d+\.\s+(.+)$/u.exec(lines[index]?.trimEnd() ?? "");
        if (item === null) break;
        items.push(<li key={`ordered-${index}`}>{inlineNodes(item[1] ?? "", `ordered-${index}`, mediaPathPrefix)}</li>);
        index += 1;
      }
      blocks.push(<ol key={`ordered-list-${index}`}>{items}</ol>);
      continue;
    }
    if (isBlockStart(line)) {
      flushParagraph();
    }
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();

  return <div className="content-body">{blocks.length > 0 ? blocks : <p className="content-body-empty">暂无正文</p>}</div>;
}
