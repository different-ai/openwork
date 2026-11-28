"use client";

import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, Cloud, Laptop, Server, Unplug, User, Users, type LucideIcon } from "lucide-react";
import type { RemoteDeviceAccess, RemoteDeviceKind, RemoteDeviceProvider } from "@openwork/types/den/remote-devices";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { StatusDot, TimeAgo, focusRing, hairline, secondaryText } from "./computer-parts";
import { isFormerOwner, ownerEmail, ownerLabel, versionLabel, type ComputerOwner, type DeviceTone } from "./computers-format";
import { REMOTE_ACCESS_LABEL, remoteAccessNote, remoteAccessValue, type RemoteAccessVoice } from "./remote-access";

export const LANE = {
  owner: "hidden w-52 @2xl:flex @5xl:w-60",
  status: "flex w-[120px] @md:w-40 @5xl:w-48",
  teamTime: "hidden w-24 @3xl:block",
  teamVersion: "hidden w-24 @4xl:block",
  instanceVersion: "hidden w-[164px] @4xl:block",
  remoteAccess: "hidden w-52 @2xl:flex",
  time: "hidden w-24 @3xl:block",
  version: "hidden w-24 @4xl:block",
} as const;

const laneBase = "min-w-0 shrink-0 text-[13px] leading-5";

export const ROW_CLASS = `flex min-h-[49px] items-center gap-3 border-b ${hairline} py-1.5`;
export const ROW_NAME_CLASS = "block max-w-full truncate text-left text-[13px] font-medium leading-5 text-[color:var(--dls-text-primary)]";
export const ROW_SECOND_LINE_CLASS = `truncate text-[12px] leading-4 ${secondaryText}`;

export function RowList({ label, header, children, testId, busy }: {
  label: string;
  header?: ReactNode;
  children: ReactNode;
  testId?: string;
  busy?: boolean;
}) {
  return <div role="table" aria-label={label} aria-busy={busy || undefined} data-testid={testId} className="@container min-w-0">
    {header ? <div role="rowgroup">{header}</div> : null}
    <div role="rowgroup">{children}</div>
  </div>;
}

export function RowListHeader({ lead, children, menu = false, chevron = false }: {
  lead: string;
  children?: ReactNode;
  menu?: boolean;
  chevron?: boolean;
}) {
  return <div role="row" className={`flex min-h-8 items-center gap-3 border-b ${hairline} text-[12px] leading-4 ${secondaryText}`}>
    <span role="columnheader" className="min-w-0 flex-1 truncate">{lead}</span>
    {children}
    {menu ? <span role="columnheader" className="w-7 shrink-0"><span className="sr-only">Actions</span></span> : null}
    {chevron ? <span aria-hidden="true" className="hidden w-4 shrink-0 @md:block" /> : null}
  </div>;
}

export function RowLaneLabel({ lane, children }: { lane: string; children: ReactNode }) {
  return <span role="columnheader" className={`min-w-0 shrink-0 truncate ${lane}`}>{children}</span>;
}

export function RowLane({ lane, children, title, className = "" }: { lane: string; children: ReactNode; title?: string; className?: string }) {
  return <div role="cell" title={title} className={`${laneBase} ${lane} ${className}`}>{children}</div>;
}

export function RowTile({ icon: Icon }: { icon: LucideIcon }) {
  return <span aria-hidden="true" className={`flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--dls-hover)] ${secondaryText}`}>
    <Icon size={16} strokeWidth={1.5} />
  </span>;
}

export function computerIcon(device: { kind: RemoteDeviceKind; provider: RemoteDeviceProvider }): LucideIcon {
  if (device.kind === "desktop") return Laptop;
  return device.provider === "workbot" ? Cloud : Server;
}

export type RowToggle = {
  expanded: boolean;
  controls: string;
  onToggle: () => void;
};

