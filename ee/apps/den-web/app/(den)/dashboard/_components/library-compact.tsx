"use client";

import { FileText, Package, Workflow } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { hairline, secondaryText } from "../_features/computers/computer-parts";
import { ROW_CLASS, ROW_NAME_CLASS, ROW_SECOND_LINE_CLASS, RowListSkeleton, RowTile } from "../_features/computers/computer-rows";

/**
 * My Library and Connectors lists: the same rows as every other list (a 32px
 * lead, the name over one muted line, where it came from on the right, then
 * one control), grouped under headings by kind. What is their own is the
 * grouping; the rows are not.
 */

/** The groups of a list, straight on the page like every other list. */
export function LibraryCompactSurface({ children, testId }: { children: ReactNode; testId?: string }) {
  return <div className="flex flex-col gap-6" data-testid={testId}>{children}</div>;
}

export function LibraryCompactSection({ title, count, children, testId, tone = "default" }: {
  title: string;
  count: number;
  children: ReactNode;
  testId?: string;
  tone?: "default" | "attention";
}) {
  return (
    <section className="flex flex-col" data-testid={testId}>
      <h2 className={`flex items-center gap-2 border-b ${hairline} pb-1.5 text-[13px] font-medium leading-5 text-[var(--dls-text-primary)]`}>
        {tone === "attention" ? <span className="h-1.5 w-1.5 rounded-full bg-[var(--ow-warning)]" aria-hidden="true" /> : null}
        {title}
        <span className={`text-[12px] font-normal tabular-nums ${secondaryText}`}>{count}</span>
      </h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

export function LibraryCompactRow({ href, logo, name, description, source, action, kind, testName }: {
  href: string;
  logo?: ReactNode;
  name: string;
  description?: ReactNode;
  /** Where it came from: "You", "Everyone", a team. Quiet, in its own lane. */
  source?: ReactNode;
  action?: ReactNode;
  /** Kept for callers: the row's control is always shown, as on every other list. */
  revealAction?: boolean;
  kind: string;
  testName: string;
}) {
  return (
    <div className={`group relative ${ROW_CLASS}`} data-library-item={testName} data-library-kind={kind} data-library-integrated-row="true">
      {/*
        The whole row opens the item; its control keeps its own press. The name
        and its line keep a 520px measure (about 70 characters), so who has it
        sits beside the name instead of across the page.
      */}
      <Link href={href} className="flex min-w-0 max-w-[520px] flex-1 items-center gap-3 outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:outline-[var(--dls-text-secondary)]">
        {/* Every row keeps the same 32px lead, so names line up across kinds. */}
        <span className="flex size-8 shrink-0 items-center justify-center">{logo}</span>
        <span className="min-w-0 flex-1">
          <span className={`${ROW_NAME_CLASS} group-hover:underline`} data-library-name>{name}</span>
          {description ? <span className={`block ${ROW_SECOND_LINE_CLASS}`} data-library-description>{description}</span> : null}
        </span>
      </Link>
      <span className={`hidden w-40 shrink-0 truncate text-[13px] leading-5 md:block ${secondaryText}`} data-library-source>{source}</span>
      <span className="relative ml-auto flex min-w-7 shrink-0 justify-end" data-item-action>{action}</span>
    </div>
  );
}

export function LibraryCompactSkeleton({ label }: { label: string }) {
  return <div role="status" aria-label={label} data-testid="item-rows-skeleton"><RowListSkeleton rows={4} /></div>;
}

/** A quiet icon in the same 32px tile as every list, for items without a brand mark. */
export function LibraryKindIcon({ kind }: { kind: "skill" | "plugin" | "workflow" }) {
  return <RowTile icon={kind === "skill" ? FileText : kind === "plugin" ? Package : Workflow} />;
}
