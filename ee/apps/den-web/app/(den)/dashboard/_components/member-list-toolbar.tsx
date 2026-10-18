"use client";

import type { ReactNode } from "react";
import { FilterInput } from "./item-list";

/** The same collection toolbar on every Members tab. Secondary actions stay quiet. */
export function MemberListToolbar({ collection, value, onChange, action, secondary }: {
  collection: "members" | "teams" | "roles";
  value: string;
  onChange: (value: string) => void;
  action: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 sm:flex-nowrap" data-testid={`${collection}-toolbar`}>
      <FilterInput className="w-full min-w-0 sm:w-56 sm:max-w-[50%]" placeholder={`Filter ${collection}`} value={value} onChange={onChange} />
      <div className="flex shrink-0 items-center gap-2">{secondary}{action}</div>
    </div>
  );
}
