"use client";

import { AppWindow, Check, ChevronRight, Plus } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./setup-frame.module.css";
import { DenBrandMark } from "./ui/brand-mark";

/*
 * Building blocks for the one-page flows that live in `SetupFrame` without a
 * step (agent sign-in, CLI device codes, workspace claims, connection links).
 * Every screen composes these so a workspace is always the same letter tile,
 * facts are always hairline rows, and results are always a status circle.
 */

/** The first letter of a workspace, in the tile used everywhere a workspace appears. */
export function SetupLetterTile({ name, size = "sm" }: { name: string; size?: "sm" | "lg" }) {
  const letter = name.trim().charAt(0).toUpperCase() || "W";
  return size === "lg" ? (
    <span aria-hidden="true" className="flex size-16 shrink-0 items-center justify-center rounded-2xl border border-[var(--dls-border)] bg-white text-lg font-semibold text-[var(--setup-ink-soft)]">
      {letter}
    </span>
  ) : (
    <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--dls-hover)] text-[13px] font-semibold text-[var(--setup-ink-soft)]">
      {letter}
    </span>
  );
}

const KNOWN_APP_MARKS: { pattern: RegExp; slug: string }[] = [
  { pattern: /^claude\b/i, slug: "anthropic" },
  { pattern: /\bcursor\b/i, slug: "cursor" },
  { pattern: /\b(codex|chatgpt|openai)\b/i, slug: "openai" },
  { pattern: /\b(copilot|vs ?code)\b/i, slug: "githubcopilot" },
  { pattern: /\bwindsurf\b/i, slug: "windsurf" },
];

function simpleIconSlugFor(name: string) {
  const known = KNOWN_APP_MARKS.find((entry) => entry.pattern.test(name));
  if (known) return known.slug;
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug || undefined;
}

/**
 * The mark for an app or service by name: its logo when we can find one, a
 * generic app glyph when the app did not share a name.
 */
export function SetupAppMark({ name, logoUri, size = 16 }: { name: string | null; logoUri?: string | null; size?: 16 | 26 }) {
  const box = size === 16 ? "size-4" : "size-[26px]";
  if (!name && !logoUri) {
    return <AppWindow aria-hidden="true" className={`${box} shrink-0 text-[var(--dls-text-secondary)]`} strokeWidth={1.5} />;
  }
  return (
    <DenBrandMark
      name={name ?? ""}
      iconUrl={logoUri ?? undefined}
      simpleIconSlug={name ? simpleIconSlugFor(name) : undefined}
      className={`${box} border-transparent bg-transparent text-[11px] font-semibold text-[var(--dls-text-primary)]`}
      imageClassName={box}
    />
  );
}

type StoryEnd = { label: string; mark: ReactNode; pending?: boolean };

/**
 * Who is asking and where it goes: two tiles joined by a line. The line is
 * dashed while the connection is being made and solid once it exists.
 */
export function SetupStoryTiles({ from, to, linked = false }: { from: StoryEnd; to: StoryEnd; linked?: boolean }) {
  const end = (item: StoryEnd, testId: string) => (
    <div className="flex w-30 shrink-0 flex-col items-center gap-2.5" data-testid={testId}>
      {item.mark}
      <span className={`max-w-30 truncate text-[13px] font-medium leading-[18px] ${item.pending ? "text-[var(--dls-text-secondary)]" : "text-[var(--dls-text-primary)]"}`}>{item.label}</span>
    </div>
  );
  return (
    <div className="flex items-start" data-testid="setup-story-tiles">
      {end(from, "setup-story-from")}
      <div className="flex h-16 w-30 shrink-0 items-center" aria-hidden="true">
        <span className={`h-0 grow border-t-[1.5px] ${linked ? "border-solid border-[var(--dls-text-primary)]" : "border-dashed border-[#bdbdbd]"}`} />
      </div>
      {end(to, "setup-story-to")}
    </div>
  );
}

/** The large tile that holds a logo or app glyph in the story column. */
export function SetupStoryTile({ children, pending = false }: { children: ReactNode; pending?: boolean }) {
  return (
    <span aria-hidden="true" className={`flex size-16 shrink-0 items-center justify-center rounded-2xl bg-white ${pending ? "border-[1.5px] border-dashed border-[#bdbdbd]" : "border border-[var(--dls-border)]"}`}>
      {children}
    </span>
  );
}

export function SetupNewWorkspaceTile() {
  return (
    <SetupStoryTile pending>
      <Plus className="size-5 text-[var(--dls-text-secondary)]" strokeWidth={1.5} />
    </SetupStoryTile>
  );
}

export type SetupFact = { label: string; value: ReactNode; mono?: boolean; testId?: string };

