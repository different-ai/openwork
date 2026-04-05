import Link from "next/link";

import { LandingBackground } from "./landing-background";
import { SiteNav } from "./site-nav";
import { statusPageRequestHref, trustSections } from "./trust-content";

type SharedProps = {
  stars: string;
  downloadHref: string;
  calUrl: string;
};

function externalLinkProps(href: string) {
  return /^https?:\/\//.test(href) || href.startsWith("mailto:")
    ? { rel: "noreferrer", target: "_blank" as const }
    : {};
}

function TrustFooterBar() {
  return (
    <div className="flex flex-col gap-3 border-t border-slate-200/70 pt-3 text-sm text-slate-500 md:flex-row md:items-center md:justify-between">
      <div>OpenWork app is the experience layer. OpenWork server is the control/API layer. OpenWork worker is the runtime destination.</div>
      <div className="flex flex-wrap items-center gap-4">
        <Link href="/privacy" className="transition-colors hover:text-[#011627]">
          Privacy
        </Link>
        <Link href="/terms" className="transition-colors hover:text-[#011627]">
          Terms
        </Link>
        <Link href="/enterprise" className="transition-colors hover:text-[#011627]">
          Enterprise
        </Link>
      </div>
    </div>
  );
}

function TrustSummaryCard({
  section
}: {
  section: (typeof trustSections)[number];
}) {
  const Icon = section.icon;

  return (
    <div className="landing-shell flex h-full flex-col rounded-[1.75rem] p-5 md:p-6">
      <div className="mb-4 flex items-center gap-3">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-2xl ${section.tileClassName}`}
        >
          <Icon size={18} />
        </div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          {section.eyebrow}
        </div>
      </div>

      <h2 className="text-[1.08rem] font-medium tracking-tight text-[#011627]">
        {section.title}
      </h2>

      <p className="mt-3 text-[14px] leading-relaxed text-slate-600">
        {section.description}
      </p>

      <div className="mt-5 space-y-3">
        {section.lines.map((line) => (
          <div key={line.label} className="rounded-2xl border border-slate-200/70 bg-white/85 px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              {line.label}
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-slate-600">
              {line.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LandingTrustOverview(props: SharedProps) {
  const callHref = props.calUrl || "/enterprise#book";

  return (
    <div className="relative min-h-screen overflow-hidden text-[#011627]">
      <LandingBackground />

      <div className="relative z-10 flex min-h-screen flex-col items-center pb-3 pt-1 md:pb-4 md:pt-2">
        <div className="w-full">
          <SiteNav
            stars={props.stars}
            callUrl={callHref}
            downloadHref={props.downloadHref}
            active="trust"
          />
        </div>

        <main className="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-5xl flex-1 flex-col justify-between gap-4 px-6 pb-6 md:gap-4 md:px-8 md:pb-8">
          <section className="max-w-4xl pt-2 md:pt-3">
            <div className="landing-chip mb-3 inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
              OpenWork Trust
            </div>

            <h1 className="max-w-4xl text-4xl font-medium leading-[1.05] tracking-tight md:text-[2.7rem] lg:text-[3rem]">
              Clear boundaries. Real control. No trust theater.
            </h1>

            <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-slate-600 md:text-[16px]">
              The essentials for enterprise champions and decision-makers:
              where OpenWork runs, who controls providers and data, and how we
              handle operational follow-through.
            </p>

            <div className="mt-5 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <a
                href={callHref}
                className="doc-button"
                {...externalLinkProps(callHref)}
              >
                Book a call
              </a>
              <a
                href={statusPageRequestHref}
                className="secondary-button"
                {...externalLinkProps(statusPageRequestHref)}
              >
                Request status page
              </a>
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-3 md:[grid-auto-rows:1fr]">
            {trustSections.map((section) => (
              <TrustSummaryCard key={section.title} section={section} />
            ))}
          </section>

          <TrustFooterBar />
        </main>
      </div>
    </div>
  );
}
