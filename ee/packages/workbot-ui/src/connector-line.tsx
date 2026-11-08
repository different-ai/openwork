"use client";

import { ChevronDown, Monitor } from "lucide-react";
import { useId, useState } from "react";
import { AppMark } from "./files";
import type { ConnectorApp, ConnectorSummary } from "./connector-activity";

/** The app's logo; a plug when it has none we can find; a screen for another of the person's computers. */
export function ConnectorIcon({ app, size = 14 }: { app: ConnectorApp; size?: number }) {
  if (app.remote) return <Monitor size={size} strokeWidth={1.75} aria-hidden className="shrink-0 text-[var(--wb-muted)]" />;
  return <AppMark name={app.name ?? ""} site={app.site} size={size} fallback="plug" />;
}

/**
 * One quiet line under Workbot's answer for its work in connected apps (DESIGN C3, T1): while it works, the app's
 * logo and what it is doing ("Searching Exa… · 2 searches"), shimmering; once it has moved on, the same place keeps a
 * footnote ("Used Exa · 2 searches") that opens the list of what ran. One line tall in both, so settling never moves
 * the conversation. No card, no buttons beyond the footnote itself.
 */
export function ConnectorLine({ summary }: { summary: ConnectorSummary }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (summary.live) {
    return (
      <p className="workbot-row-enter flex h-7 min-w-0 items-center gap-1.5 pl-1 text-[12.5px] leading-4 text-[var(--wb-muted)]" role="status" aria-live="polite" data-workbot-connector-line="live">
        <span aria-hidden className="workbot-app-enter grid size-4 shrink-0 place-items-center"><ConnectorIcon app={summary.latest} /></span>
        <span key={summary.label} className="workbot-shimmer min-w-0 truncate">{summary.label}…</span>
        {summary.count ? <span className="shrink-0 tabular-nums">· {summary.count}</span> : null}
      </p>
    );
  }
  const shown = summary.apps.slice(0, 3);
  return (
    <div className="flex flex-col" data-workbot-connector-line="done">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={listId}
        className="group/used flex h-7 w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md pl-1 pr-1.5 text-[12px] leading-4 text-[var(--wb-faint)] transition-colors duration-150 hover:text-[var(--wb-muted)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
      >
        <span aria-hidden className="flex shrink-0 items-center gap-1">
          {shown.map((app) => <span key={app.remote ? "remote" : app.name ?? "app"} className="grid size-4 place-items-center opacity-80 group-hover/used:opacity-100"><ConnectorIcon app={app} /></span>)}
        </span>
        <span className="min-w-0 truncate">{summary.label}</span>
        {summary.count ? <span className="shrink-0 tabular-nums">· {summary.count}</span> : null}
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden className={`shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <ul id={listId} aria-label="What was used" className="workbot-row-enter flex flex-col gap-0.5 pb-1 pl-1 pt-0.5" data-workbot-connector-rows>
          {summary.rows.map((row) => (
            <li key={row.key} className="flex min-w-0 items-center gap-1.5 text-[12px] leading-5 text-[var(--wb-muted)]">
              <span aria-hidden className="grid size-4 shrink-0 place-items-center"><ConnectorIcon app={row.app} size={12} /></span>
              <span className="shrink-0">{row.label}</span>
              {row.detail ? <span className="min-w-0 truncate text-[var(--wb-faint)]">· {row.detail}</span> : null}
              {row.times > 1 ? <span className="shrink-0 tabular-nums text-[var(--wb-faint)]">×{row.times}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
