import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./workspace-design.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f5f5f7" }, { media: "(prefers-color-scheme: dark)", color: "#111315" }],
  colorScheme: "light dark",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://yinling-education-ops.vercel.app"),
  title: "吟领教务",
  description: "Internal education operations demo for scheduling, Learning Plans, reminders and data coordination.",
  openGraph: {
    title: "吟领教务",
    description: "A calm, connected operations workspace for education teams.",
  },
  twitter: {
    card: "summary_large_image",
    title: "吟领教务",
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
