"use client";

import { Popover } from "@base-ui/react/popover";
import { Monitor } from "lucide-react";
import { AppMark } from "./files";
import { connectorNames, type ConnectorApp, type ConnectorSummary } from "./connector-activity";

/** Shared Apps-tab brand resolver; a letter only after all real-logo candidates fail. */
export function ConnectorIcon({ app, size = 14 }: { app: ConnectorApp; size?: number }) {
  if (app.remote) return <Monitor size={size} strokeWidth={1.75} aria-hidden className="shrink-0 text-[var(--wb-muted)]" />;
  return <AppMark name={app.name ?? "App"} site={app.site} size={size} fallback="letter" />;
}

const VISIBLE_LOGOS = 5;

/**
 * An avatar group, not another status sentence: one round logo per connector, in first-use order (P3, T1, P11).
 * Only the current connector's ring breathes; completion leaves the same static group in place. Hover, focus or tap
 * reveals names, and a further tap on Tool details reveals what ran. The disclosure floats outside the transcript,
 * so inspecting it never changes the conversation's height or scroll position. Real logos keep a white canvas (some
 * are black); their separating ring follows the chat background, including dark hosts.
 */
export function ConnectorLine({ summary }: { summary: ConnectorSummary }) {
  const shown = summary.apps.slice(0, VISIBLE_LOGOS);
  const more = summary.apps.length - shown.length;
  const names = `Used ${connectorNames(summary.apps)}`;
  return (
    <div className="flex h-7 items-center" data-workbot-connector-line={summary.live ? "live" : "done"}>
      <Popover.Root>
        <Popover.Trigger openOnHover delay={350} closeDelay={150} aria-label={names}
          className="relative flex h-7 w-fit items-center rounded-full outline-none focus-visible:shadow-[var(--wb-focus)]" data-workbot-connector-stack>
          <span aria-hidden className="flex items-center -space-x-[7px]">
            {shown.map((app) => {
              const active = summary.live && app.name === summary.latest.name && app.remote === summary.latest.remote;
              return <span key={app.remote ? "remote" : app.name ?? "app"}
                className={`relative grid size-5 shrink-0 place-items-center overflow-hidden rounded-full bg-white [--wb-muted:#687076] ring-2 ring-[var(--wb-bg)] ${active ? "workbot-connector-pulse" : ""}`}
                data-workbot-connector-logo={app.name ?? "App"} data-active={active || undefined}>
                <ConnectorIcon app={app} size={12} />
              </span>;
            })}
            {more > 0 ? <span className={`relative grid size-5 shrink-0 place-items-center rounded-full bg-[var(--wb-chip)] text-[9px] font-medium tabular-nums text-[var(--wb-muted)] ring-2 ring-[var(--wb-bg)] ${summary.live && !shown.some((app) => app.name === summary.latest.name && app.remote === summary.latest.remote) ? "workbot-connector-pulse" : ""}`} data-workbot-connector-more>+{more}</span> : null}
          </span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={6} collisionPadding={12} className="z-50">
            <Popover.Popup initialFocus={false} className="workbot max-w-[min(20rem,calc(100vw-24px))] rounded-lg bg-[var(--wb-surface)] px-3 py-2 text-[12px] leading-5 text-[var(--wb-muted)] shadow-[var(--wb-panel-shadow)] outline-none" data-workbot-connector-popover>
              <Popover.Title className="font-medium text-[var(--wb-text)]">{names}</Popover.Title>
              <details className="mt-1" data-workbot-connector-details>
                <summary className="w-fit cursor-pointer rounded-sm text-[11px] text-[var(--wb-muted)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">Tool details</summary>
                <ul aria-label="What was used" className="mt-1 flex max-h-48 flex-col gap-1 overflow-y-auto" data-workbot-connector-rows>
                  {summary.rows.map((row) => <li key={row.key} className="flex min-w-0 items-start gap-1.5">
                    <span aria-hidden className="mt-1 grid size-3 shrink-0 place-items-center"><ConnectorIcon app={row.app} size={12} /></span>
                    <span className="min-w-0">{row.app.name ?? "Connected app"}{row.detail ? <span className="text-[var(--wb-faint)]"> · {row.detail}</span> : null}{row.times > 1 ? <span className="tabular-nums text-[var(--wb-faint)]"> ×{row.times}</span> : null}</span>
                  </li>)}
                </ul>
              </details>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
