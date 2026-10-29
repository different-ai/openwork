"use client";

import { Globe, Laptop, Lock, Plug, Waypoints } from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  ConnectorCheck,
  ConnectorsDiagnostics,
  DesktopDiagnostics,
  OrgDiagnostics,
  ProviderCheck,
  ProviderCheckState,
  ProvidersDiagnostics,
} from "@openwork/types/den/diagnostics";
import { DenBrandMark } from "../../app/(den)/_components/ui/brand-mark";
import { formatServiceTime } from "../../app/(den)/_lib/service-readiness";
import {
  getAddConnectorRoute,
  getAiGatewayProvidersRoute,
  getInferenceRoute,
  getLlmProvidersRoute,
  getMcpConnectionsRoute,
  getNewAiGatewayProviderRoute,
} from "../../app/(den)/_lib/den-org";
import { providerIconSlug } from "../../app/(den)/dashboard/_components/library-models";
import { InstallationRows } from "../services/service-rows";
import {
  CONNECTOR_ACTIONS,
  CONNECTOR_COPY,
  CONNECTOR_REASON_COPY,
  CONNECTOR_STATE_LABELS,
  CONNECTOR_STATE_TONES,
  DESKTOP_COPY,
  DESKTOP_REASON_BADGES,
  DESKTOP_REASON_DETAILS,
  DESKTOP_REASON_NEXT_STEPS,
  DESKTOP_STEP_LABELS,
  INSTALLATION_COPY,
  NETWORK_COPY,
  PROVIDER_ACTIONS,
  PROVIDER_COPY,
  PROVIDER_NEXT_STEPS,
  PROVIDER_REASON_COPY,
  PROVIDER_STATE_LABELS,
  PROVIDER_STATE_TONES,
  SECTION_SCOPES,
  SECTION_TITLES,
  lastEventLabel,
  lockedSectionCopy,
  memberConnectionsLabel,
  modelsLabel,
  peopleLabel,
  startupsLabel,
  type DiagnosticsTone,
} from "./diagnostics-copy";
import {
  attentionFor,
  desktopStepSegments,
  desktopSummaryState,
  diagnosticsRowId,
  formatAgo,
  formatDuration,
  providerAvailableModels,
  type DesktopSummaryState,
} from "./diagnostics-data";
import {
  DiagnosticsBadge,
  DiagnosticsCode,
  DiagnosticsFacts,
  DiagnosticsLead,
  DiagnosticsLockedRow,
  DiagnosticsPlainRow,
  DiagnosticsRow,
  DiagnosticsSection,
  type DiagnosticsRowAction,
} from "./diagnostics-row";

type SectionProps = { report: OrgDiagnostics; now: number; orgSlug: string | null };

function toneFor(report: OrgDiagnostics, section: "desktop" | "providers" | "connectors", targetId: string, fallback: DiagnosticsTone): DiagnosticsTone {
  const item = attentionFor(report, section, targetId);
  if (!item) return fallback;
  return item.severity === "error" ? "danger" : "warning";
}

function Icon({ icon: IconComponent }: { icon: typeof Laptop }) {
  return <DiagnosticsLead><IconComponent size={16} strokeWidth={1.5} /></DiagnosticsLead>;
}

function Logo({ name, slug, iconUrl }: { name: string; slug?: string; iconUrl?: string }) {
  return (
    <span aria-hidden="true" className="grid size-5 place-items-center">
      <DenBrandMark name={name} simpleIconSlug={slug} iconUrl={iconUrl} className="h-5 w-5 rounded-[5px] border-gray-100" imageClassName="h-3.5 w-3.5" />
    </span>
  );
}

function LockedSection({ id, title, scope, permission }: { id: string; title: string; scope?: string | null; permission: string }) {
  const copy = lockedSectionCopy(permission);
  return (
    <DiagnosticsSection id={id} title={title} scope={scope} testId={`${id}-locked`}>
      <DiagnosticsLockedRow name={copy.name} sub={copy.sub} />
    </DiagnosticsSection>
  );
}

// ── Desktop app ────────────────────────────────────────────────────────────

