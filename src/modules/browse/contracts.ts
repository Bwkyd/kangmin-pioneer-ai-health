export type PublicContentKind = "article" | "video";

export interface PublicContent {
  id: string;
  kind: PublicContentKind;
  title: string;
  category: string;
  summary: string;
  body: string | null;
  source: string;
  coverUrl: string | null;
  mediaUrl: string | null;
  publishedAt: string;
  updatedAt: string;
  disclaimer: string;
}

export interface BrowseHome {
  articles: PublicContent[];
  videos: PublicContent[];
  recentlyUpdated: PublicContent[];
  categories: {
    articles: string[];
    videos: string[];
  };
}
