"use client";

import type { ComponentProps, ReactNode } from "react";
import { hairline, secondaryText } from "../_features/computers/computer-parts";
import { ListRow } from "../_features/computers/computer-rows";

/*
 * Gateway-specific lane widths and leading marks. Row anatomy, links, ARIA and
 * control layering belong to the shared ListRow (DESIGN.md P5, S2).
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
export function GatewayRow({ lead, stretch = false, ...props }: Omit<ComponentProps<typeof ListRow>, "icon" | "lead"> & { lead: ReactNode }) {
  return <ListRow {...props} lead={<span className="flex size-8 shrink-0 items-center justify-center">{lead}</span>} stretch={stretch} />;
}

/** The quiet line under a list: an empty filter, nothing yet. */
export function RowListNote({ children }: { children: ReactNode }) {
  return <p role="status" className={`border-b ${hairline} py-4 text-[13px] ${secondaryText}`}>{children}</p>;
}
