import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import type { StatusTone } from "@/lib/connection-words";
import { StatusDot } from "@/ui/kit";

/**
 * The one row the navigable panel uses everywhere: an icon, a title, one
 * status line (two lines at most when narrow), a count, and a chevron. Rows
 * are buttons inside a list; arrow keys move between them, Enter opens.
 */
export function RowList({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  const listRef = useRef<HTMLUListElement>(null);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-row-id]:not([disabled])') ?? [])];
    if (rows.length === 0) return;
    const index = rows.findIndex((row) => row === document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    const next = event.key === "ArrowDown" ? Math.min(rows.length - 1, index + 1)
      : event.key === "ArrowUp" ? Math.max(0, index - 1)
        : event.key === "Home" ? 0 : rows.length - 1;
    rows[next]?.focus();
  }, []);
  return (
    <ul ref={listRef} role="list" aria-label={label} className="-mx-1" onKeyDown={onKeyDown} data-testid={testId}>
      {children}
    </ul>
  );
}

export function Row({
  id,
  icon,
  title,
  status,
  tone,
  count,
  onOpen,
  testId,
  chevron = true,
  disabled = false,
}: {
  /** Stable within its list; Back returns focus here. */
  id: string;
  icon: ReactNode;
  title: string;
  /** One line of state or source; wraps to two lines at most. */
  status?: string;
  tone?: StatusTone;
  count?: number | null;
  onOpen: () => void;
  testId?: string;
  chevron?: boolean;
  disabled?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        className="group flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-white/[0.04] focus-visible:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 disabled:cursor-default disabled:opacity-60"
        onClick={onOpen}
        disabled={disabled}
        data-row-id={id}
        data-testid={testId}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-panel text-mist" aria-hidden="true">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-snow">{title}</span>
          {status ? (
            <span className="mt-0.5 flex items-start gap-1.5 text-[11px] leading-snug text-mist">
              {tone ? <span className="mt-[5px] shrink-0"><StatusDot tone={tone} /></span> : null}
              <span className="line-clamp-2">{status}</span>
            </span>
          ) : null}
        </span>
        {typeof count === "number" ? <span className="shrink-0 text-[11px] tabular-nums text-mist">{count}</span> : null}
        {chevron ? <span className="shrink-0 text-mist transition-colors group-hover:text-snow" aria-hidden="true">›</span> : null}
      </button>
    </li>
  );
}

/** A quiet line for an empty level. */
export function QuietLine({ children, testId }: { children: ReactNode; testId?: string }) {
  return <p className="px-1 py-3 text-xs leading-relaxed text-mist" data-testid={testId}>{children}</p>;
}

/** Rows still arriving: the shape of the list, nothing spinning. */
export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <ul aria-hidden="true" className="-mx-1" data-testid="skeleton-rows">
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className="flex items-center gap-3 px-2 py-2.5">
          <span className="size-8 shrink-0 rounded-lg bg-white/[0.05]" />
          <span className="min-w-0 flex-1 space-y-1.5">
            <span className="block h-3 w-2/3 rounded bg-white/[0.06]" />
            <span className="block h-2.5 w-1/3 rounded bg-white/[0.04]" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A small uppercase label above a group of rows. */
export function GroupLabel({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="mb-1 flex items-center justify-between gap-3 px-1 pt-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">{children}</h3>
      {typeof count === "number" ? <span className="text-[10px] tabular-nums text-mist">{count}</span> : null}
    </div>
  );
}

/** A labelled everyday fact on a detail screen. */
export function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-start gap-3 py-2" data-testid={testId}>
      <span className="w-20 shrink-0 pt-px text-[11px] text-mist">{label}</span>
      <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-snow [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

/** The fold that keeps identifiers and raw errors out of the everyday copy. */
export function TechnicalDetails({ entries }: { entries: Array<{ label: string; value: string }> }) {
  const shown = entries.filter((entry) => entry.value.trim());
  if (shown.length === 0) return null;
  return (
    <details className="group border-t border-line/60 pt-2 text-[11px] text-mist" data-testid="technical-details">
      <summary className="cursor-pointer select-none py-1 font-medium hover:text-snow">Technical details</summary>
      <dl className="mt-1 space-y-1.5 pb-1">
        {shown.map((entry) => (
          <div key={entry.label} className="flex items-start gap-3">
            <dt className="w-20 shrink-0 text-mist/80">{entry.label}</dt>
            <dd className="min-w-0 flex-1 break-all font-mono text-[10.5px] text-mist">{entry.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** Give focus back to the row a level was opened from, once it is on screen again. */
export function useReturnFocus(focus: { id: string; at: number } | null, container: HTMLElement | null): void {
  useEffect(() => {
    if (!focus || !container) return;
    const row = container.querySelector<HTMLElement>(`button[data-row-id="${focus.id.replaceAll('"', '\\"')}"]`);
    row?.focus({ preventScroll: false });
  }, [container, focus]);
}
