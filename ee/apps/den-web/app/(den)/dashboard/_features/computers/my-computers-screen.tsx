"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, LockKeyhole, RefreshCw } from "lucide-react";
import { REMOTE_DEVICE_AVAILABILITY_LABELS, remoteDeviceTypeLabel, type RemoteDevice, type RemoteDeviceEvent } from "@openwork/types/den/remote-devices";
import { DenButton } from "../../../_components/ui/button";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { DenTable, type DenTableColumn } from "../../../_components/ui/table";
import { getComputersRoute, getOrgAccessFlags, orgFeatureEnabled } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { FeatureIntroGate } from "../feature-intros/feature-intro-gate";
import { StatusDot, TimeAgo, focusRing, hairline, secondaryText } from "./computer-parts";
import { AVAILABILITY_TONE, countLabel, type DeviceTone } from "./computers-format";
import { useMyComputerActivity, useMyComputers } from "./my-computers-data";

const SKELETON_ROWS = ["1", "2", "3"].map((id) => ({ id }));
const EVENT_TONE: Record<RemoteDeviceEvent["level"], DeviceTone> = { info: "neutral", warning: "warning", error: "danger" };
const EVENT_LABEL: Record<RemoteDeviceEvent["level"], string> = { info: "Information", warning: "Needs attention", error: "Problem" };

/** What happened to one computer lately, in the sentences Den recorded. No ids or codes: those are for admins. */
export function MyComputerActivity({ events, now }: { events: readonly RemoteDeviceEvent[]; now: number }) {
  if (events.length === 0) return <p className={`py-2 text-[13px] ${secondaryText}`}>Nothing recorded yet.</p>;
  return <ul className={`max-w-2xl border-t ${hairline} text-[13px]`} aria-label="Recent activity">
    {events.map((event) => <li key={event.id} className={`flex min-w-0 items-start gap-3 border-b ${hairline} py-2`} data-level={event.level}>
      <span className="flex h-5 w-2 shrink-0 items-center"><StatusDot tone={EVENT_TONE[event.level]} label={EVENT_LABEL[event.level]} /></span>
      <p className="min-w-0 flex-1 break-words">{event.message}</p>
      <TimeAgo iso={event.createdAt} now={now} className={`shrink-0 text-right tabular-nums ${secondaryText}`} />
    </li>)}
  </ul>;
}

/** The member's own and shared computers as rows. `detail` renders under the open row. */
export function MyComputersTable({ devices, now, openId, onToggle, detail }: {
  devices: readonly RemoteDevice[];
  now: number;
  openId: string;
  onToggle: (deviceId: string) => void;
  detail: (device: RemoteDevice) => ReactNode;
}) {
  const columns: DenTableColumn<RemoteDevice>[] = [
    { key: "computer", header: "Computer", render: (device) => <button type="button" aria-expanded={device.id === openId} aria-controls={`my-computer-activity-${device.id}`} onClick={() => onToggle(device.id)}
      data-testid={`my-computer-row-${device.id}`} className={`flex min-w-48 max-w-sm items-start gap-2 rounded-sm text-left ${focusRing}`}>
      <ChevronRight size={16} strokeWidth={1.5} aria-hidden className={`mt-0.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${device.id === openId ? "rotate-90" : ""}`} />
      <span className="min-w-0">
        <span className="block break-words font-medium">{device.label}</span>
        <span className={`mt-0.5 block text-xs ${secondaryText}`}>{remoteDeviceTypeLabel(device)}</span>
      </span>
    </button> },
    { key: "access", header: "Belongs to", render: (device) => device.access === "shared" ? "Shared with your organization" : "You" },
    { key: "availability", header: "Availability", render: (device) => <div className="min-w-32 max-w-xs">
      <span className="inline-flex items-center gap-2"><StatusDot tone={AVAILABILITY_TONE[device.availability]} />{REMOTE_DEVICE_AVAILABILITY_LABELS[device.availability]}</span>
      {device.statusDetail ? <p className={`mt-0.5 text-xs ${secondaryText}`}>{device.statusDetail}</p> : null}
    </div> },
    { key: "lastSeen", header: "Last contact", render: (device) => <TimeAgo iso={device.lastSeenAt} now={now} className="whitespace-nowrap tabular-nums" /> },
    { key: "version", header: "App version", render: (device) => device.appVersion ?? "Not reported" },
  ];
  return <DenTable columns={columns} rows={devices} getRowKey={(device) => device.id} density="compact"
    renderRowDetail={(device) => device.id === openId ? <div id={`my-computer-activity-${device.id}`} className="pb-2 pl-6 pt-1">{detail(device)}</div> : null} />;
}

