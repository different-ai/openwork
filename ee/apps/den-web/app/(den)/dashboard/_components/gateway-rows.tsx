"use client";

import type { ComponentProps, ReactNode } from "react";
import { hairline, secondaryText } from "../_features/computers/computer-parts";
import { ListRow } from "../_features/computers/computer-rows";

export const GATEWAY_LANE = {
  models: "hidden w-24 @2xl:block",
  audience: "hidden w-56 @3xl:block @5xl:w-72",
  status: "flex w-28",
  open: "flex w-[76px] justify-end",
  canUse: "hidden w-[132px] @3xl:flex",
  limit: "hidden w-48 @2xl:flex",
  spend: "w-24 text-right tabular-nums",
  limitProvider: "hidden w-36 @3xl:flex",
  limitAmount: "hidden w-48 @2xl:block",
  limitAction: "hidden w-28 @4xl:block",
  limitEdit: "flex w-[124px] justify-end",
  keyMember: "hidden w-52 @2xl:flex",
  keyDate: "hidden w-28 @3xl:block",
  share: "hidden w-28 @md:flex",
  amount: "w-20 text-right tabular-nums",
  reason: "w-40 @3xl:w-64",
  requested: "hidden w-28 @2xl:block",
  decision: "hidden w-44 @4xl:flex",
  requestActions: "flex w-[188px] justify-end",
} as const;

export function InitialsTile({ children }: { children: ReactNode }) {
  return <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--dls-hover)] text-[11px] font-semibold uppercase text-[color:var(--dls-text-primary)]">{children}</span>;
}

export function GatewayRow({ lead, stretch = false, ...props }: Omit<ComponentProps<typeof ListRow>, "icon" | "lead"> & { lead: ReactNode }) {
  return <ListRow {...props} lead={<span className="flex size-8 shrink-0 items-center justify-center">{lead}</span>} stretch={stretch} />;
}

export function RowListNote({ children }: { children: ReactNode }) {
  return <p role="status" className={`border-b ${hairline} py-4 text-[13px] ${secondaryText}`}>{children}</p>;
}
