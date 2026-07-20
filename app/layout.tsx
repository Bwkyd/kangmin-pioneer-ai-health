import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const imageUrl = `${protocol}://${host}/og.png`;

  return {
    title: "抗敏先锋 · AI 鼻健康管理",
    description: "知识库问答、科普推送、症状量表与趋势跟踪的一体化鼻健康管理工具。",
    openGraph: {
      title: "抗敏先锋 · AI 鼻健康管理",
      description: "知识库问答、科普推送、症状量表与趋势跟踪。",
      images: [{ url: imageUrl, width: 1680, height: 945, alt: "抗敏先锋 AI 鼻健康管理演示" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "抗敏先锋 · AI 鼻健康管理",
      description: "知识库问答、科普推送、症状量表与趋势跟踪。",
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
