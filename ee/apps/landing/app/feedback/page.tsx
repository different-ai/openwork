import Link from "next/link";
import { AppFeedbackForm, type AppFeedbackPrefill } from "../../components/app-feedback-form";
import { OpenWorkMark } from "../../components/openwork-mark";
import { SiteFooter } from "../../components/site-footer";

export const metadata = {
  title: "OpenWork - Feedback",
  description: "Send app feedback to the OpenWork team with prefilled runtime context.",
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
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(72,187,255,0.14),_transparent_34%),linear-gradient(180deg,_#f7fbff_0%,_#edf4fb_100%)]">
      <div className="mx-auto max-w-5xl px-6 pb-20 pt-6 md:px-8 md:pt-8">
        <header className="mb-10 flex items-center justify-between gap-4">
          <Link href="/" className="inline-flex items-center gap-3 text-[#011627]">
            <OpenWorkMark className="h-[30px] w-[38px]" />
            <span className="text-[1.2rem] font-semibold tracking-tight lowercase">
              OpenWork
            </span>
          </Link>
          <Link
            href="/download"
            className="rounded-full border border-white/80 bg-white/80 px-4 py-2 text-[13px] font-medium text-slate-700 shadow-sm transition hover:bg-white"
          >
            Download latest app
          </Link>
        </header>

        <AppFeedbackForm prefill={prefill} />
        <SiteFooter />
      </div>
    </div>
  );
}
