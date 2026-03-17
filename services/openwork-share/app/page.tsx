import type { Metadata } from "next";

import ShareHomeClient from "../components/share-home-client";
import ShareNav from "../components/share-nav";
import { getGithubStars } from "../server/_lib/github-stars.ts";
import { DEFAULT_PUBLIC_BASE_URL } from "../server/_lib/share-utils.ts";

export const revalidate = 3600;

const rootOgImageUrl = `${DEFAULT_PUBLIC_BASE_URL}/og/root`;

export const metadata: Metadata = {
  title: "Share Your Skill",
  description: "Upload, edit, and publish a single OpenWork skill for sharing.",
  alternates: {
    canonical: DEFAULT_PUBLIC_BASE_URL
  },
  openGraph: {
    type: "website",
    siteName: "OpenWork Share",
    title: "Share Your Skill",
    description: "Upload, edit, and publish a single OpenWork skill for sharing.",
    url: DEFAULT_PUBLIC_BASE_URL,
    images: [
      {
        url: rootOgImageUrl,
        width: 1200,
        height: 630,
        alt: "OpenWork Share landing page preview"
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: "Share Your Skill",
    description: "Upload, edit, and publish a single OpenWork skill for sharing.",
    images: [
      {
        url: rootOgImageUrl,
        alt: "OpenWork Share landing page preview"
      }
    ]
  }
};

export default async function ShareHomePage() {
  const stars = await getGithubStars();

  return (
    <main className="shell">
      <ShareNav stars={stars} />
      <ShareHomeClient />
    </main>
  );
}
