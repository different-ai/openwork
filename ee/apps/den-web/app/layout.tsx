import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import { headers } from "next/headers";
import { readPublicWebOrigin } from "./_lib/public-web-origin";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap"
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
  weight: ["400", "500"]
});

function metadataBaseFromOrigin(origin: string) {
  try {
    return new URL(origin);
  } catch {
    return new URL("http://localhost:3005");
  }
}

function firstHeaderValue(value: string | null) {
  return value?.split(",")[0]?.trim() || "";
}

function forwardedProtocol(value: string | null) {
  const protocol = firstHeaderValue(value).toLowerCase();
  return protocol === "http" || protocol === "https" ? protocol : "https";
}

export async function generateMetadata(): Promise<Metadata> {
  const configuredOrigin = readPublicWebOrigin();
  const requestHeaders = await headers();
  const host = firstHeaderValue(requestHeaders.get("x-forwarded-host")) || firstHeaderValue(requestHeaders.get("host"));
  const protocol = forwardedProtocol(requestHeaders.get("x-forwarded-proto"));
  const metadataOrigin = configuredOrigin || (host ? `${protocol}://${host}` : "http://localhost:3005");

  return {
    metadataBase: metadataBaseFromOrigin(metadataOrigin),
    title: "OpenWork Cloud",
    description:
      "Share your OpenWork setup with your team, manage billing, and use OpenWork Cloud from app.openworklabs.com.",
    openGraph: {
      title: "OpenWork Cloud",
      description:
        "Share your OpenWork setup with your team and keep selected workflows available in OpenWork Cloud.",
      images: ["/opengraph-image"]
    },
    twitter: {
      card: "summary_large_image",
      title: "OpenWork Cloud",
      description:
        "Share your OpenWork setup with your team and manage OpenWork Cloud from app.openworklabs.com.",
      images: ["/opengraph-image"]
    },
    icons: {
      icon: "/openwork-mark.svg"
    }
  };
}

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${ibmPlexMono.variable}`}>
      <head />
      <body>{children}</body>
    </html>
  );
}
