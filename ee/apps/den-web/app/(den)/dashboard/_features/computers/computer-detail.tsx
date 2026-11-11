"use client";

import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import {
  REMOTE_DEVICE_AVAILABILITY_LABELS,
  organizationComputerDetailResponseSchema,
  remoteDeviceTypeLabel,
  type RemoteDeviceDiagnostics,
} from "@openwork/types/den/remote-devices";
import { DenButton } from "../../../_components/ui/button";
import { DenChip } from "../../../_components/ui/chip";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import type { z } from "zod";
import { useComputer } from "./computers-data";
import type { OrganizationComputerEvent } from "./computers-format";
import { CopyableId, StatusDot, TimeAgo, focusRing, hairline, secondaryText } from "./computer-parts";
import {
  ACTOR_LABELS,
  AVAILABILITY_TONE,
  EVENT_LEVEL_LABELS,
  EVENT_LEVEL_TONE,
  PROVIDER_LABELS,
  SOURCE_LABELS,
  absoluteTime,
  countLabel,
  eventDataEntries,
  ownerLabel,
  platformLabel,
  readinessLabel,
  readinessTone,
} from "./computers-format";

export type ComputerDetail = z.infer<typeof organizationComputerDetailResponseSchema>;
type Detail = ComputerDetail;
/** Events shown before "Show all": enough for the last incident without a hundred rows. */
const EVENTS_SHOWN = 20;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mt-6">
    <h3 className="mb-1 text-[13px] font-medium text-[color:var(--dls-text-primary)]">{title}</h3>
    {children}
  </section>;
}

/** `flush` drops the top hairline where the rows follow the line that already closes the computer's row. */
function Rows({ children, flush = false }: { children: ReactNode; flush?: boolean }) {
  return <dl className={flush ? undefined : `border-t ${hairline}`}>{children}</dl>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className={`flex min-h-10 min-w-0 items-center justify-between gap-6 border-b ${hairline} py-1.5`}>
    <dt className={`shrink-0 ${secondaryText}`}>{label}</dt>
    <dd className="flex min-w-0 items-center justify-end gap-1 text-right">{children}</dd>
  </div>;
}

const onOff = (value: boolean) => value ? "On" : "Off";

