import "../styles/globals.css";

import type { Metadata } from "next";

import { DEFAULT_PUBLIC_BASE_URL } from "../server/_lib/share-utils.ts";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
