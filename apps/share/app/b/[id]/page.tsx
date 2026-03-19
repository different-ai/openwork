import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import ShareBundlePage from "../../../components/share-bundle-page";
import { getBundlePageProps } from "../../../server/b/get-bundle-page-props.ts";
import { getGithubStars } from "../../../server/_lib/github-stars.ts";
import { buildRequestLike } from "../../../server/_lib/request-like.ts";

async function loadBundlePageProps(id: string) {
  const requestHeaders = await headers();
  return getBundlePageProps({
    id,
    requestLike: buildRequestLike({ headers: requestHeaders })
  });
}

type BundlePageSearchParams = Record<string, string | string[] | undefined>;

function firstQueryValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

function wantsJsonBundleResponse(requestHeaders: Headers, searchParams: BundlePageSearchParams): boolean {
  const format = firstQueryValue(searchParams.format).trim().toLowerCase();
  if (format === "json") return true;

  const accept = String(requestHeaders.get("accept") ?? "").toLowerCase();
  return accept.includes("application/json") && !accept.includes("text/html");
}

function buildBundleDataUrl(id: string, searchParams: BundlePageSearchParams): string {
  const query = new URLSearchParams();
  const download = firstQueryValue(searchParams.download).trim();
  if (download) {
    query.set("download", download);
  }

  const suffix = query.toString();
  return `/b/${encodeURIComponent(id)}/data${suffix ? `?${suffix}` : ""}`;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const routeParams = await params;
  const props = await loadBundlePageProps(routeParams?.id);
  const pageTitle = props.missing ? "SKILL.md not found" : props.title;
  const pageDescription = props.missing
    ? "This share link does not exist anymore, or the bundle id is invalid."
    : props.description;

  return {
    title: pageTitle,
    description: pageDescription,
    alternates: {
      canonical: props.canonicalUrl
    },
    robots: props.missing
      ? {
          index: false,
          follow: false,
          googleBot: {
            index: false,
            follow: false
          }
        }
      : undefined,
    openGraph: {
      type: "website",
      siteName: "OpenWork Share",
      title: pageTitle,
      description: pageDescription,
      url: props.canonicalUrl,
      images: props.ogImageUrls
        ? [
            {
              url: props.ogImageUrls.byVariant.facebook,
              width: 1200,
              height: 630,
              alt: `${pageTitle} bundle preview`
            },
            {
              url: props.ogImageUrls.byVariant.linkedin,
              width: 1200,
              height: 627,
              alt: `${pageTitle} bundle preview`
            },
            {
              url: props.ogImageUrls.byVariant.slack,
              width: 1200,
              height: 630,
              alt: `${pageTitle} bundle preview`
            },
            {
              url: props.ogImageUrls.byVariant.whatsapp,
              width: 1200,
              height: 630,
              alt: `${pageTitle} bundle preview`
            }
          ]
        : [
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
          url: props.twitterImageUrl || props.ogImageUrl,
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

export default async function BundlePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<BundlePageSearchParams>;
}) {
  const [routeParams, resolvedSearchParams, requestHeaders] = await Promise.all([params, searchParams, headers()]);
  const id = String(routeParams?.id ?? "").trim();

  if (id && wantsJsonBundleResponse(requestHeaders, resolvedSearchParams ?? {})) {
    redirect(buildBundleDataUrl(id, resolvedSearchParams ?? {}));
  }

  const props = await getBundlePageProps({
    id,
    requestLike: buildRequestLike({ headers: requestHeaders })
  });
  const stars = await getGithubStars();
  return <ShareBundlePage {...props} stars={stars} />;
}
