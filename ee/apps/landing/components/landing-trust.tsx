"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { type Subprocessor, subprocessors } from "./trust-content";

import { SiteFooter } from "./site-footer";

import { LandingBackground } from "./landing-background";
import { SiteNav } from "./site-nav";
import {
  defaultTrustTopicSlug,
  getTrustTopic,
  statusPageRequestHref,
  trustTopics,
  type TrustTopic
} from "./trust-content";

const categoryColors: Record<string, string> = {
  Analytics: "bg-orange-50 text-orange-700",
  Payments: "bg-violet-50 text-violet-700",
  Authentication: "bg-blue-50 text-blue-700",
  Infrastructure: "bg-cyan-50 text-cyan-700"
};

function SubprocessorRows() {
  return (
    <div className="mt-5 flex flex-col divide-y divide-slate-200/70 overflow-hidden rounded-2xl border border-slate-200/70 bg-white/85">
      {subprocessors.map((sp) => (
        <a
          key={sp.name}
          href={sp.href}
          rel="noreferrer"
          target="_blank"
          className="flex min-w-0 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50/80"
        >
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold tracking-wide"
            style={{ backgroundColor: sp.brandColor, color: sp.textColor }}
          >
            {sp.initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] leading-relaxed text-slate-500">
              <span className="font-semibold text-[#011627]">{sp.name}</span>
              {": "}
              {sp.purpose}
            </p>
          </div>
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${categoryColors[sp.category] ?? "bg-slate-100 text-slate-600"}`}
            >
              {sp.category}
            </span>
            <span className="text-[11px] text-slate-400">{sp.location} Region</span>
          </div>
        </a>
      ))}
    </div>
  );
}

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

function TopicChip({
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
      className={`shrink-0 rounded-full border px-3.5 py-1.5 text-[13px] font-medium tracking-tight transition-all ${
        active
          ? "border-[#011627] bg-[#011627] text-white shadow-[0_8px_20px_-8px_rgba(1,22,39,0.45)]"
          : "border-slate-200/80 bg-white/80 text-slate-600 hover:border-slate-300 hover:text-[#011627]"
      }`}
      aria-pressed={active}
    >
      {topic.label}
    </button>
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
      <div>
        <div className="flex items-center gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${topic.toneClassName}`}
          >
            <Icon size={16} />
          </div>
          <h2 className="max-w-2xl text-[1.2rem] font-medium tracking-tight text-[#011627] md:text-[1.35rem]">
            {topic.title}
          </h2>
        </div>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-slate-600 md:text-[14px]">
          {topic.panelIntro}
        </p>
      </div>

      {topic.slug === "subprocessors" ? (
        <SubprocessorRows />
      ) : (
        <div className="mt-3 flex flex-1 flex-col gap-2">
          {topic.bullets.map((bullet) => (
            <div
              key={bullet}
              className="flex flex-1 items-center rounded-2xl border border-slate-200/70 bg-white/85 px-4 py-2 text-[13px] leading-relaxed text-slate-600"
            >
              {bullet}
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        {topic.slug === "status-page-access" ? (
          <a
            href={statusPageRequestHref}
            className="doc-button text-sm"
            {...externalLinkProps(statusPageRequestHref)}
          >
            Request status page
          </a>
        ) : topic.slug === "subprocessors" ? null : (
          <a href={callHref} className="doc-button text-sm" {...externalLinkProps(callHref)}>
            Book a call
          </a>
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
          />
        </div>

        <main className="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-5xl flex-1 flex-col justify-between gap-4 px-6 pb-6 md:px-8 md:pb-8">
          <section className="max-w-4xl pt-2 md:pt-3">
            <h1 className="max-w-4xl text-4xl font-medium leading-[1.05] tracking-tight md:text-[2.7rem] lg:text-[3rem]">
              Openwork's Trust Center
            </h1>

            <p className="mt-3 max-w-4xl text-[15px] leading-relaxed text-slate-600 md:text-[16px]">
              Moving at startup speed without compromising on enterprise protection.
              We treat security not as an afterthought, but as a foundational pillar of everything we build.
              This mindset drives our development processes, infrastructure decisions, and organizational policies.
              We treat the data entrusted to us with the utmost care and responsibility.
            </p>
          </section>

          <section className="flex flex-col gap-4 xl:grid xl:grid-cols-[220px_minmax(0,1fr)]">
            {/* Mobile: horizontal scrollable chip row */}
            <div className="flex gap-2 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden xl:hidden">
              {trustTopics.map((topic) => (
                <TopicChip
                  key={topic.slug}
                  topic={topic}
                  active={topic.slug === activeTopic.slug}
                  onSelect={setActiveSlug}
                />
              ))}
            </div>

            {/* Desktop: sidebar rail */}
            <div className="landing-shell hidden rounded-[1.75rem] p-5 xl:block">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Topics
              </div>
              <div className="grid gap-2">
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

          <SiteFooter />

        </main>
      </div>
    </div>
  );
}
