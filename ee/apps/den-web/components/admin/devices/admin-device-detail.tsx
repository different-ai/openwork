"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, X } from "lucide-react";
import {
  REMOTE_DEVICE_AVAILABILITY_LABELS,
  adminRemoteDeviceDetailResponseSchema,
  remoteDeviceTypeLabel,
  type AdminRemoteDeviceDetailResponse,
  type AdminRemoteDeviceEvent,
  type RemoteDeviceDiagnostics,
} from "@openwork/types/den/remote-devices";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenChip } from "../../../app/(den)/_components/ui/chip";
import { DenSkeleton } from "../../../app/(den)/_components/ui/skeleton";
import { requestAdmin } from "../admin-request";
import { CopyButton, CopyableId, StatusDot, TimeAgo, focusRing, hairline, secondaryText } from "./device-parts";
import {
  ACTOR_LABELS,
  AVAILABILITY_TONE,
  EVENT_LEVEL_LABELS,
  EVENT_LEVEL_TONE,
  PROVIDER_LABELS,
  SOURCE_LABELS,
  absoluteTime,
  countLabel,
  deviceDetailPath,
  eventDataEntries,
  ownerLabel,
  platformLabel,
  readinessLabel,
  readinessTone,
} from "./devices-format";

type Detail = AdminRemoteDeviceDetailResponse;
type Loaded = { detail: Detail; raw: unknown };
export type DeviceAccessFailure = { access: "signed-out" | "forbidden"; message: string };

const parseDetail = (payload: unknown): Loaded | null => {
  const result = adminRemoteDeviceDetailResponseSchema.safeParse(payload);
  return result.success ? { detail: result.data, raw: payload } : null;
};

const FEATURES: Array<{ key: keyof Detail["features"]; label: string }> = [
  { key: "remoteDevices", label: "Devices" },
  { key: "computerUse", label: "Computer use" },
  { key: "remoteComputers", label: "Remote computers" },
  { key: "browserUse", label: "Browser use" },
  { key: "sandboxGateway", label: "Sandbox gateway" },
];

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

