"use client";

import { useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { absoluteTime, relativeTime, type DeviceTone } from "./computers-format";

export const secondaryText = "text-[color:var(--dls-text-secondary)]";
/** One hairline between rows; it follows the dashboard shell so flat lists read the same on a tinted or a white canvas. */
export const hairline = "border-[var(--den-list-line)]";
export const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dls-text-secondary)]";

const DOT_TONE: Record<DeviceTone, string> = {
  success: "bg-[var(--ow-success)]",
  warning: "bg-[var(--ow-warning)]",
  danger: "bg-[var(--ow-danger)]",
  neutral: "bg-[var(--dls-text-secondary)] opacity-50",
};

/** A small state dot. The words beside it carry the meaning; pass `label` when there are none. */
export function StatusDot({ tone, label }: { tone: DeviceTone; label?: string }) {
  return <>
    <span aria-hidden="true" className={`inline-block size-2 shrink-0 rounded-full ${DOT_TONE[tone]}`} />
    {label ? <span className="sr-only">{label}</span> : null}
  </>;
}

/** "2 min ago", with the full date and time on hover. */
export function TimeAgo({ iso, now, className }: { iso: string | null; now: number; className?: string }) {
  if (!iso) return <span className={className}>{relativeTime(null, now)}</span>;
  return <time dateTime={iso} title={absoluteTime(iso)} className={className}>{relativeTime(iso, now)}</time>;
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The value stays selectable when the browser refuses clipboard access.
      setCopied(false);
    }
  }
  return (
    <button type="button" aria-label={copied ? "Copied" : label} title={label} onClick={() => void copy()}
      className={`flex size-7 shrink-0 items-center justify-center rounded-md ${secondaryText} transition-colors hover:bg-[var(--dls-hover)] hover:text-[color:var(--dls-text-primary)] ${focusRing}`}>
      {copied ? <Check size={16} strokeWidth={1.5} aria-hidden="true" /> : <Copy size={16} strokeWidth={1.5} aria-hidden="true" />}
    </button>
  );
}

/** An id an admin pastes elsewhere: monospace, selectable, with a copy button. */
export function CopyableId({ value, label }: { value: string; label: string }) {
  return <>
    <code className="min-w-0 break-all font-mono text-[12px] text-[color:var(--dls-text-primary)]">{value}</code>
    <CopyButton value={value} label={label} />
  </>;
}

/** A person in a row's 32px lead lane: their initials. The name beside it carries the meaning. */
export function PersonLead({ name }: { name: string }) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : (parts[0] ?? "?").slice(0, 2);
  return <span aria-hidden="true" className={`flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--dls-hover)] text-[11px] font-semibold uppercase text-[color:var(--dls-text-primary)]`}>{letters}</span>;
}

/** Reads a page's data again: the one quiet icon button every page header uses. */
export function RefreshButton({ refreshing, onRefresh, testId, label = "Refresh" }: { refreshing: boolean; onRefresh: () => void; testId?: string; label?: string }) {
  return <button type="button" aria-label={label} title={label} aria-busy={refreshing || undefined} onClick={onRefresh} data-testid={testId}
    className={`flex size-8 items-center justify-center rounded-lg ${secondaryText} transition-colors hover:bg-[var(--dls-hover)] hover:text-[color:var(--dls-text-primary)] ${focusRing}`}>
    <RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" className={refreshing ? "motion-safe:animate-spin" : ""} />
  </button>;
}
