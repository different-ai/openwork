"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { remoteDeviceTypeLabel, type RemoteDevice, type RemoteDeviceAccess, type RemoteDeviceEvent } from "@openwork/types/den/remote-devices";
import { DenButton } from "../../../_components/ui/button";
import { DenPageHeader } from "../../../_components/ui/page-header";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { getComputersRoute, getOrgAccessFlags } from "../../../_lib/den-org";
import { useDenToast } from "../../_components/den-toast";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { FeatureIntroGate } from "../feature-intros/feature-intro-gate";
import { AddComputerDialog, ComputerMenu, type ComputerActionSet } from "./computer-action-controls";
import { disconnectOwnConfirm, disconnectedLine, myComputerActions, removeConfirm } from "./computer-actions";
import { StatusDot, TimeAgo, focusRing, hairline, secondaryText } from "./computer-parts";
import { LANE, ListRow, RemoteAccessBelow, RemoteAccessLane, RowLaneLabel, RowList, RowListHeader, RowListSkeleton, StatusLane, TimeLane, VersionLane, computerIcon } from "./computer-rows";
import { SHARED_COMPUTER_LABEL, computerStatus, computersStateLine, duplicateNameNotes, type DeviceTone } from "./computers-format";
import { ComputersPageHeader, SecondLine } from "./computers-screen";
import { REMOTE_ACCESS_LABEL, remoteAccessChangeHint, remoteAccessNote, remoteAccessValue } from "./remote-access";
import { disconnectMyComputer, myComputersQueryKey, removeMyComputer, renameMyComputer, useMyComputerActivity, useMyComputers } from "./my-computers-data";

const EVENT_TONE: Record<RemoteDeviceEvent["level"], DeviceTone> = { info: "neutral", warning: "warning", error: "danger" };
const EVENT_LABEL: Record<RemoteDeviceEvent["level"], string> = { info: "Information", warning: "Needs attention", error: "Problem" };

/** What happened to one computer lately, in the sentences Den recorded. No ids or codes: those are for admins. */
export function MyComputerActivity({ events, now }: { events: readonly RemoteDeviceEvent[]; now: number }) {
  if (events.length === 0) return <p className={`py-2 text-[13px] ${secondaryText}`}>Nothing recorded yet.</p>;
  return <ul className="max-w-2xl text-[13px]" aria-label="Recent activity">
    {events.map((event) => <li key={event.id} className={`flex min-w-0 items-start gap-3 border-b ${hairline} py-2 last:border-b-0`} data-level={event.level}>
      <span className="flex h-5 w-2 shrink-0 items-center"><StatusDot tone={EVENT_TONE[event.level]} label={EVENT_LABEL[event.level]} /></span>
      <p className="min-w-0 flex-1 break-words">{event.message}</p>
      <TimeAgo iso={event.createdAt} now={now} className={`shrink-0 text-right tabular-nums ${secondaryText}`} />
    </li>)}
  </ul>;
}

/**
 * An open row's remote access: what other devices can do on this computer,
 * why when something other than the owner's choice decides it, and where to
 * change it. Read-only: the owner chooses on the computer itself. Nothing
 * for a computer that takes no tasks this way.
 */
export function MyComputerRemoteAccess({ access }: { access: RemoteDeviceAccess | null }) {
  if (!access) return null;
  const note = remoteAccessNote(access, "owner");
  const hint = remoteAccessChangeHint(access);
  return <div className="mb-3 max-w-2xl text-[13px]" data-testid="my-computer-access" data-remote-access={access.effective}>
    <p><span className={secondaryText}>{REMOTE_ACCESS_LABEL}: </span>{remoteAccessValue(access)}</p>
    {note ? <p className={`text-[12px] leading-4 ${secondaryText}`}>{note}</p> : null}
    {hint ? <p className={`text-[12px] leading-4 ${secondaryText}`}>{hint}</p> : null}
  </div>;
}

/** How many of a member's computers answer right now. A disconnected one never does. */
export function onlineCount(devices: readonly Pick<RemoteDevice, "availability" | "disconnectedAt">[]): number {
  return devices.filter((device) => device.availability === "online" && !device.disconnectedAt).length;
}

/** The member's own and shared computers as rows. `detail` renders under the open row. */
export function MyComputerRows({ devices, now, openId, onToggle, action, detail }: {
  devices: readonly RemoteDevice[];
  now: number;
  openId: string;
  onToggle: (deviceId: string) => void;
  /** The row's `…` menu, in its fixed lane. */
  action: (device: RemoteDevice) => ReactNode;
  detail: (device: RemoteDevice) => ReactNode;
}) {
  const notes = duplicateNameNotes(devices, (device) => device.access, now);
  // The lane is there once any computer says what other devices can do on it; an older API says it for none.
  const remoteAccess = devices.some((device) => device.remoteAccess);
  return <RowList label="My computers" header={<RowListHeader lead="Computer" menu chevron>
    <RowLaneLabel lane={LANE.status}>Status</RowLaneLabel>
    {remoteAccess ? <RowLaneLabel lane={LANE.remoteAccess}>{REMOTE_ACCESS_LABEL}</RowLaneLabel> : null}
    <RowLaneLabel lane={LANE.time}>Last contact</RowLaneLabel>
    <RowLaneLabel lane={LANE.version}>App version</RowLaneLabel>
  </RowListHeader>}>
    {devices.map((device) => {
      const open = device.id === openId;
      return <ListRow key={device.id} icon={computerIcon(device)} name={device.label} testId={`my-computer-row-${device.id}`}
        secondLine={<SecondLine parts={[remoteDeviceTypeLabel(device), device.access === "shared" ? SHARED_COMPUTER_LABEL : null, notes.get(device.id)]} />}
        toggle={{ expanded: open, controls: `my-computer-activity-${device.id}`, onToggle: () => onToggle(device.id) }}
        lanes={<>
          <StatusLane {...computerStatus(device)} />
          {remoteAccess ? <RemoteAccessLane access={device.remoteAccess} /> : null}
          <TimeLane lane={LANE.time} iso={device.lastSeenAt} now={now} />
          <VersionLane lane={LANE.version} version={device.appVersion} />
        </>}
        below={<RemoteAccessBelow access={device.remoteAccess} />}
        action={action(device) ?? null}>
        {open ? detail(device) : null}
      </ListRow>;
    })}
  </RowList>;
}