function EventRow({ event, now }: { event: AdminRemoteDeviceEvent; now: number }) {
  const entries = eventDataEntries(event.data);
  return <li className={`flex min-w-0 items-start gap-3 border-b ${hairline} py-2`} data-testid={`admin-device-event-${event.id}`} data-level={event.level}>
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

/** One computer's detail, in the order an admin debugs it. `standalone` adds what its row in the list would have shown. */
export function AdminDeviceDetailView({ detail, raw, now, standalone = false }: { detail: Detail; raw: unknown; now: number; standalone?: boolean }) {
  const device = detail.device;
  const json = JSON.stringify(raw, null, 2);
  return <>
    <Rows flush>
      {standalone ? <>
        <Row label="Type">{remoteDeviceTypeLabel(device)}</Row>
        <Row label="Organization"><Link href={`/admin/organizations/${encodeURIComponent(device.organization.id)}`} prefetch={false} className="underline-offset-2 hover:underline">{device.organization.name}</Link></Row>
        <Row label="Owner">{ownerLabel(device)}</Row>
        <Row label="Availability">
          <span className="inline-flex items-center gap-2"><StatusDot tone={AVAILABILITY_TONE[device.availability]} />{REMOTE_DEVICE_AVAILABILITY_LABELS[device.availability]}</span>
          {device.statusDetail ? <span className={`ml-2 ${secondaryText}`}>{device.statusDetail}</span> : null}
        </Row>
        <Row label="Last heard from"><TimeAgo iso={device.lastSeenAt} now={now} /></Row>
        {device.appVersion ? <Row label="App version">{device.appVersion}</Row> : null}
      </> : null}
      <Row label="Device id"><CopyableId value={device.id} label="Copy device id" /></Row>
      <Row label="Provider id"><CopyableId value={device.externalId} label="Copy provider id" /></Row>
      <Row label="Provider">{PROVIDER_LABELS[device.provider]}</Row>
      <Row label="Source">{SOURCE_LABELS[device.source]}</Row>
      <Row label="Platform">{platformLabel(device.platform)}</Row>
      <Row label="Created"><time dateTime={device.createdAt}>{absoluteTime(device.createdAt)}</time></Row>
      {device.removedAt ? <Row label="Removed"><time dateTime={device.removedAt}>{absoluteTime(device.removedAt)}</time></Row> : null}
      {device.computerId ? <Row label="Remote tasks id"><CopyableId value={device.computerId} label="Copy remote tasks id" /></Row> : null}
      {device.workbotChat ? <Row label="Workbot chat"><code className="break-all font-mono text-[12px]">{device.workbotChat}</code></Row> : null}
    </Rows>

    <Section title="Features for the owner">
      <ul className={`flex flex-wrap gap-x-6 gap-y-2 border-t ${hairline} py-3`}>
        {FEATURES.map(({ key, label }) => <li key={key} className="inline-flex items-center gap-2" data-testid={`admin-device-feature-${key}`}>
          {label}<DenChip tone={detail.features[key] ? "success" : "neutral"}>{onOff(detail.features[key])}</DenChip>
        </li>)}
      </ul>
    </Section>

    {detail.diagnostics ? <ComputerUse diagnostics={detail.diagnostics} now={now} /> : null}

    {detail.runner ? <Section title="Runner">
      <Rows>
        <Row label="Last seen"><TimeAgo iso={detail.runner.lastSeenAt} now={now} /></Row>
        <Row label="App version">{detail.runner.appVersion}</Row>
        <Row label="Capabilities">
          {detail.runner.capabilities.length ? <span className="flex flex-wrap justify-end gap-1">{detail.runner.capabilities.map((capability) => <DenChip key={capability} mono>{capability}</DenChip>)}</span> : "None"}
        </Row>
        <Row label="Workspaces">{detail.runner.workspaces === null ? "Not reported" : <span className="tabular-nums">{detail.runner.workspaces}</span>}</Row>
      </Rows>
    </Section> : null}

    {detail.session ? <Section title="Workbot conversation">
      <Rows>
        <Row label="Title">{detail.session.title.trim() || "Untitled"}</Row>
        <Row label="Kind">{detail.session.kind}</Row>
        <Row label="Updated"><TimeAgo iso={detail.session.updatedAt} now={now} /></Row>
        {detail.session.activeTurnSince ? <Row label="Turn running since"><time dateTime={detail.session.activeTurnSince}>{absoluteTime(detail.session.activeTurnSince)}</time></Row> : null}
        {detail.session.deletedAt ? <Row label="Deleted"><time dateTime={detail.session.deletedAt}>{absoluteTime(detail.session.deletedAt)}</time></Row> : null}
      </Rows>
    </Section> : null}

    <Activity events={detail.events} now={now} />

    <details className="group/raw mt-6">
      <summary className={`flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm py-1 font-medium ${focusRing} [&::-webkit-details-marker]:hidden`}>
        <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" className={`shrink-0 ${secondaryText} transition-transform duration-150 ease-out group-open/raw:rotate-90 motion-reduce:transition-none`} />
        Raw response
      </summary>
      <div className="mt-2 flex items-start gap-2 rounded-md bg-[var(--dls-hover)] p-3">
        <pre className="max-h-96 min-w-0 flex-1 overflow-auto font-mono text-[12px] leading-5" data-testid="admin-device-raw">{json}</pre>
        <CopyButton value={json} label="Copy raw response" />
      </div>
    </details>
  </>;
}

/**
 * Everything Den knows that explains one computer's state. Read-only. Inside the list it sits under the
 * computer's row; `onClose` is given when the computer is not on the page shown, so it stands on its own.
 */
export function AdminDeviceDetail({ deviceId, refreshKey, onClose, onAccessFailure }: {
  deviceId: string;
  refreshKey: number;
  onClose?: () => void;
  onAccessFailure: (failure: DeviceAccessFailure) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void requestAdmin(deviceDetailPath(deviceId), parseDetail, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.access === "ready") { setLoaded(result.data); setError(null); }
      else if (result.access === "signed-out" || result.access === "forbidden") onAccessFailure({ access: result.access, message: result.message });
      else setError(result.message);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load this computer.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [deviceId, refreshKey, attempt, onAccessFailure]);

  const detail = loaded?.detail ?? null;
  const device = detail?.device ?? null;

  return <div className="max-w-3xl text-[13px] text-[color:var(--dls-text-primary)]" aria-busy={loading} data-testid={`admin-device-detail-${deviceId}`}>
    {onClose ? <div className="mb-2 flex items-center justify-between gap-3">
      <h2 className="min-w-0 break-words text-sm font-medium">{device ? device.label : loading ? <DenSkeleton className="h-5 w-40" /> : "Computer"}</h2>
      <DenButton variant="ghost" size="sm" icon={X} onClick={onClose}>Close</DenButton>
    </div> : null}

    {error ? <div role="alert" className="mb-3 flex flex-wrap items-center gap-3">
      <p className="text-[color:var(--ow-danger)]">{error}{detail ? " Showing what loaded last." : ""}</p>
      <DenButton variant="secondary" size="sm" loading={loading} onClick={() => setAttempt((value) => value + 1)}>Try again</DenButton>
    </div> : null}

    {loaded ? <AdminDeviceDetailView detail={loaded.detail} raw={loaded.raw} now={Date.now()} standalone={onClose !== undefined} />
      : error ? null : <DetailSkeleton />}
  </div>;
}
