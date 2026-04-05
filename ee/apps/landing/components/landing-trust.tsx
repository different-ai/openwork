"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useMemo, useState } from "react";

import { LandingBackground } from "./landing-background";
import { SiteNav } from "./site-nav";
import {
  defaultTrustTopicSlug,
  getTrustTopic,
  statusPageRequestHref,
  trustTopics,
  type TrustTopic
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
    <div className="flex flex-col gap-3 border-t border-slate-200/70 pt-3 text-sm text-slate-500 md:flex-row md:items-center md:justify-between">
      <div>
        OpenWork app is the experience layer. OpenWork server is the control
        and API layer. OpenWork worker is the runtime destination.
      </div>
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

function TopicRailItem({
  topic,
  active,
  onSelect
}: {
  topic: TrustTopic;
  active: boolean;
  onSelect: (slug: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(topic.slug)}
      className={`w-full rounded-[1.2rem] border px-4 py-3 text-left transition-all ${
        active
          ? "border-[#011627] bg-[#011627] text-white shadow-[0_14px_32px_-18px_rgba(1,22,39,0.55)]"
          : "border-slate-200/80 bg-white/80 text-slate-600 hover:border-slate-300 hover:text-[#011627]"
      }`}
      aria-pressed={active}
    >
      <div className="text-[14px] font-medium tracking-tight">{topic.label}</div>
    </button>
  );
}

function TopicPanel({ topic, callHref }: { topic: TrustTopic; callHref: string }) {
  const Icon = topic.icon;

  return (
    <div className="landing-shell flex h-full flex-col rounded-[1.75rem] p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-slate-200/70 bg-white/85 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            <ChevronLeft size={12} className="rotate-180" />
            Active topic
          </div>
          <h2 className="max-w-2xl text-[1.45rem] font-medium tracking-tight text-[#011627] md:text-[1.65rem]">
            {topic.title}
          </h2>
          <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-slate-600 md:text-[15px]">
            {topic.panelIntro}
          </p>
        </div>

        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${topic.toneClassName}`}
        >
          <Icon size={18} />
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        {topic.bullets.map((bullet) => (
          <div
            key={bullet}
            className="rounded-2xl border border-slate-200/70 bg-white/85 px-4 py-3 text-[13px] leading-relaxed text-slate-600"
          >
            {bullet}
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <a href={callHref} className="doc-button text-sm" {...externalLinkProps(callHref)}>
          Book a call
        </a>
        {topic.slug === "status-page-access" ? (
          <a
            href={statusPageRequestHref}
            className="secondary-button text-sm"
            {...externalLinkProps(statusPageRequestHref)}
          >
            Request status page
          </a>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap gap-3 text-[13px] text-slate-500">
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
    </div>
  );
}

export function LandingTrustOverview(props: SharedProps) {
  const callHref = props.calUrl || "/enterprise#book";
  const [activeSlug, setActiveSlug] = useState(defaultTrustTopicSlug);

  const activeTopic = useMemo(
    () => getTrustTopic(activeSlug) ?? trustTopics[0],
    [activeSlug]
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

        <main className="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-5xl flex-1 flex-col justify-between gap-4 px-6 pb-6 md:px-8 md:pb-8">
          <section className="max-w-4xl pt-2 md:pt-3">
            <div className="landing-chip mb-3 inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
              Trust Center
            </div>

            <h1 className="max-w-4xl text-4xl font-medium leading-[1.05] tracking-tight md:text-[2.7rem] lg:text-[3rem]">
              Enterprise trust starts with controllable architecture.
            </h1>

            <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-slate-600 md:text-[16px]">
              OpenWork is built for enterprises that want AI workflows without
              giving up deployment control, provider choice, or operational
              clarity.
            </p>

            <div className="mt-5 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <a href={callHref} className="doc-button" {...externalLinkProps(callHref)}>
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

          <section className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
            <div className="landing-shell rounded-[1.75rem] p-4 xl:p-5">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Topics
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                {trustTopics.map((topic) => (
                  <TopicRailItem
                    key={topic.slug}
                    topic={topic}
                    active={topic.slug === activeTopic.slug}
                    onSelect={setActiveSlug}
                  />
                ))}
              </div>
            </div>

            <TopicPanel topic={activeTopic} callHref={callHref} />
          </section>

          <TrustFooterBar />
        </main>
      </div>
    </div>
  );
}