function Activity({ orgId, memberId, deviceId }: { orgId: string; memberId: string; deviceId: string }) {
  const activity = useMyComputerActivity(orgId, memberId, deviceId, true);
  if (activity.isPending) return <div aria-hidden="true" className="max-w-2xl space-y-2 py-2"><DenSkeleton className="h-4 w-64" /><DenSkeleton className="h-4 w-48" /></div>;
  if (activity.error) return <div role="alert" className="flex flex-wrap items-center gap-3 py-2 text-[13px]"><p>{activity.error.message}</p><DenButton variant="secondary" size="sm" onClick={() => void activity.refetch()}>Try again</DenButton></div>;
  return <MyComputerActivity events={activity.data} now={Date.now()} />;
}

/** An open row: what other devices can do on this computer, then its recent activity. */
function OpenComputer({ orgId, memberId, device }: { orgId: string; memberId: string; device: RemoteDevice }) {
  return <>
    <MyComputerRemoteAccess access={device.remoteAccess} />
    <Activity orgId={orgId} memberId={memberId} deviceId={device.id} />
  </>;
}

/**
 * My Computers: every member's own view in Den of the computers they have
 * connected to OpenWork and the ones shared with their organization. They
 * rename, disconnect and remove their own here; the team-wide list for owners
 * and admins is Manage › Computers.
 */
export function MyComputersScreen() {
  const { orgId, orgContext, activeOrg, runReauthableAction } = useOrgDashboard();
  const queryClient = useQueryClient();
  const toast = useDenToast();
  const [openId, setOpenId] = useState("");
  const [adding, setAdding] = useState(false);
  const memberId = orgContext?.currentMember.id ?? "";
  const enabled = Boolean(orgId && orgContext && orgContext.organization.id === orgId);
  const query = useMyComputers(orgId ?? "", memberId, enabled);
  if (!orgId || !orgContext) return <div aria-busy="true" aria-label="My Computers"><DenSkeleton className="mb-8 h-6 w-36" /><RowListSkeleton rows={3} /></div>;
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);
  const devices = query.data ?? [];
  const now = Date.now();
  const refresh = () => queryClient.invalidateQueries({ queryKey: myComputersQueryKey(orgId, memberId) });

  const actionsFor = (device: RemoteDevice): ComputerActionSet => ({
    actions: myComputerActions(device),
    name: device.label,
    disconnectConfirm: disconnectOwnConfirm(device.label),
    removeConfirm: removeConfirm(device.label),
    onDisconnect: async () => {
      const result: { signedOut: boolean | null } = { signedOut: null };
      await runReauthableAction("disconnect-my-computer", async () => { result.signedOut = (await disconnectMyComputer(orgId, device.id)).signedOut; });
      if (result.signedOut !== null) toast({ title: disconnectedLine(result.signedOut) });
      await refresh();
    },
    onRemove: async () => {
      await runReauthableAction("remove-my-computer", async () => { await removeMyComputer(orgId, device.id); });
      toast({ title: `Removed ${device.label} from the list` });
      setOpenId((current) => current === device.id ? "" : current);
      await refresh();
    },
    onRename: async (label) => {
      await runReauthableAction("rename-my-computer", async () => { await renameMyComputer(orgId, device.id, label); });
      await refresh();
    },
  });

  return <section className="min-w-0 text-[color:var(--dls-text-primary)]" data-testid="my-computers" aria-busy={query.isFetching}>
    <ComputersPageHeader title="My Computers" state={query.data ? computersStateLine({ online: onlineCount(devices), total: devices.length }) : null}
      refreshing={query.isFetching} onRefresh={() => void query.refetch()} onAdd={() => setAdding(true)} />
    <AddComputerDialog open={adding} onClose={() => setAdding(false)} />
    {query.error ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-[13px]"><p>{query.error.message}{query.data ? " Showing the last known list." : ""}</p><DenButton variant="secondary" size="sm" onClick={() => void query.refetch()}>Try again</DenButton></div> : null}
    <FeatureIntroGate introKey="my-computers" facts={query.data ? { computers: query.data.length } : null}>
      <div className="min-w-0">
        {!query.data ? query.isPending ? <RowListSkeleton rows={3} /> : null
          : devices.length ? <MyComputerRows devices={devices} now={now} openId={openId} onToggle={(id) => setOpenId((current) => current === id ? "" : id)}
              action={(device) => <ComputerMenu set={actionsFor(device)} idPrefix="my-computer" id={device.id} />}
              detail={(device) => <OpenComputer orgId={orgId} memberId={memberId} device={device} />} />
            : <p className={`border-y ${hairline} py-6 text-[13px] ${secondaryText}`}>No computers yet. Sign in to OpenWork on a computer with this organization and it appears here.</p>}
      </div>
      {access.canViewComputers ? <p className={`mt-4 text-[12px] leading-4 ${secondaryText}`}>
        Your whole team&apos;s computers are in <Link href={getComputersRoute(activeOrg?.slug)} className={`underline underline-offset-2 ${focusRing}`}>Manage &gt; Computers</Link>.
      </p> : null}
    </FeatureIntroGate>
  </section>;
}
