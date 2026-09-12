import type { Metadata } from "next";
import "./globals.css";
import "./dashboard.css";
import "./readability.css";
export const metadata: Metadata = { title: "AI 产业链宏观观察台", description: "观察利率、就业、能源与融资环境，理解宏观变化如何传导至 AI 产业链。", icons: { icon: "/favicon.svg" } };
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="zh-CN"><body>{children}</body></html>}
