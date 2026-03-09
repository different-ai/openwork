import { headers } from "next/headers";

import ShareBundlePage from "../../../components/share-bundle-page";
import { getBundlePageProps } from "../../../server/b/get-bundle-page-props.js";
import { buildRequestLike } from "../../../server/_lib/request-like.js";

async function loadBundlePageProps(id) {
  const requestHeaders = await headers();
  return getBundlePageProps({
    id,
    requestLike: buildRequestLike({ headers: requestHeaders })
  });
}

export async function generateMetadata({ params }) {
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
      title: pageTitle,
      description: pageDescription,
      url: props.canonicalUrl,
      images: [props.ogImageUrl]
    },
    twitter: {
      card: "summary_large_image",
      title: pageTitle,
      description: pageDescription,
      images: [props.ogImageUrl]
    },
    other: props.missing
      ? undefined
      : {
          "openwork:bundle-id": props.id,
          "openwork:bundle-type": props.bundleType,
          "openwork:schema-version": props.schemaVersion,
          "openwork:open-in-app-url": props.openInAppDeepLink
        }
  };
}

export default async function BundlePage({ params }) {
  const routeParams = await params;
  const props = await loadBundlePageProps(routeParams?.id);
  return <ShareBundlePage {...props} />;
}
