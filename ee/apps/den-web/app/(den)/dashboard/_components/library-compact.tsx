"use client";

import { FileText, Package, Workflow } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Library and Connectors lists: sections by kind, 44px rows with the
 * name and a one-line description, where it came from on the right, and the
 * row menu revealed on hover or focus (always shown on touch).
 */
/**
 * The white surface a list sits on. The dashboard canvas is tinted, so content
 * goes on white like the cards beside it; sections inside are separated by
 * space, not more boxes (DESIGN S1, V3).
 */
export function LibraryCompactSurface({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-gray-100 bg-white p-2 py-3" data-testid={testId}>
      {children}
    </div>
  );
}

export function LibraryCompactSection({ title, count, children, testId, tone = "default" }: {
  title: string;
  count: number;
  children: ReactNode;
  testId?: string;
  tone?: "default" | "attention";
}) {
  return (
    <section className="flex flex-col gap-1" data-testid={testId}>
      <h2 className="flex items-center gap-2 px-2 text-[12px] font-medium leading-5 text-[var(--dls-text-secondary)]">
        {tone === "attention" ? <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" /> : null}
        {title}
        <span className="tabular-nums text-[var(--dls-text-secondary)]">{count}</span>
      </h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

export function LibraryCompactRow({ href, logo, name, description, source, action, revealAction = true, kind, testName }: {
  href: string;
  logo?: ReactNode;
  name: string;
  description?: ReactNode;
  /** Where it came from: "You", "Everyone", a team. Quiet, right-aligned. */
  source?: ReactNode;
  action?: ReactNode;
  /** Menus appear on hover; a pending action such as Sign in is always shown. */
  revealAction?: boolean;
  kind: string;
  testName: string;
}) {
  return (
    <div
      className="group relative grid min-h-11 grid-cols-[minmax(0,1fr)_5rem] items-center gap-3 rounded-lg px-2 transition-colors duration-150 hover:bg-[var(--dls-hover)] focus-within:bg-[var(--dls-hover)] md:grid-cols-[minmax(0,1fr)_7rem_5rem]"
      data-library-item={testName}
      data-library-kind={kind}
      data-library-integrated-row="true"
    >
      <Link
        href={href}
        className="grid min-w-0 items-center gap-3 py-2 outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-gray-300 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
      >
        <span className="flex min-w-0 items-center gap-3" data-library-name>
          {/* Every row keeps the same icon slot, so names and columns line up across kinds. */}
          <span className="flex size-6 shrink-0 items-center justify-center">{logo}</span>
          <span className="min-w-0 truncate text-[13px] font-medium leading-5 text-[var(--dls-text-primary)]">{name}</span>
        </span>
        <span className="hidden min-w-0 truncate text-[13px] leading-5 text-[var(--dls-text-secondary)] sm:block" data-library-description>{description}</span>
      </Link>
      <span className="relative hidden min-w-0 truncate text-right text-[12px] text-[var(--dls-text-secondary)] md:block" data-library-source>{source}</span>
      <span
        className={`relative flex min-w-0 justify-end ${revealAction ? "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 [@media(hover:none)]:opacity-100" : ""}`}
        data-item-action
      >
        {action}
      </span>
    </div>
  );
}

export function LibraryCompactSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} data-testid="item-rows-skeleton" className="flex flex-col gap-1 motion-safe:animate-pulse">
      <span aria-hidden className="flex h-5 items-center px-2"><span className="h-2.5 w-20 rounded bg-gray-100" /></span>
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} aria-hidden className="flex h-11 items-center gap-3 px-2">
          <span className="h-3 w-32 rounded bg-gray-100" />
          <span className="hidden h-3 w-64 rounded bg-gray-100 sm:block" />
        </div>
      ))}
    </div>
  );
}

/** A quiet icon in the same 24px tile as a connector logo, for items without a brand mark. */
export function LibraryKindIcon({ kind }: { kind: "skill" | "plugin" | "workflow" }) {
  const Icon = kind === "skill" ? FileText : kind === "plugin" ? Package : Workflow;
  return (
    <span aria-hidden className="flex size-6 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500">
      <Icon className="size-3.5" strokeWidth={1.75} />
    </span>
  );
}
