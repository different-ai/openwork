"use client";

import { REMOTE_DEVICE_AVAILABILITY_LABELS, remoteDeviceTypeLabel, type RemoteDevice, type RemoteDeviceAvailability } from "@openwork/types/den/remote-devices";
import { Cloud, Laptop, Monitor } from "lucide-react";
import { useWorkbotDevices } from "./data";
import { computerTabLabel, computerViews, workbotHost } from "./host";

/**
 * Devices (`remoteDevices`): the computers the person can reach through OpenWork, read-only. Their own computers
 * running OpenWork Desktop, then the cloud ones (Workbot's computer for a chat, registered virtual computers). Each row
 * says what it is and whether it can be reached; Workbot's own computers open in the Computer view. Naming and
 * removing a computer happen in OpenWork Desktop.
 */

const row = "flex min-h-14 items-center gap-3 border-b border-[var(--wb-row-line)] py-2.5 last:border-b-0";
const openButton = "h-8 shrink-0 rounded-full px-3.5 text-[13px] font-medium text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] transition-colors duration-150 hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";

/** Green while it can be reached, amber where the person has something to set up, quiet otherwise (C5). */
const AVAILABILITY_DOT: Record<RemoteDeviceAvailability, string> = {
  online: "bg-[var(--wb-status-online)]",
  needs_setup: "bg-[var(--wb-status-attention)]",
  paused: "bg-[var(--wb-disabled)]",
  offline: "bg-[var(--wb-disabled)]",
  unknown: "bg-[var(--wb-disabled)]",
};

/** The person's own computers first, then the cloud ones; each in Den's order. */
export function deviceGroups(devices: readonly RemoteDevice[]): Array<{ id: "desktop" | "vm"; label: string; devices: RemoteDevice[] }> {
  return [
    { id: "desktop" as const, label: "Your computers", devices: devices.filter(device => device.kind === "desktop") },
    { id: "vm" as const, label: "Cloud computers", devices: devices.filter(device => device.kind === "vm") },
  ].filter(group => group.devices.length > 0);
}

/** "5 minutes ago", "2 hours ago", "3 days ago", then the date. */
function agoLabel(at: number, now: number) {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * The line under a computer's availability: what needs attention when its last report said so, else when it was last
 * heard from. Nothing for a computer that has never been heard from.
 */
export function deviceStatusLine(device: Pick<RemoteDevice, "availability" | "statusDetail" | "lastSeenAt">, now: number = Date.now()): string | null {
  if (device.statusDetail) return device.statusDetail;
  if (device.availability === "online") return "Active now";
  const seen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : Number.NaN;
  return Number.isNaN(seen) ? null : agoLabel(seen, now);
}

function DeviceIcon({ device }: { device: RemoteDevice }) {
  const Icon = device.kind === "desktop" ? Laptop : device.provider === "workbot" ? Monitor : Cloud;
  return <Icon size={16} strokeWidth={1.5} aria-hidden className="shrink-0 text-[var(--wb-muted)]" />;
}

function DeviceRow({ device, onOpen }: { device: RemoteDevice; onOpen: (() => void) | null }) {
  const host = workbotHost();
  const detail = deviceStatusLine(device);
  const openLabel = computerTabLabel(host) === "Browser" ? "Open Workbot's browser" : "Open Workbot's computer";
  return <li className={row} data-workbot-device={device.availability}>
    <DeviceIcon device={device} />
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-[13.5px] text-[var(--wb-text)]">{device.label}</span>
      <span className="flex min-w-0 flex-wrap gap-x-3 text-[12px] leading-4 text-[var(--wb-muted)]">
        <span>{remoteDeviceTypeLabel(device)}</span>
        {device.access === "shared" ? <span>Shared with your organization</span> : null}
        {device.kind === "desktop" && device.computerId !== null && host.remoteTasks === true ? <span>Takes tasks from Workbot</span> : null}
      </span>
    </span>
    <span className="flex min-w-0 max-w-[45%] shrink-0 flex-col items-end">
      <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--wb-text)]"><span aria-hidden className={`size-1.5 shrink-0 rounded-full ${AVAILABILITY_DOT[device.availability]}`} />{REMOTE_DEVICE_AVAILABILITY_LABELS[device.availability]}</span>
      {detail ? <span className="max-w-full truncate text-[12px] leading-4 text-[var(--wb-muted)]" title={device.statusDetail ?? undefined}>{detail}</span> : null}
    </span>
    {onOpen ? <button type="button" className={openButton} onClick={onOpen} title={openLabel} aria-label={`${openLabel}: ${device.label}`}>Open</button> : null}
  </li>;
}

