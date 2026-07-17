import type { Metadata } from "next";
import { Geist, Noto_Sans_SC } from "next/font/google";
import "./globals.css";

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

const notoSansSc = Noto_Sans_SC({
  variable: "--font-noto-sc",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "吟领教务 | Learning Operations",
  description: "Internal education operations demo for scheduling, Learning Plans, reminders and data coordination.",
  openGraph: {
    title: "吟领教务 | Learning Operations",
    description: "A calm, connected operations workspace for education teams.",
    images: [{ url: "/og.png", width: 1600, height: 900, alt: "吟领教务 Learning Operations" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "吟领教务 | Learning Operations",
    description: "A calm, connected operations workspace for education teams.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={`${geist.variable} ${notoSansSc.variable}`}>{children}</body>
    </html>
  );
}
