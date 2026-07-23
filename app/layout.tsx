import type { Metadata } from "next";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "抗敏先锋 · AI 鼻健康管理",
    description: "固定规则驱动的鼻健康内部测试工具，不替代门诊诊断。",
    openGraph: {
      title: "抗敏先锋 · AI 鼻健康管理",
      description: "固定规则驱动的鼻健康内部测试工具，不替代门诊诊断。",
    },
    twitter: {
      card: "summary_large_image",
      title: "抗敏先锋 · AI 鼻健康管理",
      description: "固定规则驱动的鼻健康内部测试工具，不替代门诊诊断。",
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
