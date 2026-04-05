import Link from "next/link";
import { ArrowRight, ChevronLeft, type LucideIcon } from "lucide-react";

import { LandingBackground } from "./landing-background";
import { SiteNav } from "./site-nav";
import {
  getTrustSection,
  statusPageRequestHref,
  trustSections,
  type TrustSection
} from "./trust-content";

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
    <div className="flex flex-col gap-3 border-t border-slate-200/70 pt-5 text-sm text-slate-500 md:flex-row md:items-center md:justify-between">
      <div>OpenWork trust is centered on deployment, provider, and runtime control.</div>
      <div className="flex flex-wrap items-center gap-4">
        <Link href="/trust/subprocessors" className="transition-colors hover:text-[#011627]">
          Subprocessors
        </Link>
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

function TrustAccent({
  icon: Icon,
  className,
  label
}: {
  icon: LucideIcon;
  className: string;
  label: string;
}) {
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${className}`}
    >
      <Icon size={12} />
      {label}
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

        <main className="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-5xl flex-1 flex-col justify-between gap-5 px-6 pb-6 md:gap-6 md:px-8 md:pb-8">
          <section className="max-w-4xl pt-2 md:pt-4">
            <div className="landing-chip mb-4 inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
              OpenWork Trust
            </div>

            <h1 className="max-w-4xl text-4xl font-medium leading-[1.05] tracking-tight md:text-[2.9rem] lg:text-[3.2rem]">
              Trust starts with clear boundaries.
            </h1>

            <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-slate-600 md:text-[17px]">
              OpenWork keeps deployment choice, provider control, and runtime
              boundaries legible enough for real enterprise review.
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

            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] font-medium text-slate-500">
              <span>Local-first</span>
              <span aria-hidden="true">•</span>
              <span>Bring your own keys</span>
              <span aria-hidden="true">•</span>
              <span>Status page on request</span>
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-3 md:[grid-auto-rows:1fr]">
            {trustSections
              .filter((section) => section.slug !== "subprocessors")
              .map((section) => {
                const Icon = section.icon;

                return (
                  <Link
                    key={section.slug}
                    href={`/trust/${section.slug}`}
                    className="landing-shell flex h-full flex-col rounded-[1.75rem] p-4 transition-transform duration-200 hover:-translate-y-[1px] md:p-5"
                  >
                    <div
                      className={`mb-3 flex h-9 w-9 items-center justify-center rounded-2xl ${section.tileClassName}`}
                    >
                      <Icon size={17} />
                    </div>
                    <h2 className="mb-2 text-[1rem] font-medium tracking-tight text-[#011627] md:text-[1.02rem]">
                      {section.overviewTitle}
                    </h2>
                    <p className="flex-1 text-[13px] leading-[1.55] text-slate-600 md:text-[13.5px]">
                      {section.overviewDescription}
                    </p>
                    <span className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-[#011627] transition-colors hover:text-slate-700">
                      Learn more <ArrowRight size={15} />
                    </span>
                  </Link>
                );
              })}
          </section>

          <section className="landing-shell-soft flex flex-col gap-3 rounded-[1.75rem] px-5 py-4 text-[13px] text-slate-600 md:flex-row md:items-center md:justify-between md:px-6">
            <div className="leading-relaxed">
              <span className="font-medium text-[#011627]">Runtime model:</span>{" "}
              OpenWork app is the experience layer, OpenWork server is the
              control/API layer, and OpenWork worker is the runtime destination.
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm font-medium text-[#011627]">
              <Link href="/trust/subprocessors" className="transition-colors hover:text-slate-700">
                View subprocessors
              </Link>
              <Link href="/privacy" className="transition-colors hover:text-slate-700">
                Privacy
              </Link>
              <Link href="/terms" className="transition-colors hover:text-slate-700">
                Terms
              </Link>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

export function LandingTrustDetail(
  props: SharedProps & { section: TrustSection }
) {
  const callHref = props.calUrl || "/enterprise#book";
  const secondaryHref = props.section.actionHref ?? statusPageRequestHref;
  const secondaryLabel = props.section.actionLabel ?? "Request status page";
  const relatedSections = trustSections.filter(
    (candidate) =>
      candidate.slug !== props.section.slug && candidate.slug !== "subprocessors"
  );

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

        <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 pb-8 md:gap-10 md:px-8 md:pb-10">
          <section className="max-w-4xl pt-3 md:pt-6">
            <Link
              href="/trust"
              className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-slate-500 transition-colors hover:text-[#011627]"
            >
              <ChevronLeft size={16} />
              Back to trust
            </Link>

            <TrustAccent
              icon={props.section.icon}
              className={props.section.accentClassName}
              label={props.section.eyebrow}
            />

            <h1 className="mt-4 max-w-4xl text-4xl font-medium leading-[1.05] tracking-tight md:text-5xl">
              {props.section.title}
            </h1>

            <p className="mt-4 max-w-3xl text-[16px] leading-relaxed text-slate-600 md:text-[18px]">
              {props.section.intro}
            </p>
          </section>

          <section className="grid gap-6 md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
            <div className="landing-shell rounded-[2rem] p-6 md:p-8">
              <h2 className="mb-4 text-2xl font-medium tracking-tight text-[#011627]">
                What this means in practice
              </h2>

              <div className="space-y-3">
                {props.section.bullets.map((bullet, index) => (
                  <div
                    key={bullet}
                    className="flex gap-3 rounded-2xl border border-slate-200/70 bg-white/85 px-4 py-4 shadow-sm"
                  >
                    <div className="step-circle shrink-0">{index + 1}</div>
                    <p className="text-[14px] leading-relaxed text-slate-600">
                      {bullet}
                    </p>
                  </div>
                ))}
              </div>

              {props.section.placeholder ? (
                <div className="mt-6 rounded-[1.5rem] border border-amber-200 bg-amber-50/80 px-5 py-4 text-[14px] leading-relaxed text-amber-900">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
                    {props.section.placeholder.title}
                  </div>
                  {props.section.placeholder.body}
                </div>
              ) : null}
            </div>

            <div className="space-y-6">
              <div className="landing-shell rounded-[2rem] p-6">
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Need a missing detail?
                </div>
                <h2 className="mb-3 text-[1.35rem] font-medium tracking-tight text-[#011627]">
                  We can fill in the parts that are not public yet.
                </h2>
                <p className="text-[14px] leading-relaxed text-slate-600">
                  Use the trust page for the public overview, then use a live
                  conversation for the exact process details, disclosure depth,
                  and deployment-specific questions your team needs answered.
                </p>
                <div className="mt-5 flex flex-col gap-3">
                  <a
                    href={callHref}
                    className="doc-button w-full"
                    {...externalLinkProps(callHref)}
                  >
                    Book a call
                  </a>
                  <a
                    href={secondaryHref}
                    className="secondary-button w-full"
                    {...externalLinkProps(secondaryHref)}
                  >
                    {secondaryLabel}
                  </a>
                </div>
              </div>

              <div className="landing-shell-soft rounded-[2rem] p-6">
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Related trust topics
                </div>
                <div className="space-y-2">
                  {relatedSections.slice(0, 3).map((section) => (
                    <Link
                      key={section.slug}
                      href={`/trust/${section.slug}`}
                      className="flex items-center justify-between rounded-2xl border border-slate-200/70 bg-white/85 px-4 py-3 text-[14px] font-medium text-[#011627] transition-colors hover:bg-white"
                    >
                      <span>{section.overviewTitle}</span>
                      <ArrowRight size={15} />
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <TrustFooterBar />
        </main>
      </div>
    </div>
  );
}

export { getTrustSection };
