"use client";

import Link from "next/link";
import { BookOpen, LockKeyhole, X } from "lucide-react";
import type { ReactNode } from "react";
import { buttonVariants } from "../../../_components/ui/button";
import { DenChip } from "../../../_components/ui/chip";
import type { FeatureIntro, FeatureIntroCta, FeatureIntroExampleSpec } from "./types";

/*
 * Feature intro surfaces (DESIGN.md I2, I3, I7). Flat (S1), tokens only, no
 * gradients or illustrations (V7). Content always comes from the registry (I10).
 */

export type FeatureIntroActionProps = {
  cta: FeatureIntroCta | null;
  note: string | null;
  onCtaClick: () => void;
};

/** "Read the docs" with a book icon; every intro has one (I8). */
export function FeatureIntroDocsLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid="feature-intro-docs"
      className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-gray-600 transition-colors hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dls-accent)]"
    >
      <BookOpen className="size-4" strokeWidth={1.5} aria-hidden />
      Read the docs
    </a>
  );
}

/** No permission: a neutral lock and why, never a button the person cannot use (P4, C5, I6). */
export function FeatureIntroLockedAction({ reason }: { reason: string }) {
  return (
    <span className="inline-flex min-h-10 items-center gap-1.5 text-[13px] text-gray-600" data-testid="feature-intro-locked">
      <LockKeyhole className="size-4 shrink-0 text-gray-500" strokeWidth={1.5} aria-hidden />
      {reason}
    </span>
  );
}

function FeatureIntroCtaControl({ cta, onCtaClick, size = "md" }: { cta: FeatureIntroCta; onCtaClick: () => void; size?: "md" | "compact" }) {
  if (cta.locked) return <FeatureIntroLockedAction reason={cta.locked.reason} />;
  // Another site (e.g. Enterprise sales) opens in a new tab so the dashboard stays put.
  if (/^https?:\/\//.test(cta.href)) {
    return (
      <a href={cta.href} target="_blank" rel="noreferrer" onClick={onCtaClick} data-testid="feature-intro-cta" className={buttonVariants({ variant: "primary", size })}>
        {cta.label}
      </a>
    );
  }
  return (
    <Link href={cta.href} onClick={onCtaClick} data-testid="feature-intro-cta" className={buttonVariants({ variant: "primary", size })}>
      {cta.label}
    </Link>
  );
}

function FeatureIntroActions({ cta, note, onCtaClick, docsUrl, size = "md" }: FeatureIntroActionProps & { docsUrl: string; size?: "md" | "compact" }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {cta ? <FeatureIntroCtaControl cta={cta} onCtaClick={onCtaClick} size={size} /> : null}
        <FeatureIntroDocsLink href={docsUrl} />
      </div>
      {note && !cta?.locked ? <p className="text-[12px] text-gray-500">{note}</p> : null}
    </div>
  );
}

/**
 * Frame for a live example on sample data (I7): "Example" chip, the render is
 * hidden from assistive tech and pointer input, `alt` is read instead, and
 * motion stops under prefers-reduced-motion.
 */
export function FeatureIntroExample({ alt, children, className = "", bare = false }: { alt: string; children: ReactNode; className?: string; bare?: boolean }) {
  const frame = bare ? "" : "overflow-hidden rounded-[16px] border border-gray-200 bg-white p-4";
  return (
    <figure className={`relative m-0 ${frame} ${className}`} data-testid="feature-intro-example">
      <figcaption className="sr-only">{alt}</figcaption>
      <div className="mb-3 flex justify-start">
        <DenChip tone="neutral" aria-hidden>Example</DenChip>
      </div>
      <div
        aria-hidden
        inert
        className="pointer-events-none select-none motion-reduce:[&_*]:!animate-none motion-reduce:[&_*]:!transition-none"
      >
        {children}
      </div>
    </figure>
  );
}

function IntroExample({ example, className, bare }: { example: FeatureIntroExampleSpec; className?: string; bare?: boolean }) {
  const { Component } = example;
  return (
    <FeatureIntroExample alt={example.alt} className={className} bare={bare}>
      <Component />
    </FeatureIntroExample>
  );
}

function IntroIconTile({ intro }: { intro: FeatureIntro }) {
  const Icon = intro.icon;
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-700" aria-hidden>
      <Icon className="size-5" strokeWidth={1.5} />
    </span>
  );
}

