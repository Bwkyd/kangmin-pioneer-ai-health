import { cleanText } from "./validation.ts";
import type { ContentType } from "./store.ts";

export type ExistingContentFields = {
  type: ContentType;
  title: string;
  category: string;
  summary: string;
  body: string;
  source: string;
  media_id: string | null;
};

/**
 * Resolve an admin update without turning an omitted field into an accidental
 * deletion. Explicit empty values still have their existing form semantics:
 * media can be detached, while title/category keep their required value.
 */
export function resolveContentUpdateFields(
  item: ExistingContentFields,
  body: Record<string, unknown>,
  metadata: Record<string, unknown>,
) {
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  return {
    title: hasOwn("title") ? cleanText(body.title, 160) || item.title : item.title,
    category: hasOwn("category") ? cleanText(body.category, 80) || item.category : item.category,
    summary: hasOwn("summary") ? cleanText(body.summary, 1000) : item.summary,
    body: hasOwn("body") ? cleanText(body.body) : item.body,
    source: hasOwn("source") ? cleanText(body.source, 1000) : item.source,
    mediaId: hasOwn("mediaId") ? cleanText(body.mediaId, 120) || null : item.media_id,
    metadata: JSON.stringify(metadata),
  };
}
