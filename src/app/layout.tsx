import type { Metadata } from "next";
import { IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/ui";
import { LOOK_BOOT } from "@/lib/theme";

const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-plex-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-jb-mono" });

export const metadata: Metadata = { title: "Arkus — the control room for your software", description: "See, understand and safely change your whole system — code, APIs, database — in one visual workspace." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: LOOK_BOOT }} /></head>
      <body className="h-screen overflow-hidden"><ToastProvider>{children}</ToastProvider></body>
    </html>
  );
}
