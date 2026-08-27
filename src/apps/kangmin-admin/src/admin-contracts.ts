export type ContentKind = "article" | "video";

export interface ContentItem {
  id: string;
  kind: ContentKind;
  title: string;
  category: string;
  categoryIds: string[];
  summary: string;
  body: string;
  source: string;
  status: "draft" | "published" | "unpublished";
  revision: number;
  coverMediaId: string | null;
  mediaId: string | null;
  instructions: string;
  precautions: string;
  disclaimer: string;
  displayOrder: number;
  updatedAt: string;
}

export interface ContentPreview extends ContentItem {
  validation: { ok: boolean; missing: string[] };
  patientVisible: boolean;
}

export interface MediaReference {
  entityType: "article" | "video" | "knowledge";
  entityId: string;
  name: string;
  status: string;
  role: "file" | "cover" | "body" | "knowledge_source";
}

export interface MediaItem {
  id: string;
  filename: string;
  kind: string;
  sizeBytes: number;
  status: string;
  failureReason?: string | null;
  references?: MediaReference[];
}

export interface KnowledgeItem {
  id: string;
  name: string;
  folderId: string | null;
  category?: string | null;
  source: string | null;
  description: string | null;
  status: "processing" | "indexed" | "enabled" | "disabled" | "index_failed";
  chunkCount: number;
  parseError: string | null;
  updatedAt: string;
}

export interface KnowledgeFolder {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  depth: 1 | 2 | 3;
  knowledgeCount: number;
  childCount: number;
}

export interface MessageItem {
  id: string;
  title: string;
  body: string;
  summary: string | null;
  status: "draft" | "published" | "unpublished";
  revision: number;
  publishedAt: string | null;
  updatedAt: string;
}

export interface CategoryRegistryItem {
  id: string;
  name: string;
  kind: ContentKind;
  parentId: string | null;
  audience: "adult" | "child" | "all";
  nodeType: "audience" | "group" | "leaf";
  status: "active" | "disabled";
  selectable: boolean;
  displayOrder: number;
}

export interface KnowledgeHit {
  knowledgeId: string;
  name: string;
  snippet: string;
}
