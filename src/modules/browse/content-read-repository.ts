import type { PublicContent, PublicContentKind } from "./contracts.js";

export interface ContentReadRepository {
  list(kind: PublicContentKind): Promise<PublicContent[]>;
  find(kind: PublicContentKind, id: string): Promise<PublicContent | null>;
  search(kind: PublicContentKind, query: string): Promise<PublicContent[]>;
  categories(kind: PublicContentKind): Promise<string[]>;
}
