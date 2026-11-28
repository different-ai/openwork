"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { DenButton } from "../../../_components/ui/button";
import { DenPageHeader } from "../../../_components/ui/page-header";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { AddComputerDialog } from "./computer-action-controls";
import { RefreshButton, hairline, secondaryText } from "./computer-parts";
import { absoluteTime, devicePageCount } from "./computers-format";

export const inventoryText = "text-[length:var(--den-inventory-text)] leading-5 text-[var(--dls-text-primary)] [--den-inventory-text:0.8125rem]";

export function InventoryHeader({ title, state, refreshing, onRefresh }: { title: string; state?: string | null; refreshing: boolean; onRefresh: () => void }) {
  const [adding, setAdding] = useState(false);
  return <>
    <DenPageHeader size="compact" title={title} className="mb-6" state={state === null ? <DenSkeleton className="mt-1 h-3 w-24" /> : state}
      action={<div className="flex items-center gap-1">
        <RefreshButton refreshing={refreshing} onRefresh={onRefresh} testId="computers-refresh" />
        <DenButton size="sm" variant="secondary" icon={Plus} aria-label="Add a computer" data-testid="computers-add" onClick={() => setAdding(true)}>
          <span className="hidden sm:inline">Add a computer</span>
        </DenButton>
      </div>} />
    <AddComputerDialog open={adding} onClose={() => setAdding(false)} />
  </>;
}

export function InventoryError({ message, stale, checkedAt, onRetry }: { message: string; stale?: string; checkedAt?: number; onRetry: () => void }) {
  const checked = stale && checkedAt ? new Date(checkedAt).toISOString() : null;
  return <div role="alert" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
    <p>{message}{stale ? ` ${stale}` : ""}{checked ? <> Last checked <time dateTime={checked}>{absoluteTime(checked)}</time>.</> : null}</p>
    <DenButton variant="secondary" size="sm" onClick={onRetry}>Try again</DenButton>
  </div>;
}

export function InventoryEmpty({ children }: { children: string }) {
  return <p className={`border-y py-6 ${hairline} ${secondaryText}`}>{children}</p>;
}

export function InventoryRulesSkeleton() {
  return <DenSkeleton className="mb-4 h-4 w-full max-w-xl" />;
}

export function InventoryOlder({ hidden, shown, onToggle }: { hidden: number; shown: boolean; onToggle: () => void }) {
  if (!shown && hidden === 0) return null;
  return <div className={`mt-2 flex flex-wrap items-center gap-x-2 text-xs ${secondaryText}`} data-testid="computer-inventory-older">
    <span>{shown ? "Showing computers not heard from in the last week." : `${hidden.toLocaleString("en-US")} not heard from in the last week.`}</span>
    <DenButton variant="ghost" size="inline" aria-expanded={shown} onClick={onToggle}>{shown ? "Hide" : "Show older"}</DenButton>
  </div>;
}

export function InventoryPagination({ page, pageSize, total, busy, onPage }: { page: number; pageSize: number; total: number; busy: boolean; onPage: (page: number) => void }) {
  const pages = devicePageCount(total, pageSize);
  if (page === 1 && pages <= 1) return null;
  return <nav aria-label="Computer pages" className={`mt-4 flex flex-wrap items-center justify-end gap-3 text-xs ${secondaryText}`}>
    <span>Page {page} of {pages}</span>
    <DenButton size="sm" variant="secondary" disabled={busy || page <= 1} onClick={() => onPage(Math.min(page - 1, pages))}>Previous</DenButton>
    <DenButton size="sm" variant="secondary" disabled={busy || page >= pages} onClick={() => onPage(page + 1)}>Next</DenButton>
  </nav>;
}
