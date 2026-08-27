import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#123f3b",
  colorScheme: "light",
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