/** Three rows shaped like the list: an icon, a name over its kind, and its state on the right. */
function DevicesSkeleton() {
  return <ul aria-label="Loading your computers" aria-busy="true" data-workbot-devices-loading>{[0, 1, 2].map(index => <li key={index} className={row}>
    <span className="size-4 shrink-0 rounded bg-[var(--wb-chip)]" />
    <span className="flex min-w-0 flex-1 flex-col gap-1.5"><span className="h-3 w-40 max-w-full rounded bg-[var(--wb-chip)]" /><span className="h-2.5 w-24 rounded bg-[var(--wb-chip)]" /></span>
    <span className="flex shrink-0 flex-col items-end gap-1.5"><span className="h-3 w-14 rounded bg-[var(--wb-chip)]" /><span className="h-2.5 w-20 rounded bg-[var(--wb-chip)]" /></span>
  </li>)}</ul>;
}

/**
 * `computerFor`: how to open the Computer view of one of Workbot's own computers, by its chat (`main` or a side chat's
 * id), or null where that chat's computer can't be opened from here. The screen owns chats and pages.
 */
export function WorkbotDevices({ computerFor }: { computerFor?: (workbotChat: string) => (() => void) | null }) {
  const host = workbotHost();
  const devices = useWorkbotDevices();
  const groups = deviceGroups(devices.data ?? []);
  const canOpen = computerViews(host).length > 0;
  const opener = (device: RemoteDevice) => canOpen && device.provider === "workbot" && device.workbotChat !== null ? computerFor?.(device.workbotChat) ?? null : null;
  return <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-workbot-devices>
    <div className="mx-auto flex w-full max-w-[720px] flex-col px-5 pb-8 pt-3">
      {!devices.data && devices.isError ? <div className="flex flex-col items-start gap-2 py-6" role="status">
          <p className="text-[14px] text-[var(--wb-text)]">Couldn&apos;t load your computers</p>
          <button type="button" className={openButton} onClick={() => void devices.refetch()}>Try again</button>
        </div>
        : !devices.data ? <DevicesSkeleton />
        : groups.length === 0 ? <div className="py-6" data-workbot-devices-empty>
          <p className="text-[14px] font-medium text-[var(--wb-text)]">No computers yet</p>
          <p className="pt-1 text-[13px] leading-[19px] text-[var(--wb-muted)]">Sign in to OpenWork Desktop on a computer, or let Workbot use its own computer, and it shows up here.</p>
        </div>
        : <>
          {devices.isError ? <p role="status" className="pb-2 text-[12px] leading-4 text-[var(--wb-muted)]">Couldn&apos;t load your computers. <button type="button" className="rounded font-medium text-[var(--wb-text)] underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" onClick={() => void devices.refetch()}>Try again</button></p> : null}
          {groups.map(group => <section key={group.id} aria-label={groups.length > 1 ? group.label : undefined} className="pb-5 last:pb-0">
            {groups.length > 1 ? <h2 className="pb-1 pt-2 text-[12px] font-medium text-[var(--wb-muted)]">{group.label}</h2> : null}
            <ul>{group.devices.map(device => <DeviceRow key={device.id} device={device} onOpen={opener(device)} />)}</ul>
          </section>)}
          <p className="pt-4 text-[12px] leading-4 text-[var(--wb-muted)]">Add or remove computers in OpenWork Desktop, under Settings › Devices.</p>
        </>}
    </div>
  </div>;
}