function Activity({ orgId, memberId, deviceId }: { orgId: string; memberId: string; deviceId: string }) {
  const activity = useMyComputerActivity(orgId, memberId, deviceId, true);
  if (activity.isPending) return <div aria-hidden="true" className="max-w-2xl space-y-2 py-2"><DenSkeleton className="h-4 w-64" /><DenSkeleton className="h-4 w-48" /></div>;
  if (activity.error) return <div role="alert" className="flex flex-wrap items-center gap-3 py-2 text-[13px]"><p>{activity.error.message}</p><DenButton variant="secondary" size="sm" onClick={() => void activity.refetch()}>Try again</DenButton></div>;
  return <MyComputerActivity events={activity.data} now={Date.now()} />;
}

/**
 * My Computers: every member's own view in Den of the computers they have
 * connected to OpenWork and the ones shared with their organization. View
 * only; adding, renaming and removing stay in OpenWork Desktop. The team-wide
 * list for owners and admins is Manage › Computers.
 */
export function MyComputersScreen() {
  const { orgId, orgContext, activeOrg } = useOrgDashboard();
  const [openId, setOpenId] = useState("");
  const memberId = orgContext?.currentMember.id ?? "";
  const enabled = Boolean(orgId && orgContext && orgContext.organization.id === orgId && orgFeatureEnabled(orgContext, "remoteDevices"));
  const query = useMyComputers(orgId ?? "", memberId, enabled);
  if (!orgId || !orgContext) return <div aria-busy="true" aria-label="My Computers"><DenSkeleton className="mb-6 h-5 w-32" />{SKELETON_ROWS.map(({ id }) => <DenSkeleton key={id} className="mb-3 h-10 w-full" />)}</div>;
  if (!orgFeatureEnabled(orgContext, "remoteDevices")) return <section className="space-y-4" data-testid="my-computers-locked">
    <h1 className="text-base font-medium">My Computers</h1>
    <p className={`flex items-start gap-2 text-sm ${secondaryText}`}><LockKeyhole size={16} strokeWidth={1.5} aria-hidden className="mt-0.5 shrink-0" />
      Computers is not enabled for this organization. Ask an organization owner or admin about availability.
    </p>
  </section>;
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);
  const devices = query.data ?? [];
  const now = Date.now();
  const skeletonColumns: DenTableColumn<{ id: string }>[] = ["Computer", "Belongs to", "Availability", "Last contact", "App version"].map((header) => ({ key: header, header, render: () => <DenSkeleton className="h-4 w-24" /> }));
  return <section className="min-w-0 text-[color:var(--dls-text-primary)]" data-testid="my-computers" aria-busy={query.isFetching}>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-base font-medium">My Computers</h1>
      <DenButton size="sm" variant="secondary" icon={RefreshCw} loading={query.isFetching} onClick={() => void query.refetch()}>Refresh</DenButton>
    </div>
    {query.error ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm"><p>{query.error.message}{query.data ? " Showing the last known list." : ""}</p><DenButton variant="secondary" size="sm" onClick={() => void query.refetch()}>Try again</DenButton></div> : null}
    <FeatureIntroGate introKey="my-computers" facts={query.data ? { computers: query.data.length } : null}>
      {query.data ? <p className={`mb-3 text-xs tabular-nums ${secondaryText}`}>{countLabel(devices.length, "computer")}</p> : null}
      <div className="min-w-0">
        {!query.data ? query.isPending ? <div aria-hidden="true"><DenTable columns={skeletonColumns} rows={SKELETON_ROWS} getRowKey={(row) => row.id} density="compact" /></div> : null
          : devices.length ? <MyComputersTable devices={devices} now={now} openId={openId} onToggle={(id) => setOpenId((current) => current === id ? "" : id)}
              detail={(device) => <Activity orgId={orgId} memberId={memberId} deviceId={device.id} />} />
            : <p className={`py-6 text-sm ${secondaryText}`}>No computers yet. Sign in to OpenWork Desktop with this organization and this computer appears here.</p>}
      </div>
      <p className={`mt-6 max-w-2xl text-xs ${secondaryText}`}>
        Add, rename or remove computers in OpenWork Desktop, under Settings › Devices. Being listed here does not start a computer or grant access to it.
        {access.canViewComputers ? <> Your whole team&apos;s computers are in <Link href={getComputersRoute(activeOrg?.slug)} className={`underline underline-offset-2 ${focusRing}`}>Manage › Computers</Link>.</> : null}
      </p>
    </FeatureIntroGate>
  </section>;
}
