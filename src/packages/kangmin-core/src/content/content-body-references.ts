/**
 * 内容正文中的媒体引用。
 *
 * 管理端正文使用受控 Markdown 语法保存图片/附件链接，例如：
 * `![鼻部示意图](/v1/media/med_0123456789ab)`。
 * 只识别服务端生成的 media id，避免把任意 URL 当成可公开的媒体依赖。
 */
const MEDIA_REFERENCE_PATTERN = /\/v1\/media\/(med_[0-9a-f]{12})/gu;

export function mediaIdsInContentBody(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(MEDIA_REFERENCE_PATTERN)) {
    const id = match[1];
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}
