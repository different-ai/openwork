import type { Metadata } from "next";
import { headers } from "next/headers";

import ShareBundlePage from "../../../components/share-bundle-page";
import { getBundlePageProps } from "../../../server/b/get-bundle-page-props.ts";
import { buildRequestLike } from "../../../server/_lib/request-like.ts";

async function loadBundlePageProps(id: string) {
  const requestHeaders = await headers();
  return getBundlePageProps({
    id,
    requestLike: buildRequestLike({ headers: requestHeaders })
  });
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const routeParams = await params;
  const props = await loadBundlePageProps(routeParams?.id);
  const pageTitle = props.missing ? "Bundle not found" : props.title;
  const pageDescription = props.missing
    ? "This share link does not exist anymore, or the bundle id is invalid."
    : props.description;

  return {
    title: pageTitle,
    description: pageDescription,
    alternates: {
      canonical: props.canonicalUrl
    },
    openGraph: {
      type: "website",
      siteName: "OpenWork Share",
      title: pageTitle,
      description: pageDescription,
      url: props.canonicalUrl,
      images: [
        {
          url: props.ogImageUrl,
          width: 1200,
          height: 630,
          alt: `${pageTitle} bundle preview`
        }
      ]
    },
    twitter: {
      card: "summary_large_image",
      title: pageTitle,
      description: pageDescription,
      images: [
        {
          url: props.ogImageUrl,
          alt: `${pageTitle} bundle preview`
        }
      ]
    },
    other: props.missing
      ? undefined
      : {
          "openwork:bundle-id": props.id!,
          "openwork:bundle-type": props.bundleType!,
          "openwork:schema-version": props.schemaVersion!,
          "openwork:open-in-app-url": props.openInAppDeepLink!
        }
  };
}

export default async function BundlePage({ params }: { params: Promise<{ id: string }> }) {
  const routeParams = await params;
  const props = await loadBundlePageProps(routeParams?.id);
  return <ShareBundlePage {...props} />;
}
