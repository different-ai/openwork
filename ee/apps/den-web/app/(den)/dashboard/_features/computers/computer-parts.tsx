"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { absoluteTime, relativeTime, type DeviceTone } from "./computers-format";

export const secondaryText = "text-[color:var(--dls-text-secondary)]";
export const hairline = "border-[var(--dls-border)]";
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
