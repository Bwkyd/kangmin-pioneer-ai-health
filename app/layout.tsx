import type { Metadata } from "next";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "抗敏先锋 · AI 鼻健康管理",
    description: "知识库问答、科普推送、症状量表与趋势跟踪的一体化鼻健康管理工具。",
    openGraph: {
      title: "抗敏先锋 · AI 鼻健康管理",
      description: "知识库问答、科普推送、症状量表与趋势跟踪。",
    },
    twitter: {
      card: "summary_large_image",
      title: "抗敏先锋 · AI 鼻健康管理",
      description: "知识库问答、科普推送、症状量表与趋势跟踪。",
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