export function ListRow({ icon, lead, name, href, scroll, stretch = true, linkLabel, badge, secondLine, wrapSecondLine = false, lanes, below, action, toggle, testId, rowTestId, rowData, children }: {
  icon?: LucideIcon;
  lead?: ReactNode;
  name: ReactNode;
  href?: string;
  scroll?: boolean;
  stretch?: boolean;
  linkLabel?: string;
  badge?: ReactNode;
  secondLine?: ReactNode;
  wrapSecondLine?: boolean;
  lanes?: ReactNode;
  below?: ReactNode;
  action?: ReactNode;
  toggle?: RowToggle;
  testId?: string;
  rowTestId?: string;
  rowData?: Record<`data-${string}`, string | undefined>;
  children?: ReactNode;
}) {
  function rowClick(event: MouseEvent<HTMLDivElement>) {
    if (!toggle) return;
    const target = event.target;
    if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
    if (target.closest("button, a, input, textarea, select, summary, [role=button], [role=checkbox], [role=switch], [contenteditable=true]")) return;
    if (window.getSelection()?.toString()) return;
    toggle.onToggle();
  }
  const nameClass = ROW_NAME_CLASS;
  const title = typeof name === "string" ? name : undefined;
  const stretched = Boolean(href && stretch && !toggle);
  return <>
    <div role="row" data-testid={rowTestId} {...rowData} data-open={toggle?.expanded || undefined} onClick={toggle ? rowClick : undefined}
      className={`group flex min-h-[49px] flex-wrap items-center gap-x-3 gap-y-0.5 border-b ${hairline} py-1.5 ${toggle ? "cursor-pointer" : ""} ${stretched ? "relative isolate [&_:is(button,input,select,textarea,summary,[role=button],[role=checkbox],[role=switch],[contenteditable=true],a:not([data-row-link]))]:relative [&_:is(button,input,select,textarea,summary,[role=button],[role=checkbox],[role=switch],[contenteditable=true],a:not([data-row-link]))]:z-[1]" : ""}`}>
      <div role="cell" className="flex min-w-0 flex-1 items-center gap-3">
        {lead ?? (icon ? <RowTile icon={icon} /> : null)}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {toggle
              ? <button type="button" aria-expanded={toggle.expanded} aria-controls={toggle.controls} onClick={toggle.onToggle} data-testid={testId} title={title}
                  className={`${nameClass} rounded-sm ${focusRing}`}>{name}</button>
              : href ? <Link href={href} scroll={scroll} aria-label={linkLabel} data-row-link="" data-testid={testId} title={title} className={`${nameClass} rounded-sm hover:underline ${stretched ? "group-hover:underline after:absolute after:inset-0 after:z-0 after:content-['']" : ""} ${focusRing}`}>{name}</Link>
                : <span data-testid={testId} title={title} className={nameClass}>{name}</span>}
            {badge}
          </div>
          {secondLine ? <p className={wrapSecondLine ? `wrap-break-word text-xs leading-4 ${secondaryText}` : ROW_SECOND_LINE_CLASS}>{secondLine}</p> : null}
        </div>
      </div>
      {lanes}
      {action !== undefined ? <div role="cell" className={`flex w-7 shrink-0 justify-end ${href ? "relative z-[1]" : ""}`}>{action}</div> : null}
      {toggle ? <span aria-hidden="true" className={`hidden w-4 shrink-0 justify-end @md:flex ${secondaryText} transition-colors duration-150 group-hover:text-[color:var(--dls-text-primary)]`}>
        <ChevronRight size={16} strokeWidth={1.5} className={`transition-transform duration-150 motion-reduce:transition-none ${toggle.expanded ? "rotate-90" : ""}`} />
      </span> : null}
      {below}
    </div>
    {children ? <div role="row"><div role="cell" id={toggle?.controls} className={`border-b ${hairline} pb-5 pl-0 pt-3 @md:pl-11`}>{children}</div></div> : null}
  </>;
}

