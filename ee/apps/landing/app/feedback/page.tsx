import { AppFeedbackForm, type AppFeedbackPrefill } from "../../components/app-feedback-form";
import { baseOpenGraph } from "../../lib/seo";

export const metadata = {
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
};

type PageProps = {
  searchParams?: Record<string, string | string[] | undefined>;
};

function readSearchParam(
  searchParams: PageProps["searchParams"],
  key: string,
): string {
  const raw = searchParams?.[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.trim().slice(0, 240) : "";
}

export default function FeedbackPage({ searchParams }: PageProps) {
  const prefill: AppFeedbackPrefill = {
    source: readSearchParam(searchParams, "source") || "openwork-app",
    entrypoint: readSearchParam(searchParams, "entrypoint") || "unknown",
    deployment: readSearchParam(searchParams, "deployment") || "desktop",
    appVersion: readSearchParam(searchParams, "appVersion"),
    openworkServerVersion: readSearchParam(searchParams, "openworkServerVersion"),
    opencodeVersion: readSearchParam(searchParams, "opencodeVersion"),
    orchestratorVersion: readSearchParam(searchParams, "orchestratorVersion"),
    opencodeRouterVersion: readSearchParam(searchParams, "opencodeRouterVersion"),
    osName: readSearchParam(searchParams, "osName"),
    osVersion: readSearchParam(searchParams, "osVersion"),
    platform: readSearchParam(searchParams, "platform"),
  };

  return (
    <div className="feedback-page min-h-screen pt-(--page-pt)">
      <div className="mx-auto max-w-5xl px-6 pb-20 md:px-8">
        <AppFeedbackForm prefill={prefill} />
      </div>
    </div>
  );
}
