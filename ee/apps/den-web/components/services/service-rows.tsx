"use client";

import { Cpu, Database, Mail, MessageCircle, Server, Waypoints, type LucideIcon } from "lucide-react";
import {
  SERVICE_LABELS,
  SERVICE_NOTE_LABELS,
  SERVICE_REASON_LABELS,
  SERVICE_SETUP_HINTS,
  SERVICE_STATE_LABELS,
  type DenServerFacts,
  type DeploymentServiceReadiness,
  type DeploymentServiceStatus,
  type ServiceId,
  type ServiceNote,
} from "@openwork/types/den/service-readiness";
import { formatServiceTime } from "../../app/(den)/_lib/service-readiness";
import { INSTALLATION_COPY, SERVICE_DETAIL_COPY, SERVICE_STATE_TONES, type DiagnosticsTone } from "../diagnostics/diagnostics-copy";
import { diagnosticsRowId, formatAgo, formatDuration, formatUptime } from "../diagnostics/diagnostics-data";
import { DiagnosticsBadge, DiagnosticsCode, DiagnosticsFacts, DiagnosticsLead, DiagnosticsRow } from "../diagnostics/diagnostics-row";
import { serviceDisplayState, serviceRows, serviceStateLabel } from "./service-readiness-data";

/**
 * Installation rows shared by Settings › Diagnostics (installation
 * administrators) and Admin › Services, so both read the same.
 */

const SERVICE_ICONS: Record<ServiceId, LucideIcon> = {
  database: Database,
  gateway: Waypoints,
  headlessRunner: Cpu,
  workbot: MessageCircle,
  email: Mail,
};

/** The mail transport reads as the row's sub; other notes are details. */
const SUB_NOTES: ReadonlySet<ServiceNote> = new Set(["email_smtp", "email_resend"]);

function serviceTone(service: DeploymentServiceStatus): DiagnosticsTone {
  const state = serviceDisplayState(service);
  return state === "stale" ? "neutral" : SERVICE_STATE_TONES[state];
}

function when(value: string | null, now: number): string {
  return formatAgo(value, now) ?? formatServiceTime(value);
}

function ServiceRow({ service, now }: { service: DeploymentServiceStatus; now: number }) {
  const ServiceIcon = SERVICE_ICONS[service.id];
  const sub = service.notes.filter((note) => SUB_NOTES.has(note)).map((note) => SERVICE_NOTE_LABELS[note]).join(", ");
  const details = service.notes.filter((note) => !SUB_NOTES.has(note)).map((note) => SERVICE_NOTE_LABELS[note]);
  const ready = serviceDisplayState(service) === "ready";
  return (
    <DiagnosticsRow
      id={diagnosticsRowId("installation", service.id)}
      testId={`service-status-${service.id}`}
      detailsTestId={`service-details-${service.id}`}
      summaryTestId={`service-details-toggle-${service.id}`}
      stateTestId={`service-state-${service.id}`}
      lead={<DiagnosticsLead><ServiceIcon size={16} strokeWidth={1.5} /></DiagnosticsLead>}
      name={SERVICE_LABELS[service.id]}
      sub={sub || null}
      metric={service.durationMs === null ? null : formatDuration(service.durationMs)}
      state={<DiagnosticsBadge tone={serviceTone(service)}>{serviceStateLabel(service)}</DiagnosticsBadge>}
    >
      <DiagnosticsFacts facts={[
        { label: SERVICE_DETAIL_COPY.checked, value: SERVICE_REASON_LABELS[service.reason] },
        details.length > 0 && { label: SERVICE_DETAIL_COPY.details, value: details.join(". ") },
        { label: SERVICE_DETAIL_COPY.role, value: service.required ? SERVICE_DETAIL_COPY.required : SERVICE_DETAIL_COPY.optional },
        { label: SERVICE_DETAIL_COPY.settings, value: service.configured ? SERVICE_DETAIL_COPY.settingsPresent : SERVICE_DETAIL_COPY.settingsMissing },
        service.missingSettings.length > 0 && {
          label: SERVICE_DETAIL_COPY.missingSettings,
          value: service.missingSettings.map((name, index) => <span key={name}>{index > 0 ? ", " : null}<DiagnosticsCode>{name}</DiagnosticsCode></span>),
        },
        service.dependencies.length > 0 && { label: SERVICE_DETAIL_COPY.dependencies, value: service.dependencies.map((id) => SERVICE_LABELS[id]).join(", ") },
        !ready && { label: SERVICE_DETAIL_COPY.setup, value: SERVICE_SETUP_HINTS[service.id] },
        { label: SERVICE_DETAIL_COPY.lastChecked, value: when(service.checkedAt, now) },
        { label: SERVICE_DETAIL_COPY.lastSuccess, value: when(service.lastSuccessAt, now) },
      ]} />
    </DiagnosticsRow>
  );
}

function ServerRow({ server, now }: { server: DenServerFacts; now: number }) {
  const uptime = formatUptime(server.startedAt, now);
  const metric = [uptime, server.startupMs === null ? null : `ready in ${formatDuration(server.startupMs)}`].filter(Boolean).join(", ");
  return (
    <DiagnosticsRow
      id={diagnosticsRowId("installation", "server")}
      testId="installation-server"
      lead={<DiagnosticsLead><Server size={16} strokeWidth={1.5} /></DiagnosticsLead>}
      name={INSTALLATION_COPY.server}
      sub={server.version}
      metric={metric}
      state={<DiagnosticsBadge tone="success">{SERVICE_STATE_LABELS.ready}</DiagnosticsBadge>}
    >
      <DiagnosticsFacts facts={[
        { label: SERVICE_DETAIL_COPY.version, value: <DiagnosticsCode>{server.version}</DiagnosticsCode> },
        { label: SERVICE_DETAIL_COPY.started, value: formatServiceTime(server.startedAt) },
        server.startupMs !== null && { label: SERVICE_DETAIL_COPY.readyIn, value: formatDuration(server.startupMs) },
      ]} />
    </DiagnosticsRow>
  );
}

/** The answering server first, then every service slot (missing ones read as not checked). */
export function InstallationRows({ readiness, server, now }: { readiness: DeploymentServiceReadiness | null; server?: DenServerFacts | null; now: number }) {
  const facts = server ?? readiness?.server ?? null;
  return (
    <>
      {facts ? <ServerRow server={facts} now={now} /> : null}
      {serviceRows(readiness).map((service) => <ServiceRow key={service.id} service={service} now={now} />)}
    </>
  );
}