export function StatusLane({ lane = LANE.status, label, tone, detail, disconnected = false }: {
  lane?: string;
  label: string;
  tone: DeviceTone;
  detail?: string | null;
  disconnected?: boolean;
}) {
  return <RowLane lane={lane} className="flex-col justify-center" title={detail ?? undefined}>
    <span className="inline-flex min-w-0 items-center gap-2" data-status={disconnected ? "disconnected" : tone}>
      {disconnected ? <Unplug size={14} strokeWidth={1.5} aria-hidden="true" className={`shrink-0 ${secondaryText}`} /> : <StatusDot tone={tone} />}
      <span className="min-w-0 truncate">{label}</span>
    </span>
    {detail ? <span className={`hidden truncate text-[12px] leading-4 @md:block ${secondaryText}`}>{detail}</span> : null}
  </RowLane>;
}

export function OwnerLane({ device, lane = LANE.owner, sharedLabel }: {
  device: ComputerOwner;
  lane?: string;
  sharedLabel?: string;
}) {
  const label = ownerLabel(device);
  const member = !device.shared && !isFormerOwner(device);
  const Mark = device.shared ? Users : User;
  return <RowLane lane={lane} title={ownerEmail(device) ?? label} className="items-center gap-2">
    <span aria-hidden="true" className={`flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--dls-hover)] text-[11px] font-semibold uppercase ${member ? "text-[color:var(--dls-text-primary)]" : secondaryText}`}>
      {member ? label.slice(0, 1) : <Mark size={12} strokeWidth={1.5} />}
    </span>
    <span className={`min-w-0 truncate ${member ? "" : secondaryText}`}>{device.shared ? sharedLabel ?? label : label}</span>
  </RowLane>;
}

export function TimeLane({ lane, iso, now, never = "Never" }: { lane: string; iso: string | null; now: number; never?: string }) {
  return <RowLane lane={lane} className={`truncate tabular-nums ${secondaryText}`}>
    {iso ? <TimeAgo iso={iso} now={now} /> : never}
  </RowLane>;
}

export function VersionLane({ lane, version }: { lane: string; version: string | null }) {
  return <RowLane lane={lane} title={version ?? undefined} className={`truncate tabular-nums ${secondaryText}`}>{versionLabel(version)}</RowLane>;
}

export function RowListSkeleton({ rows = 4 }: { rows?: number }) {
  return <div aria-hidden="true">
    {Array.from({ length: rows }, (_, index) => <div key={index} className={`flex min-h-[49px] items-center gap-3 border-b ${hairline} py-1.5`}>
      <DenSkeleton className="size-8 shrink-0 rounded-lg" />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5"><DenSkeleton className="h-3 w-40 max-w-full" /><DenSkeleton className="h-2.5 w-24" /></span>
      <DenSkeleton className="h-3 w-20 shrink-0" />
    </div>)}
  </div>;
}

export function RemoteAccessLane({ access, voice = "owner", lane = LANE.remoteAccess }: {
  access: RemoteDeviceAccess | null;
  voice?: RemoteAccessVoice;
  lane?: string;
}) {
  if (!access) return <RowLane lane={lane}>{null}</RowLane>;
  const note = remoteAccessNote(access, voice);
  return <RowLane lane={lane} className="flex-col justify-center" title={note ?? undefined}>
    <span className="truncate" data-remote-access={access.effective}>{remoteAccessValue(access)}</span>
    {note ? <span className={`truncate text-[12px] leading-4 ${secondaryText}`}>{note}</span> : null}
  </RowLane>;
}

export function RemoteAccessBelow({ access, voice = "owner" }: { access: RemoteDeviceAccess | null; voice?: RemoteAccessVoice }) {
  if (!access) return null;
  const note = remoteAccessNote(access, voice);
  return <div role="cell" className={`basis-full pl-11 text-[12px] leading-4 @2xl:hidden ${secondaryText}`}>
    <span>{REMOTE_ACCESS_LABEL}: </span><span className="mr-2 text-[color:var(--dls-text-primary)]" data-remote-access={access.effective}>{remoteAccessValue(access)}</span>
    {note ? <span>{note}</span> : null}
  </div>;
}
