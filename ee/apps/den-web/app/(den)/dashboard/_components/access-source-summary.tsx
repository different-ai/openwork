"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { DenButton } from "../../_components/ui/button";

/** Compact, keyboard-accessible disclosure; long names are never available only on hover. */
export function AccessSummary({ items, label, empty = "None", preview = "first" }: { items: readonly string[]; label: string; empty?: string; preview?: "first" | "count" }) {
  const [page, setPage] = useState(0);
  const names = items.filter(Boolean);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(names.length / 20) - 1));
  if (names.length < 2) return <span className="break-words">{names[0] ?? empty}</span>;
  return <details className="group min-w-0 text-left" data-testid="access-summary">
    <summary data-testid="access-summary-trigger" aria-label={`${label}: ${names.length} sources`} className="flex min-w-0 cursor-pointer list-none items-start gap-1 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400 [&::-webkit-details-marker]:hidden">
      <ChevronRight className="mt-0.5 size-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
      <span className="min-w-0 break-words">{preview === "count" ? `${names.length} access sources` : <>{names[0]} <span className="whitespace-nowrap text-gray-500">+{names.length - 1}</span></>}</span>
    </summary>
    <ul className="mt-1 grid gap-1 pl-4 text-[12px] text-gray-500" aria-label={label}>{names.slice(currentPage * 20, (currentPage + 1) * 20).map((name, index) => <li key={`${currentPage}-${index}-${name}`} className="break-words">{name}</li>)}</ul>
    {names.length > 20 ? <div className="mt-2 flex flex-wrap items-center gap-1 text-[12px]"><span>{currentPage * 20 + 1}–{Math.min((currentPage + 1) * 20, names.length)} of {names.length}</span><DenButton size="xs" variant="ghost" disabled={currentPage === 0} aria-label={`Previous ${label}`} onClick={() => setPage(currentPage - 1)}>Previous</DenButton><DenButton size="xs" variant="ghost" disabled={(currentPage + 1) * 20 >= names.length} aria-label={`Next ${label}`} onClick={() => setPage(currentPage + 1)}>Next</DenButton></div> : null}
  </details>;
}
