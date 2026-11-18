import { AppFeedbackForm, type AppFeedbackPrefill } from "../../components/app-feedback-form";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";
import { baseOpenGraph, withSocialMetadata } from "../../lib/seo";

export const metadata = withSocialMetadata({
  title: "OpenWork — Feedback",
  description: "Send app feedback to the OpenWork team with prefilled runtime context.",
  alternates: {
    canonical: "/feedback"
  },
  robots: {
    index: false,
    follow: true
  },
  openGraph: {
    ...baseOpenGraph,
    url: "https://openworklabs.com/feedback"
  }
});

type SearchParams = Record<string, string | string[] | undefined>;

type PageProps = {
  searchParams?: Promise<SearchParams>;
};

function readSearchParam(
  searchParams: SearchParams | undefined,
  key: string,
): string {
  const raw = searchParams?.[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.trim().slice(0, 240) : "";
}

export default async function FeedbackPage({ searchParams }: PageProps) {
  const resolvedSearchParams = await searchParams;
  const prefill: AppFeedbackPrefill = {
    source: readSearchParam(resolvedSearchParams, "source") || "openwork-app",
    entrypoint: readSearchParam(resolvedSearchParams, "entrypoint") || "unknown",
    deployment: readSearchParam(resolvedSearchParams, "deployment"),
    appVersion: readSearchParam(resolvedSearchParams, "appVersion"),
    openworkServerVersion: readSearchParam(resolvedSearchParams, "openworkServerVersion"),
    opencodeVersion: readSearchParam(resolvedSearchParams, "opencodeVersion"),
    osName: readSearchParam(resolvedSearchParams, "osName"),
    osVersion: readSearchParam(resolvedSearchParams, "osVersion"),
    platform: readSearchParam(resolvedSearchParams, "platform"),
  };
  const github = await getGithubData();

  return (
    <div className="min-h-screen overflow-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <SiteNav stars={github.stars} />
      <main className="mx-auto w-full max-w-6xl px-6 md:px-8">
        <AppFeedbackForm prefill={prefill} />
        <SiteFooter />
      </main>
    </div>
  );
}
