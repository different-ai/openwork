import type { Metadata } from "next";

import ShareHomeClient from "../components/share-home-client";
import ShareNav from "../components/share-nav";
import { getGithubStars } from "../server/_lib/github-stars.ts";
import {
  DEFAULT_OG_IMAGE_VARIANT,
  DEFAULT_TWITTER_IMAGE_VARIANT,
  OG_IMAGE_VARIANTS,
} from "../server/_lib/og-image-variants.ts";
import { DEFAULT_PUBLIC_BASE_URL, buildOgImageUrlFromOrigin } from "../server/_lib/share-utils.ts";

export const revalidate = 3600;

const rootOgImageUrl = buildOgImageUrlFromOrigin(DEFAULT_PUBLIC_BASE_URL, "root", DEFAULT_OG_IMAGE_VARIANT);
const rootTwitterImageUrl = buildOgImageUrlFromOrigin(DEFAULT_PUBLIC_BASE_URL, "root", DEFAULT_TWITTER_IMAGE_VARIANT);
const rootOpenGraphVariants = ["facebook", "linkedin", "slack", "whatsapp"] as const;
const rootOpenGraphImages = rootOpenGraphVariants.map((variant) => ({
  url: buildOgImageUrlFromOrigin(DEFAULT_PUBLIC_BASE_URL, "root", variant),
  width: OG_IMAGE_VARIANTS[variant].width,
  height: OG_IMAGE_VARIANTS[variant].height,
  alt: "OpenWork Share landing page preview",
}));

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
    images: rootOpenGraphImages,
  },
  twitter: {
    card: "summary_large_image",
    title: "Share Your Skill",
    description: "Upload, edit, and publish a single OpenWork skill for sharing.",
    images: [
      {
        url: rootTwitterImageUrl,
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