/** Label left, value right, hairline between rows. */
export function SetupFacts({ rows }: { rows: SetupFact[] }) {
  return (
    <dl className="m-0 flex flex-col border-t border-[var(--setup-hairline)]" data-testid="setup-facts">
      {rows.map((row) => (
        <div key={row.label} className="flex min-h-10 items-center justify-between gap-4 border-b border-[var(--setup-hairline)] py-2">
          <dt className="text-[13px] leading-[18px] text-[var(--dls-text-secondary)]">{row.label}</dt>
          <dd
            className={`m-0 flex min-w-0 items-center gap-2 truncate text-[var(--dls-text-primary)] ${row.mono ? "font-mono text-xs leading-[18px]" : "text-[13px] font-medium leading-[18px]"}`}
            data-testid={row.testId}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SetupPanelTitle({ children, id }: { children: ReactNode; id?: string }) {
  return <h2 id={id} className="m-0 text-2xl font-semibold leading-[30px] tracking-[-0.03em] text-[var(--dls-text-primary)]">{children}</h2>;
}

/** Plain body copy in the panel. `muted` is the quieter second line. */
export function SetupLine({ children, muted = false, testId }: { children: ReactNode; muted?: boolean; testId?: string }) {
  return <p className={`m-0 text-[13px] leading-5 ${muted ? "text-[var(--dls-text-secondary)]" : "text-[var(--dls-text-primary)]"}`} data-testid={testId}>{children}</p>;
}

/** A failure is one red line next to the action it belongs to. */
export function SetupErrorLine({ children }: { children: ReactNode }) {
  return <p role="alert" className="m-0 text-[13px] leading-5 text-rose-600">{children}</p>;
}

/** Result screens: a status circle, a title and one line. */
export function SetupStatus({ icon, title, line, children }: { icon?: ReactNode; title: string; line?: string; children?: ReactNode }) {
  return (
    <div className="grid justify-items-start gap-4" role="status">
      {icon ? (
        <span className="flex size-10 items-center justify-center rounded-full bg-[var(--dls-hover)] text-[var(--dls-text-primary)]" aria-hidden="true">{icon}</span>
      ) : null}
      <SetupPanelTitle>{title}</SetupPanelTitle>
      {line ? <SetupLine muted>{line}</SetupLine> : null}
      {children}
    </div>
  );
}

/** "Claude Code can" followed by plain sentences, each with a check. */
export function SetupCanList({ actor, items }: { actor: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2.5" aria-label={`${actor} can`} data-testid="setup-can-list">
      <p className="m-0 text-[13px] font-medium leading-[18px] text-[var(--dls-text-primary)]">{actor} can</p>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2.5 text-[13px] leading-[18px] text-[var(--dls-text-primary)]">
            <Check aria-hidden="true" className="size-4 shrink-0 text-[var(--dls-text-secondary)]" strokeWidth={1.5} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A quiet text action (Cancel, Deny, Use a different account, Show more). */
export function SetupQuietButton({ children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`bg-transparent p-0 text-[13px] font-medium leading-[18px] text-[var(--dls-text-secondary)] hover:text-[var(--dls-text-primary)] disabled:cursor-not-allowed disabled:opacity-60 ${className}`} {...props}>
      {children}
    </button>
  );
}

/** Raw details (scopes, full addresses) stay behind one collapsed row. */
export function SetupTechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <details className="group min-w-0 text-xs leading-4 text-[var(--dls-text-secondary)]">
      <summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none" strokeWidth={1.5} />
        Technical details
      </summary>
      <div className="mt-2 grid gap-1 break-all pl-5 font-mono">{children}</div>
    </details>
  );
}

/** Skeleton rows that hold the place of workspaces while they load. */
export function SetupSkeletonRows({ count = 2 }: { count?: number }) {
  return (
    <div className="flex flex-col border-t border-[var(--setup-hairline)]" aria-busy="true" aria-label="Loading workspaces" data-testid="setup-skeleton-rows">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex min-h-13 items-center gap-3 border-b border-[var(--setup-hairline)]">
          <span className="size-8 shrink-0 rounded-lg bg-[#f0f0f0] motion-safe:animate-pulse" />
          <span className="flex grow flex-col gap-1.5">
            <span className="h-3 w-35 rounded-md bg-[#f0f0f0] motion-safe:animate-pulse" />
            <span className="h-2.5 w-16 rounded-md bg-[#f0f0f0] motion-safe:animate-pulse" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** The panel's content column; the frame draws the band and padding. */
export function SetupPanelBody({ children, gap = "lg" }: { children: ReactNode; gap?: "lg" | "md" }) {
  return <div className={`flex flex-col ${gap === "lg" ? "gap-[18px]" : "gap-4"}`}>{children}</div>;
}

export type SetupTerminalLine = { text: string; muted?: boolean };

/**
 * The terminal a command-line sign-in started from, drawn in the story column
 * so the person can match the code on the page with the one in their terminal.
 */
export function SetupTerminal({ lines }: { lines: SetupTerminalLine[] }) {
  return (
    <figure className="m-0 mt-10 w-full max-w-110" aria-label="Your terminal" data-testid="setup-terminal">
      <div className={styles.appWindow}>
        <div className={styles.appTitlebar}>
          <span className="flex gap-1.5" aria-hidden="true">
            <i className="size-2.25 rounded-full bg-[var(--dls-border)]" />
            <i className="size-2.25 rounded-full bg-[var(--dls-border)]" />
            <i className="size-2.25 rounded-full bg-[var(--dls-border)]" />
          </span>
          <span className="pl-2 text-xs font-normal text-[#888]">Terminal</span>
        </div>
        <pre className="m-0 overflow-hidden whitespace-pre-wrap px-4 pb-4 pt-3.5 font-mono text-xs leading-5">
          {lines.map((line, index) => (
            <span key={index} className={`block ${line.muted ? "text-[var(--dls-text-secondary)]" : "text-[var(--dls-text-primary)]"}`}>{line.text}</span>
          ))}
        </pre>
      </div>
    </figure>
  );
}

/** A one-time code as the panel's first fact, in mono. */
export function SetupCode({ code, testId, size = "sm" }: { code: string; testId?: string; size?: "sm" | "lg" }) {
  return (
    <span className={`font-mono font-semibold tracking-[0.12em] text-[var(--dls-text-primary)] ${size === "lg" ? "text-xl leading-7" : "text-sm leading-[18px]"}`} data-testid={testId}>
      {code}
    </span>
  );
}
