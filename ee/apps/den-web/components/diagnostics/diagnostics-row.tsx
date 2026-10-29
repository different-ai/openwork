"use client";

import Link from "next/link";
import { ChevronRight, Lock } from "lucide-react";
import type { ReactNode, SyntheticEvent } from "react";
import { DenBadge } from "../../app/(den)/_components/ui/badge";
import { buttonVariants } from "../../app/(den)/_components/ui/button";
import { DenSkeleton } from "../../app/(den)/_components/ui/skeleton";
import type { DiagnosticsTone } from "./diagnostics-copy";

/**
 * Compact diagnostics rows (DESIGN.md S2, S3): chevron, leading icon or logo,
 * name with a muted sub, a right-aligned metric, one state badge and at most
 * one action. Detail lives in the row's disclosure.
 */

const ROW_GRID = "grid min-h-[46px] text-[13px] leading-[1.5] grid-cols-[16px_20px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-1 py-1.5 sm:grid-cols-[16px_20px_minmax(0,1fr)_minmax(0,170px)_128px_104px]";
const NAME_CLASS = "font-medium text-[var(--dls-text-primary)]";
const MUTED_CLASS = "text-[var(--dls-text-secondary)]";

export function DiagnosticsSection({ id, title, scope, children, testId }: {
  id: string;
  title: string;
  scope?: string | null;
  children: ReactNode;
  testId?: string;
}) {
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} data-testid={testId} className="mt-[30px] min-w-0">
      <h2 id={headingId} className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-[13px] font-semibold text-[var(--dls-text-primary)]">
        {title}
        {scope ? <span className={`text-xs font-normal ${MUTED_CLASS}`}>{scope}</span> : null}
      </h2>
      <ul className="min-w-0 border-t border-[var(--dls-border)]">{children}</ul>
    </section>
  );
}

export function DiagnosticsLead({ children }: { children: ReactNode }) {
  return <span aria-hidden="true" className={`grid size-5 place-items-center ${MUTED_CLASS}`}>{children}</span>;
}

export function DiagnosticsBadge({ tone, children }: { tone: DiagnosticsTone; children: ReactNode }) {
  return <DenBadge tone={tone} className="max-w-full truncate">{children}</DenBadge>;
}

export type DiagnosticsRowAction = { label: string; href: string };

function RowAction({ action }: { action: DiagnosticsRowAction }) {
  return <Link href={action.href} prefetch={false} className={buttonVariants({ variant: "secondary", size: "sm" })}>{action.label}</Link>;
}

function NameCell({ name, sub, metric, wrap = false, className = "" }: { name: ReactNode; sub?: ReactNode; metric?: ReactNode; wrap?: boolean; className?: string }) {
  // Rows with a metric truncate to keep lanes aligned; plain rows wrap so a lock reason is never cut off.
  const text = wrap ? "[overflow-wrap:anywhere]" : "truncate";
  return (
    <span className={`min-w-0 ${className}`}>
      <span className={`flex min-w-0 items-baseline gap-x-2 ${wrap ? "flex-wrap" : ""}`}>
        <span className={`${text} ${NAME_CLASS}`}>{name}</span>
        {sub ? <span className={`${text} text-xs ${MUTED_CLASS}`}>{sub}</span> : null}
      </span>
      {metric ? <span className={`block truncate text-xs tabular-nums sm:hidden ${MUTED_CLASS}`}>{metric}</span> : null}
    </span>
  );
}

function MetricCell({ metric }: { metric?: ReactNode }) {
  return <span className={`hidden truncate text-right tabular-nums sm:block ${MUTED_CLASS}`}>{metric}</span>;
}

