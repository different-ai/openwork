"use client";

import type { ReactNode } from "react";
import { FilterInput } from "./item-list";

/** The same collection toolbar on every Members tab. Secondary actions stay quiet. */
export function MemberListToolbar({ collection, value, onChange, action, secondary }: {
  collection: "members" | "teams" | "roles";
  value: string;
  onChange: (value: string) => void;
  /** Only where the page header does not hold the create action. */
  action?: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3" data-testid={`${collection}-toolbar`}>
      <FilterInput className="w-64 max-w-[60%]" placeholder={`Filter ${collection}`} value={value} onChange={onChange} />
      <div className="flex shrink-0 items-center gap-2">{secondary}{action}</div>
    </div>
  );
}
