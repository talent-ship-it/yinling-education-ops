import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "吟领教务 | Learning Operations",
  description: "Internal education operations demo for scheduling, Learning Plans, reminders and data coordination.",
  openGraph: {
    title: "吟领教务 | Learning Operations",
    description: "A calm, connected operations workspace for education teams.",
  },
  twitter: {
    card: "summary_large_image",
    title: "吟领教务 | Learning Operations",
    description: "A calm, connected operations workspace for education teams.",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
