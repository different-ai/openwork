import "../styles/globals.css";

import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import { DEFAULT_PUBLIC_BASE_URL } from "../server/_lib/share-utils.ts";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter"
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono"
});

export const metadata: Metadata = {
  metadataBase: new URL(DEFAULT_PUBLIC_BASE_URL),
  title: {
    default: "OpenWork Share",
    template: "%s - OpenWork Share"
  },
  description: "Publish OpenWork worker packages and shareable import links."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