/** An expandable row. `id` is the anchor attention links open and scroll to. */
export function DiagnosticsRow({ id, lead, name, sub, metric, state, action, children, testId, detailsTestId, summaryTestId, stateTestId, onToggle }: {
  id?: string;
  lead: ReactNode;
  name: ReactNode;
  sub?: ReactNode;
  metric?: ReactNode;
  state?: ReactNode;
  action?: DiagnosticsRowAction | null;
  children: ReactNode;
  testId?: string;
  detailsTestId?: string;
  summaryTestId?: string;
  stateTestId?: string;
  onToggle?: (open: boolean) => void;
}) {
  const toggle = onToggle ? (event: SyntheticEvent<HTMLDetailsElement>) => onToggle(event.currentTarget.open) : undefined;
  return (
    <li data-testid={testId} className="relative min-w-0 border-b border-[var(--dls-border)]">
      <details id={id} data-testid={detailsTestId} className="group min-w-0 scroll-mt-24" onToggle={toggle}>
        <summary data-testid={summaryTestId} className={`${ROW_GRID} cursor-pointer list-none rounded-md hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dls-text-primary)] [&::-webkit-details-marker]:hidden`}>
          <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" className={`shrink-0 transition-transform duration-150 ease-[cubic-bezier(.2,.8,.2,1)] group-open:rotate-90 motion-reduce:transition-none ${MUTED_CLASS}`} />
          {lead}
          <NameCell name={name} sub={sub} metric={metric} />
          <MetricCell metric={metric} />
          <span data-testid={stateTestId} className="flex min-w-0 justify-end">{state}</span>
          {/* Reserves the action lane so rows line up; the action itself sits outside the summary. */}
          <span aria-hidden="true" className="hidden sm:block" />
        </summary>
        <div className="min-w-0 pb-4 pl-[60px] pr-1 pt-1 text-xs leading-[1.5]">{children}</div>
      </details>
      {action ? (
        <span className="flex justify-end px-1 pb-2 sm:absolute sm:right-1 sm:top-[7px] sm:p-0">
          <RowAction action={action} />
        </span>
      ) : null}
    </li>
  );
}

/** A row with nothing to expand: empty states and the managed installation row. */
export function DiagnosticsPlainRow({ lead, name, sub, action, state, testId }: {
  lead: ReactNode;
  name: ReactNode;
  sub?: ReactNode;
  action?: DiagnosticsRowAction | null;
  state?: ReactNode;
  testId?: string;
}) {
  return (
    <li data-testid={testId} className={`${ROW_GRID} min-w-0 border-b border-[var(--dls-border)]`}>
      <span aria-hidden="true" />
      {lead}
      {/* Nothing to measure: the name takes the metric lane, and the state lane too when there is no state. */}
      <NameCell name={name} sub={sub} wrap className={state ? "sm:col-span-2" : "col-span-2 sm:col-span-3"} />
      {state ? <span className="flex min-w-0 justify-end">{state}</span> : null}
      {action ? <span className="col-span-full flex justify-end sm:col-span-1"><RowAction action={action} /></span> : null}
    </li>
  );
}

/** Presence with a lock (DESIGN.md P4, C5): neutral ink, says what is needed and who can grant it. */
export function DiagnosticsLockedRow({ name, sub, testId }: { name: string; sub: string; testId?: string }) {
  return (
    <DiagnosticsPlainRow
      testId={testId}
      lead={<DiagnosticsLead><Lock size={16} strokeWidth={1.5} /></DiagnosticsLead>}
      name={name}
      sub={sub}
    />
  );
}

export type DiagnosticsFact = { label: string; value: ReactNode };

export function DiagnosticsFacts({ facts }: { facts: readonly (DiagnosticsFact | null | false)[] }) {
  const shown = facts.filter((fact): fact is DiagnosticsFact => Boolean(fact));
  if (shown.length === 0) return null;
  return (
    <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1.5 [overflow-wrap:anywhere] sm:grid-cols-[170px_minmax(0,1fr)]">
      {shown.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className={MUTED_CLASS}>{fact.label}</dt>
          <dd className="mb-1 text-[var(--dls-text-primary)] sm:mb-0">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DiagnosticsCode({ children }: { children: ReactNode }) {
  return <code className="rounded bg-[var(--dls-hover)] px-1 py-px font-mono text-xs">{children}</code>;
}

/** Layout-matching placeholder for a row while the first report loads. */
export function DiagnosticsSkeletonRow() {
  return (
    <li className={`${ROW_GRID} border-b border-[var(--dls-border)]`}>
      <span aria-hidden="true" />
      <DenSkeleton className="size-4" />
      <DenSkeleton className="h-3 w-40 max-w-full" />
      <DenSkeleton className="hidden h-3 w-24 justify-self-end sm:block" />
      <DenSkeleton className="h-5 w-16 justify-self-end rounded-full" />
      <span aria-hidden="true" className="hidden sm:block" />
    </li>
  );
}
