import Link from "next/link";

import { LandingBackground } from "./landing-background";
import { SiteNav } from "./site-nav";
import {
  statusPageRequestHref,
  type TrustTopic
} from "./trust-content";

type Props = {
  topic: TrustTopic;
  stars: string;
  downloadHref: string;
  calUrl: string;
};

function externalLinkProps(href: string) {
  return /^https?:\/\//.test(href) || href.startsWith("mailto:")
    ? { rel: "noreferrer", target: "_blank" as const }
    : {};
}

export function LandingTrustTopicPage({
  topic,
  stars,
  downloadHref,
  calUrl
}: Props) {
  const Icon = topic.icon;
  const callHref = calUrl || "/enterprise#book";

  return (
    <div className="relative min-h-screen overflow-hidden text-[#011627]">
      <LandingBackground />

      <div className="relative z-10 flex min-h-screen flex-col items-center pb-3 pt-1 md:pb-4 md:pt-2">
        <div className="w-full">
          <SiteNav
            stars={stars}
            callUrl={callHref}
            downloadHref={downloadHref}
            active="trust"
          />
        </div>

        <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 pb-20 md:px-8 md:pb-24">
          <section className="pt-3">
            <Link
              href="/trust"
              className="mb-4 inline-flex items-center gap-2 text-[13px] font-medium text-slate-500 transition-colors hover:text-[#011627]"
            >
              Back to trust center
            </Link>

            <div className="landing-chip mb-3 inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
              {topic.label}
            </div>

            <h1 className="max-w-3xl text-4xl font-medium leading-[1.05] tracking-tight md:text-[2.7rem]">
              {topic.title}
            </h1>

            <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-slate-600 md:text-[16px]">
              {topic.panelIntro}
            </p>
          </section>

          <section className="landing-shell rounded-[2rem] p-6 md:p-8">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  What this means
                </div>
              </div>
              <div
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${topic.toneClassName}`}
              >
                <Icon size={18} />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {topic.bullets.map((bullet) => (
                <div
                  key={bullet}
                  className="rounded-2xl border border-slate-200/70 bg-white/85 px-4 py-4 text-[14px] leading-relaxed text-slate-600"
                >
                  {bullet}
                </div>
              ))}
            </div>

            <div className="mt-5 flex flex-wrap gap-3 text-[13px] text-slate-500">
              {topic.links.map((link) =>
                link.external ? (
                  <a
                    key={link.label}
                    href={link.href}
                    className="transition-colors hover:text-[#011627]"
                    rel="noreferrer"
                    target="_blank"
                  >
                    {link.label}
                  </a>
                ) : (
                  <Link
                    key={link.label}
                    href={link.href}
                    className="transition-colors hover:text-[#011627]"
                  >
                    {link.label}
                  </Link>
                )
              )}
            </div>
          </section>

          <section className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <a href={callHref} className="doc-button" {...externalLinkProps(callHref)}>
              Book a call
            </a>
            {topic.slug === "status-page-access" ? (
              <a
                href={statusPageRequestHref}
                className="secondary-button"
                {...externalLinkProps(statusPageRequestHref)}
              >
                Request status page
              </a>
            ) : null}
          </section>
        </main>
      </div>
    </div>
  );
}