const DESKTOP_SUMMARY_BADGES: Record<DesktopSummaryState, { label: string; tone: DiagnosticsTone }> = {
  no_data: { label: DESKTOP_COPY.noData, tone: "neutral" },
  healthy: { label: DESKTOP_COPY.healthy, tone: "success" },
  some_failed: { label: DESKTOP_COPY.someFailed, tone: "warning" },
  not_connecting: { label: DESKTOP_COPY.notConnecting, tone: "danger" },
};

const STEP_SHADES = ["bg-slate-300", "bg-slate-400", "bg-slate-500", "bg-slate-700"] as const;

function StepBar({ desktop }: { desktop: DesktopDiagnostics }) {
  const segments = desktopStepSegments(desktop);
  if (segments.length === 0) return null;
  return (
    <div className="mb-3 mt-1" data-testid="diagnostics-desktop-steps">
      <div role="img" aria-label={DESKTOP_COPY.stepsLabel} className="flex h-2 max-w-[560px] overflow-hidden rounded-full bg-[var(--dls-hover)]">
        {segments.map((segment, index) => (
          <span key={segment.step} className={`block h-full ${STEP_SHADES[index % STEP_SHADES.length]}`} style={{ width: `${segment.percent}%` }} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        {segments.map((segment, index) => (
          <li key={segment.step} className="flex items-center gap-1.5 whitespace-nowrap">
            <span aria-hidden="true" className={`size-2 rounded-sm ${STEP_SHADES[index % STEP_SHADES.length]}`} />
            {DESKTOP_STEP_LABELS[segment.step]} {formatDuration(segment.typicalMs)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function desktopMetric(desktop: DesktopDiagnostics): string {
  if (desktop.typicalMs === null) return desktop.startups === 0 ? DESKTOP_COPY.noStartups : "";
  const typical = `${formatDuration(desktop.typicalMs)} typical`;
  return desktop.slowestMs === null ? typical : `${typical}, ${formatDuration(desktop.slowestMs)} slowest`;
}

export function DesktopSection({ report, now }: SectionProps) {
  const desktop = report.desktop;
  if (desktop.access === "locked") return <LockedSection id="diagnostics-desktop" title={SECTION_TITLES.desktop} scope={SECTION_SCOPES.desktop} permission={desktop.permission} />;
  const summary = DESKTOP_SUMMARY_BADGES[desktopSummaryState(desktop)];
  const anchoredSteps = new Set<string>();
  return (
    <DiagnosticsSection id="diagnostics-desktop" title={SECTION_TITLES.desktop} scope={SECTION_SCOPES.desktop} testId="diagnostics-desktop">
      {desktop.startups === 0 ? (
        <DiagnosticsPlainRow
          lead={<Icon icon={Laptop} />}
          name={DESKTOP_COPY.summaryName}
          sub={DESKTOP_COPY.noStartups}
          state={<DiagnosticsBadge tone={summary.tone}>{summary.label}</DiagnosticsBadge>}
        />
      ) : (
        <DiagnosticsRow
          id={diagnosticsRowId("desktop", "summary")}
          testId="diagnostics-desktop-summary"
          lead={<Icon icon={Laptop} />}
          name={DESKTOP_COPY.summaryName}
          sub={startupsLabel(desktop.startups)}
          metric={desktopMetric(desktop)}
          state={<DiagnosticsBadge tone={summary.tone}>{summary.label}</DiagnosticsBadge>}
        >
          <StepBar desktop={desktop} />
          <DiagnosticsFacts facts={[
            { label: DESKTOP_COPY.people, value: peopleLabel(desktop.people) },
            desktop.versions.length > 0 && {
              label: DESKTOP_COPY.versions,
              value: desktop.versions.map((entry) => `${entry.version} on ${startupsLabel(entry.startups)}`).join(", "),
            },
          ]} />
        </DiagnosticsRow>
      )}
      {desktop.failures.map((failure) => {
        // Attention items point at the step; the first row for each step is its anchor.
        const anchor = anchoredSteps.has(failure.step) ? undefined : diagnosticsRowId("desktop", failure.step);
        anchoredSteps.add(failure.step);
        return (
          <DiagnosticsRow
            key={`${failure.step}-${failure.reason}`}
            id={anchor}
            testId={`diagnostics-desktop-failure-${failure.step}-${failure.reason}`}
            lead={<Icon icon={Laptop} />}
            name={failure.reason === "engine_failed" ? DESKTOP_COPY.failedToStart : DESKTOP_COPY.failureName}
            sub={peopleLabel(failure.people)}
            metric={`${failure.count} of ${desktop.startups}`}
            state={<DiagnosticsBadge tone={toneFor(report, "desktop", failure.step, "warning")}>{DESKTOP_REASON_BADGES[failure.reason]}</DiagnosticsBadge>}
          >
            <DiagnosticsFacts facts={[
              { label: DESKTOP_COPY.stoppedAt, value: `${DESKTOP_STEP_LABELS[failure.step]} (${failure.count})` },
              { label: DESKTOP_COPY.reason, value: DESKTOP_REASON_DETAILS[failure.reason] },
              { label: DESKTOP_COPY.nextStep, value: DESKTOP_REASON_NEXT_STEPS[failure.reason] },
              { label: DESKTOP_COPY.lastSeen, value: formatAgo(failure.lastSeenAt, now) ?? formatServiceTime(failure.lastSeenAt) },
            ]} />
          </DiagnosticsRow>
        );
      })}
    </DiagnosticsSection>
  );
}

// ── AI providers ───────────────────────────────────────────────────────────

/** States where the endpoint stopped working, so "Last worked" is the useful fact. */
const FAILING_PROVIDER_STATES: ReadonlySet<ProviderCheckState> = new Set(["key_rejected", "unreachable", "misconfigured"]);

function providerHref(provider: ProviderCheck, orgSlug: string | null): string {
  if (provider.source === "openwork") return getInferenceRoute(orgSlug);
  if (provider.source === "legacy") return getLlmProvidersRoute(orgSlug);
  return getAiGatewayProvidersRoute(orgSlug);
}

function providerMetric(provider: ProviderCheck, now: number): string {
  const duration = provider.durationMs === null ? null : formatDuration(provider.durationMs);
  if (provider.state === "managed") return PROVIDER_COPY.managed;
  if (provider.state === "member_credentials") return provider.members ? memberConnectionsLabel(provider.members.connected, provider.members.needsAttention) : "";
  if (FAILING_PROVIDER_STATES.has(provider.state)) {
    const ago = formatAgo(provider.lastSuccessAt, now);
    return ago ? `${PROVIDER_COPY.lastWorked} ${ago}` : PROVIDER_COPY.neverWorked;
  }
  if (provider.state === "not_checked") return "";
  const available = providerAvailableModels(provider);
  const models = available === null ? null : modelsLabel(available, provider.models.configured);
  return [models, duration].filter(Boolean).join(", ");
}

function ProviderRow({ provider, report, now, orgSlug }: { provider: ProviderCheck } & SectionProps) {
  const actionLabel = PROVIDER_ACTIONS[provider.state];
  const action: DiagnosticsRowAction | null = actionLabel ? { label: actionLabel, href: providerHref(provider, orgSlug) } : null;
  const nextStep = PROVIDER_NEXT_STEPS[provider.state];
  const failing = FAILING_PROVIDER_STATES.has(provider.state);
  return (
    <DiagnosticsRow
      id={diagnosticsRowId("providers", provider.id)}
      testId={`diagnostics-provider-${provider.id}`}
      lead={<Logo name={provider.name} slug={provider.source === "openwork" ? "openwork" : providerIconSlug(provider.providerId)} />}
      name={provider.name}
      sub={provider.credentialName}
      metric={providerMetric(provider, now)}
      state={<DiagnosticsBadge tone={toneFor(report, "providers", provider.id, PROVIDER_STATE_TONES[provider.state])}>{PROVIDER_STATE_LABELS[provider.state]}</DiagnosticsBadge>}
      action={action}
    >
      <DiagnosticsFacts facts={[
        { label: PROVIDER_COPY.result, value: PROVIDER_REASON_COPY[provider.reason] },
        provider.httpStatus !== null && { label: PROVIDER_COPY.endpointAnswered, value: <DiagnosticsCode>{provider.httpStatus}</DiagnosticsCode> },
        provider.models.missing.length > 0 && {
          label: PROVIDER_COPY.notServed,
          value: (
            <>
              {provider.models.missing.map((model, index) => (
                <span key={model}>{index > 0 ? ", " : null}<DiagnosticsCode>{model}</DiagnosticsCode></span>
              ))}
              {`. ${PROVIDER_COPY.notServedImpact}`}
            </>
          ),
        },
        provider.models.served !== null && {
          label: PROVIDER_COPY.models,
          value: `${provider.models.served} served${provider.models.configured > 0 ? `, ${provider.models.configured} configured` : ""}`,
        },
        provider.members && { label: PROVIDER_COPY.members, value: memberConnectionsLabel(provider.members.connected, provider.members.needsAttention) },
        provider.checkedAt !== null && { label: PROVIDER_COPY.checked, value: formatAgo(provider.checkedAt, now) ?? formatServiceTime(provider.checkedAt) },
        failing && { label: PROVIDER_COPY.lastWorked, value: formatAgo(provider.lastSuccessAt, now) ?? PROVIDER_COPY.neverWorked },
        nextStep !== null && { label: PROVIDER_COPY.nextStep, value: nextStep },
      ]} />
    </DiagnosticsRow>
  );
}

export function ProvidersSection({ report, now, orgSlug }: SectionProps) {
  const providers: OrgDiagnostics["providers"] = report.providers;
  if (providers.access === "locked") return <LockedSection id="diagnostics-providers" title={SECTION_TITLES.providers} scope={SECTION_SCOPES.providers} permission={providers.permission} />;
  return <ProviderRows providers={providers} report={report} now={now} orgSlug={orgSlug} />;
}

function ProviderRows({ providers, ...props }: { providers: ProvidersDiagnostics } & SectionProps) {
  return (
    <DiagnosticsSection id="diagnostics-providers" title={SECTION_TITLES.providers} scope={SECTION_SCOPES.providers} testId="diagnostics-providers">
      {providers.items.length === 0 ? (
        <DiagnosticsPlainRow
          lead={<Icon icon={Waypoints} />}
          name={PROVIDER_COPY.empty}
          action={{ label: PROVIDER_COPY.addProvider, href: getNewAiGatewayProviderRoute(props.orgSlug) }}
        />
      ) : providers.items.map((provider) => <ProviderRow key={provider.id} provider={provider} {...props} />)}
    </DiagnosticsSection>
  );
}

// ── Connectors ─────────────────────────────────────────────────────────────

function connectorMetric(connector: ConnectorCheck, now: number): string {
  if (connector.kind === "google_workspace") {
    return connector.apis.filter((api) => api.status === "enabled").map((api) => api.name).join(", ");
  }
  if (connector.state === "not_checked" || connector.state === "off") return "";
  const ago = formatAgo(connector.lastEventAt, now);
  return ago ? lastEventLabel(ago) : CONNECTOR_COPY.noEvents;
}

function apiNames(connector: ConnectorCheck, status: ConnectorCheck["apis"][number]["status"]): string {
  return connector.apis.filter((api) => api.status === status).map((api) => api.name).join(", ");
}

function ConnectorRow({ connector, report, now, orgSlug }: { connector: ConnectorCheck } & SectionProps) {
  const actionLabel = CONNECTOR_ACTIONS[connector.reason];
  const enabled = apiNames(connector, "enabled");
  const disabled = apiNames(connector, "disabled");
  const unknown = apiNames(connector, "unknown");
  return (
    <DiagnosticsRow
      id={diagnosticsRowId("connectors", connector.id)}
      testId={`diagnostics-connector-${connector.id}`}
      lead={connector.kind === "slack_assistant" ? <Logo name="Slack" slug="slack" /> : <Logo name="Google" iconUrl="/integrations/google.svg" />}
      name={connector.name}
      metric={connectorMetric(connector, now)}
      state={<DiagnosticsBadge tone={toneFor(report, "connectors", connector.id, CONNECTOR_STATE_TONES[connector.state])}>{CONNECTOR_STATE_LABELS[connector.state]}</DiagnosticsBadge>}
      action={actionLabel ? { label: actionLabel, href: getMcpConnectionsRoute(orgSlug) } : null}
    >
      <DiagnosticsFacts facts={[
        { label: CONNECTOR_COPY.checked, value: CONNECTOR_REASON_COPY[connector.reason] },
        connector.completed24h !== null && { label: CONNECTOR_COPY.answers, value: String(connector.completed24h) },
        enabled !== "" && { label: CONNECTOR_COPY.apisOn, value: enabled },
        disabled !== "" && { label: CONNECTOR_COPY.apisOff, value: disabled },
        unknown !== "" && { label: CONNECTOR_COPY.apisUnknown, value: unknown },
        connector.checkedAt !== null && { label: CONNECTOR_COPY.lastChecked, value: formatAgo(connector.checkedAt, now) ?? formatServiceTime(connector.checkedAt) },
      ]} />
    </DiagnosticsRow>
  );
}

export function ConnectorsSection({ report, now, orgSlug }: SectionProps) {
  const connectors: OrgDiagnostics["connectors"] = report.connectors;
  if (connectors.access === "locked") return <LockedSection id="diagnostics-connectors" title={SECTION_TITLES.connectors} permission={connectors.permission} />;
  return <ConnectorRows connectors={connectors} report={report} now={now} orgSlug={orgSlug} />;
}

function ConnectorRows({ connectors, ...props }: { connectors: ConnectorsDiagnostics } & SectionProps) {
  return (
    <DiagnosticsSection id="diagnostics-connectors" title={SECTION_TITLES.connectors} testId="diagnostics-connectors">
      {connectors.items.length === 0 ? (
        <DiagnosticsPlainRow
          lead={<Icon icon={Plug} />}
          name={CONNECTOR_COPY.empty}
          action={{ label: CONNECTOR_COPY.addConnector, href: getAddConnectorRoute(props.orgSlug) }}
        />
      ) : connectors.items.map((connector) => <ConnectorRow key={connector.id} connector={connector} {...props} />)}
    </DiagnosticsSection>
  );
}

// ── Installation ───────────────────────────────────────────────────────────

export function InstallationSection({ report, now }: SectionProps) {
  const installation = report.installation;
  if (installation.access === "operator") {
    return (
      <DiagnosticsSection id="diagnostics-installation" title={SECTION_TITLES.installation} scope={INSTALLATION_COPY.selfHosted} testId="diagnostics-installation">
        <InstallationRows readiness={installation.services} server={installation.server} now={now} />
      </DiagnosticsSection>
    );
  }
  return (
    <DiagnosticsSection id="diagnostics-installation" title={SECTION_TITLES.installation} testId={`diagnostics-installation-${installation.access}`}>
      {installation.access === "managed" ? (
        <DiagnosticsPlainRow lead={<Icon icon={Lock} />} name={INSTALLATION_COPY.managed} />
      ) : (
        <DiagnosticsLockedRow name={INSTALLATION_COPY.lockedName} sub={INSTALLATION_COPY.lockedSub} />
      )}
    </DiagnosticsSection>
  );
}

// ── Advanced › Network check ───────────────────────────────────────────────

function NetworkRow({ canRun, renderNetworkCheck }: { canRun: boolean; renderNetworkCheck: (canRun: boolean) => ReactNode }) {
  // The check loads its own configuration, so it mounts only once the row is opened.
  const [opened, setOpened] = useState(false);
  return (
    <DiagnosticsRow
      id={diagnosticsRowId("network", "egress")}
      testId="diagnostics-network-check"
      lead={<Icon icon={Globe} />}
      name={NETWORK_COPY.name}
      sub={NETWORK_COPY.sub}
      onToggle={(open) => { if (open) setOpened(true); }}
    >
      {opened ? renderNetworkCheck(canRun) : null}
    </DiagnosticsRow>
  );
}

export function NetworkSection({ report, renderNetworkCheck }: { report: OrgDiagnostics; renderNetworkCheck: (canRun: boolean) => ReactNode }) {
  const network = report.network;
  if (network.access === "locked") return <LockedSection id="diagnostics-network" title={SECTION_TITLES.network} permission={network.permission} />;
  return (
    <DiagnosticsSection id="diagnostics-network" title={SECTION_TITLES.network} testId="diagnostics-network">
      <NetworkRow canRun={network.canRun} renderNetworkCheck={renderNetworkCheck} />
    </DiagnosticsSection>
  );
}