function Highlights({ items }: { items: FeatureIntro["highlights"] }) {
  if (!items?.length) return null;
  return (
    <ul className="flex flex-col gap-3" data-testid="feature-intro-highlights">
      {items.map((item) => (
        <li key={item.title} className="flex gap-3 text-[13px] leading-5">
          <span className="mt-2 size-1 shrink-0 rounded-full bg-gray-400" aria-hidden />
          <span>
            <span className="font-medium text-gray-900">{item.title}</span>
            <span className="text-gray-500"> {item.text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Full screen (I2, I3): replaces the page content while nothing in the section
 * is set up. Left: icon, title, value line, paragraph or highlights, one
 * action, docs. Right (~40%): live example. One column under 900px.
 */
export function FeatureIntroFullscreen({ intro, ...actions }: { intro: FeatureIntro } & FeatureIntroActionProps) {
  return (
    <section
      className="mx-auto w-full max-w-[1120px] px-4 py-10 md:px-8 md:py-16"
      data-testid="feature-intro-fullscreen"
      data-intro-key={intro.key}
      aria-labelledby={`feature-intro-${intro.key}-title`}
    >
      <FeatureIntroContent intro={intro} {...actions} headingLevel="h1" />
    </section>
  );
}

/** Shared by the full screen and the `?` dialog: the whole intro, two columns. */
export function FeatureIntroContent({
  intro,
  headingLevel = "h2",
  ...actions
}: { intro: FeatureIntro; headingLevel?: "h1" | "h2" } & FeatureIntroActionProps) {
  const Heading = headingLevel;
  const highlights = intro.highlights?.slice(0, 4);
  return (
    <div className={`grid gap-10 ${intro.example ? "min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,40%)] min-[900px]:items-center" : ""}`}>
      <div className="flex max-w-[560px] flex-col gap-5">
        <IntroIconTile intro={intro} />
        <div className="flex flex-col gap-1.5">
          <Heading id={`feature-intro-${intro.key}-title`} className="text-[20px] font-semibold leading-7 tracking-[-0.3px] text-gray-950">
            {intro.title}
          </Heading>
          <p className="text-[15px] leading-6 text-gray-700">{intro.summary}</p>
        </div>
        {intro.body ? <p className="max-w-[52ch] text-[13px] leading-6 text-gray-500">{intro.body}</p> : null}
        <Highlights items={highlights} />
        <FeatureIntroActions {...actions} docsUrl={intro.docsUrl} />
      </div>
      {intro.example ? <IntroExample example={intro.example} /> : null}
    </div>
  );
}

/** Box (I2, I3): a tab or sub-page not set up while its section is; max 600px, where the list would be. */
export function FeatureIntroBox({ intro, showExample = true, ...actions }: { intro: FeatureIntro; showExample?: boolean } & FeatureIntroActionProps) {
  const example = showExample ? intro.example : undefined;
  return (
    <section
      className="mt-6 flex w-full max-w-[600px] flex-col gap-4 rounded-[24px] border border-gray-200 bg-white p-6"
      data-testid="feature-intro-box"
      data-intro-key={intro.key}
      aria-labelledby={`feature-intro-${intro.key}-title`}
    >
      <div className="flex flex-col gap-1">
        <h2 id={`feature-intro-${intro.key}-title`} className="text-[15px] font-semibold leading-6 tracking-[-0.1px] text-gray-950">
          {intro.title}
        </h2>
        <p className="text-[13px] leading-5 text-gray-600">{intro.summary}</p>
      </div>
      <Highlights items={intro.highlights?.slice(0, 3)} />
      <FeatureIntroActions {...actions} docsUrl={intro.docsUrl} size="compact" />
      {example ? (
        <>
          <hr className="my-2 border-0 border-t border-gray-200" />
          <IntroExample example={example} bare />
        </>
      ) : null}
    </section>
  );
}

/** Banner (I2, I3): page partly set up. One line, action, docs, dismiss for 30 days. Max 300px tall. */
export function FeatureIntroBanner({ intro, onDismiss, ...actions }: { intro: FeatureIntro; onDismiss: () => void } & FeatureIntroActionProps) {
  const { cta, onCtaClick } = actions;
  return (
    <div
      className="relative flex max-h-[300px] flex-col gap-3 overflow-hidden rounded-[24px] border border-gray-200 bg-gray-50 py-4 pl-5 pr-12 text-[14px] text-gray-600"
      data-testid="feature-intro-banner"
      data-intro-key={intro.key}
    >
      <div className="flex items-start gap-3">
        <intro.icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-gray-700">{intro.bannerText ?? intro.summary}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1 pl-7">
        {cta ? <FeatureIntroCtaControl cta={cta} onCtaClick={onCtaClick} size="compact" /> : null}
        <FeatureIntroDocsLink href={intro.docsUrl} />
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss for 30 days"
        title="Dismiss for 30 days"
        data-testid="feature-intro-dismiss"
        className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
      >
        <X className="size-4" strokeWidth={1.5} aria-hidden />
      </button>
    </div>
  );
}
