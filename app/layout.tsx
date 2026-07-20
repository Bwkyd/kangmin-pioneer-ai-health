import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const imageUrl = `${protocol}://${host}/og.png`;

  return {
    title: "小岐 · 鼻炎 AI 居家调理助手",
    description: "通过自然对话了解症状，进行安全筛查，并匹配居家调理方案与操作视频。",
    openGraph: {
      title: "小岐 · 鼻炎 AI 居家调理助手",
      description: "先对话了解，再匹配调理。",
      images: [{ url: imageUrl, width: 1680, height: 945, alt: "小岐鼻炎 AI 居家调理助手" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "小岐 · 鼻炎 AI 居家调理助手",
      description: "先对话了解，再匹配调理。",
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
