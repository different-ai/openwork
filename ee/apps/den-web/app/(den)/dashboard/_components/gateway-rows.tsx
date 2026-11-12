"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { focusRing, hairline, secondaryText } from "../_features/computers/computer-parts";

/*
 * AI Gateway rows: the Computers row (`ListRow`) for lists whose leading tile is
 * a brand mark or a person's initials, which `ListRow`'s icon tile cannot carry.
 * Same anatomy: flat on the page, a hairline under each row, a 32px lead, a
 * 13px name over one 12px muted line, fixed 13px lanes, then one control.
 * Use them inside `RowList` with `RowListHeader`/`RowLaneLabel` lanes.
 */

/** Lane widths for the Gateway lists. Literal classes, so Tailwind generates each one. */
export const GATEWAY_LANE = {
  /** A provider's model count. */
  models: "hidden w-24 @2xl:block",
  /** Who can use a provider or router. */
  audience: "hidden w-56 @3xl:block @5xl:w-72",
  /** A dot and a word. */
  status: "flex w-28",
  /** Manage or Set up. */
  open: "flex w-[76px] justify-end",
  /** The providers someone can use, as marks. */
  canUse: "hidden w-[132px] @3xl:flex",
  /** A limit and where it comes from. */
  limit: "hidden w-48 @2xl:flex",
  /** Spend over the last 31 days. */
  spend: "w-24 text-right tabular-nums",
  /** A spend limit's provider. */
  limitProvider: "hidden w-36 @3xl:flex",
  /** A spend limit's amounts. */
  limitAmount: "hidden w-48 @2xl:block",
  /** What happens at the limit. */
  limitAction: "hidden w-28 @4xl:block",
  /** Edit or Choose provider. */
  limitEdit: "flex w-[124px] justify-end",
  /** A key's owner. */
  keyMember: "hidden w-52 @2xl:flex",
  /** A date on a key. */
  keyDate: "hidden w-28 @3xl:block",
  /** A share bar and its words, in a spend summary. */
  share: "hidden w-28 @md:flex",
  /** An amount in a spend summary. */
  amount: "w-20 text-right tabular-nums",
  /** An increase request's reason. */
  reason: "w-40 @3xl:w-64",
  /** When a request was made. */
  requested: "hidden w-28 @2xl:block",
  /** A request's decision, in history. */
  decision: "hidden w-44 @4xl:flex",
  /** Approve and Deny. */
  requestActions: "flex w-[188px] justify-end",
} as const;

/** The 32px lead for a person: their initials on the quiet tile. */
export function InitialsTile({ children }: { children: ReactNode }) {
  return <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--dls-hover)] text-[11px] font-semibold uppercase text-[color:var(--dls-text-primary)]">{children}</span>;
}

/**
 * One row. `href` makes the name a link; `stretch` lets the whole row open it,
 * as a Gateway directory row did before it was flat.
 */
export function GatewayRow({ lead, name, href, scroll, stretch = false, badge, secondLine, lanes, below, testId, rowTestId, rowData, linkLabel }: {
  lead: ReactNode;
  name: ReactNode;
  href?: string;
  /** Passed to the link, as `Link`'s own `scroll`. */
  scroll?: boolean;
  stretch?: boolean;
  badge?: ReactNode;
  secondLine?: ReactNode;
  lanes?: ReactNode;
  /** A line across the row, under it. */
  below?: ReactNode;
  testId?: string;
  rowTestId?: string;
  /** data-* attributes on the row. */
  rowData?: Record<`data-${string}`, string | undefined>;
  linkLabel?: string;
}) {
  const nameClass = "block max-w-full truncate text-left text-[13px] font-medium leading-5 text-[color:var(--dls-text-primary)]";
  const title = typeof name === "string" ? name : undefined;
  return (
    <div role="row" data-testid={rowTestId} {...rowData}
      className={`group flex min-h-[49px] flex-wrap items-center gap-x-3 gap-y-0.5 border-b ${hairline} py-1.5 ${stretch && href ? "relative" : ""}`}>
      <div role="cell" className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center">{lead}</span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {href
              ? <Link href={href} scroll={scroll} aria-label={linkLabel} data-testid={testId} title={title}
                  className={`${nameClass} rounded-sm hover:underline ${focusRing} ${stretch ? "after:absolute after:inset-0 after:content-['']" : ""}`}>{name}</Link>
              : <span data-testid={testId} title={title} className={nameClass}>{name}</span>}
            {badge}
          </div>
          {secondLine ? <p className={`truncate text-[12px] leading-4 ${secondaryText}`}>{secondLine}</p> : null}
        </div>
      </div>
      {lanes}
      {below}
    </div>
  );
}

/** The quiet line under a list: an empty filter, nothing yet. */
export function RowListNote({ children }: { children: ReactNode }) {
  return <p role="status" className={`border-b ${hairline} py-4 text-[13px] ${secondaryText}`}>{children}</p>;
}