function ComputerUse({ diagnostics, now }: { diagnostics: RemoteDeviceDiagnostics; now: number }) {
  const computerUse = diagnostics.computerUse;
  const system = [diagnostics.osVersion, diagnostics.arch].filter(Boolean).join(" ");
  return <Section title="Computer use">
    <Rows>
      {computerUse ? <>
        <Row label="Computer use">{onOff(computerUse.enabled)}</Row>
        <Row label="Remote computers">{onOff(computerUse.remoteEnabled)}</Row>
        {computerUse.permissions ? <>
          <Row label="Accessibility"><Permission granted={computerUse.permissions.accessibility} /></Row>
          <Row label="Screen Recording"><Permission granted={computerUse.permissions.screenRecording} /></Row>
        </> : null}
      </> : <Row label="Computer use">Not reported</Row>}
      {system ? <Row label="Operating system">{system}</Row> : null}
      <Row label="Reported"><TimeAgo iso={diagnostics.reportedAt} now={now} /></Row>
    </Rows>
    {computerUse?.computers.length ? <ul className="mt-3" aria-label="Computers this desktop reported">
      {computerUse.computers.map((computer) => <li key={computer.id} className={`flex min-h-10 min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b ${hairline} py-1.5`}>
        <div className="min-w-0">
          <p className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="break-words">{computer.label}</span>
            {computer.id === computerUse.selectedId ? <DenChip tone="info">Agents use this one</DenChip> : null}
          </p>
          {computer.detail ? <p className={`mt-0.5 text-xs ${secondaryText}`}>{computer.detail}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <span className={secondaryText}>{computer.placement === "local" ? "Local" : "Remote"}</span>
          <span className="inline-flex items-center gap-2"><StatusDot tone={readinessTone(computer.readiness)} />{readinessLabel(computer.readiness)}</span>
        </div>
      </li>)}
    </ul> : null}
  </Section>;
}

function Permission({ granted }: { granted: boolean }) {
  return granted ? <>Granted</> : <span className="inline-flex items-center gap-2"><StatusDot tone="warning" />Not granted</span>;
}

function EventRow({ event, now }: { event: OrganizationComputerEvent; now: number }) {
  const entries = eventDataEntries(event.data);
  return <li className={`flex min-w-0 items-start gap-3 border-b ${hairline} py-2`} data-testid={`computer-event-${event.id}`} data-level={event.level}>
    <span className="flex h-5 w-2 shrink-0 items-center"><StatusDot tone={EVENT_LEVEL_TONE[event.level]} label={EVENT_LEVEL_LABELS[event.level]} /></span>
    <div className="min-w-0 flex-1">
      <p className="break-words">{event.message}</p>
      {entries.length ? <p className={`mt-0.5 flex flex-wrap gap-x-3 font-mono text-[11px] ${secondaryText}`}>
        {entries.map(([key, value]) => <span key={key} className="break-all">{key}={value}</span>)}
      </p> : null}
    </div>
    <span className={`w-20 shrink-0 ${secondaryText}`}>{ACTOR_LABELS[event.actor]}</span>
    <TimeAgo iso={event.createdAt} now={now} className={`w-24 shrink-0 text-right tabular-nums ${secondaryText}`} />
  </li>;
}

function Activity({ events, now }: { events: Detail["events"]; now: number }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? events : events.slice(0, EVENTS_SHOWN);
  return <Section title="Activity">
    {events.length === 0 ? <p className={`border-t ${hairline} py-3 ${secondaryText}`}>Nothing recorded yet.</p> : <>
      <ul className={`border-t ${hairline}`}>{shown.map((event) => <EventRow key={event.id} event={event} now={now} />)}</ul>
      {events.length > shown.length ? <DenButton variant="ghost" size="inline" className="mt-1" onClick={() => setShowAll(true)}>Show all {countLabel(events.length, "event")}</DenButton> : null}
    </>}
  </Section>;
}

function DetailSkeleton() {
  return <div aria-hidden="true" className={`border-t ${hairline}`}>
    {["w-56", "w-40", "w-28", "w-48", "w-20", "w-36"].map((width, index) => <div key={index} className={`flex min-h-10 items-center justify-between gap-6 border-b ${hairline} py-1.5`}>
      <DenSkeleton className="h-4 w-24" /><DenSkeleton className={`h-4 ${width}`} />
    </div>)}
  </div>;
}

/** One computer's supported inventory, without credentials or impersonation. `standalone` adds what its row in the list would have shown. */
export function ComputerDetailView({ detail, now, standalone = false }: { detail: Detail; now: number; standalone?: boolean }) {
  const device = detail.device;
  return <>
    <Rows flush>
      {standalone ? <>
        <Row label="Type">{remoteDeviceTypeLabel(device)}</Row>
        <Row label="Owner">{ownerLabel(device)}</Row>
        <Row label="Availability">
          <span className="inline-flex items-center gap-2"><StatusDot tone={AVAILABILITY_TONE[device.availability]} />{REMOTE_DEVICE_AVAILABILITY_LABELS[device.availability]}</span>
          {device.statusDetail ? <span className={`ml-2 ${secondaryText}`}>{device.statusDetail}</span> : null}
        </Row>
        <Row label="Last heard from"><TimeAgo iso={device.lastSeenAt} now={now} /></Row>
        {device.appVersion ? <Row label="App version">{device.appVersion}</Row> : null}
      </> : null}
      <Row label="Provider">{PROVIDER_LABELS[device.provider]}</Row>
      <Row label="Source">{SOURCE_LABELS[device.source]}</Row>
      <Row label="Platform">{platformLabel(device.platform)}</Row>
      <Row label="Created"><time dateTime={device.createdAt}>{absoluteTime(device.createdAt)}</time></Row>
      {device.removedAt ? <Row label="Removed"><time dateTime={device.removedAt}>{absoluteTime(device.removedAt)}</time></Row> : null}
    </Rows>

    {detail.diagnostics ? <ComputerUse diagnostics={detail.diagnostics} now={now} /> : null}

    {detail.runner ? <Section title="Runner">
      <Rows>
        <Row label="Last seen"><TimeAgo iso={detail.runner.lastSeenAt} now={now} /></Row>
        <Row label="App version">{detail.runner.appVersion}</Row>
        <Row label="Capabilities">
          {detail.runner.capabilities.length ? <span className="flex flex-wrap justify-end gap-1">{detail.runner.capabilities.map((capability) => <DenChip key={capability} mono>{capability}</DenChip>)}</span> : "None"}
        </Row>
        <Row label="Workspaces">{detail.runner.workspaces === null ? "Not reported" : <span className="tabular-nums">{detail.runner.workspaces}</span>}</Row>
        <Row label="Inventory reported"><TimeAgo iso={detail.runner.inventoryUpdatedAt} now={now} /></Row>
      </Rows>
    </Section> : null}

    {detail.session ? <Section title="Workbot conversation">
      <Rows>
        <Row label="Kind">{detail.session.kind}</Row>
        <Row label="Updated"><TimeAgo iso={detail.session.updatedAt} now={now} /></Row>
        {detail.session.activeTurnSince ? <Row label="Turn running since"><time dateTime={detail.session.activeTurnSince}>{absoluteTime(detail.session.activeTurnSince)}</time></Row> : null}
        {detail.session.deletedAt ? <Row label="Deleted"><time dateTime={detail.session.deletedAt}>{absoluteTime(detail.session.deletedAt)}</time></Row> : null}
      </Rows>
    </Section> : null}

    <details className="mt-6"><summary className={`cursor-pointer font-medium ${focusRing}`}>Activity</summary><Activity events={detail.events} now={now} /></details>
    <details className="mt-4"><summary className={`cursor-pointer font-medium ${focusRing}`}>Technical details</summary>
      <Rows>
        <Row label="Computer id"><CopyableId value={device.id} label="Copy computer id" /></Row>
        <Row label="Provider id"><CopyableId value={device.externalId} label="Copy provider id" /></Row>
        {device.computerId ? <Row label="Remote tasks id"><CopyableId value={device.computerId} label="Copy remote tasks id" /></Row> : null}
      </Rows>
    </details>

  </>;
}

/**
 * Everything Den knows that explains one computer's state. Read-only. Inside the list it sits under the
 * computer's row; `onClose` is given when the computer is not on the page shown, so it stands on its own.
 */
export function ComputerDetail({ orgId, deviceId, onClose }: {
  orgId: string;
  deviceId: string;
  onClose?: () => void;
}) {
  const query = useComputer(orgId, deviceId);
  const detail = query.data;
  return <div className="max-w-3xl text-[13px] text-[color:var(--dls-text-primary)]" aria-busy={query.isFetching} data-testid={`computer-detail-${deviceId}`}>
    {onClose ? <div className="mb-2 flex items-center justify-between gap-3">
      <h2 className="min-w-0 break-words text-sm font-medium">{detail?.device.label ?? "Computer"}</h2>
      <DenButton variant="ghost" size="sm" icon={X} onClick={onClose}>Close</DenButton>
    </div> : null}
    {query.error ? <div role="alert" className="mb-3 flex flex-wrap items-center gap-3">
      <p>{query.error.message}{detail ? " Showing the last known report." : ""}</p>
      <DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>Try again</DenButton>
    </div> : null}
    {detail ? <ComputerDetailView detail={detail} now={Date.now()} standalone={Boolean(onClose)} />
      : query.isPending ? <DetailSkeleton /> : null}
  </div>;
}
