/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { OpenworkCloudMcpHealth } from "@/app/lib/openwork-server";
import { sanitizeCloudMcpHealthDiagnostic } from "@/app/lib/diagnostic-sanitizer";
import { RefreshButton, SettingsInset, SettingsNotice, SettingsStatusBadge } from "../settings-section";
import {
  LayoutSection,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionTitle,
} from "../settings-layout";
import { diagnosticsVersionLine, summarizeDiagnostics } from "./diagnostics-summary";

function DiagnosticRow(props: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-lg border border-gray-6 bg-gray-2/50 p-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
      <div className="text-[11px] font-semibold text-gray-9">{props.label}</div>
      <div className="min-w-0 break-all font-mono text-[11px] text-gray-12">{props.value}</div>
    </div>
  );
}

function joinList(values: string[]): string {
  return values.length ? values.join(", ") : "none";
}

function formatMaybe(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === "") return "unknown";
  return String(value);
}

function formatMetadataRecord(value: Record<string, string | number | boolean | null> | null | undefined): string {
  if (!value || Object.keys(value).length === 0) return "none";
  return Object.entries(value).map(([key, nested]) => `${key}=${formatMaybe(nested)}`).join(", ");
}

function formatSupportedFeatures(features: OpenworkCloudMcpHealth["compatibility"]["supportedFeatures"]): string {
  return Object.entries(features).map(([key, enabled]) => `${key}:${enabled ? "yes" : "no"}`).join(", ");
}

function formatPluginHashes(hashes: OpenworkCloudMcpHealth["compatibility"]["pluginFileHashes"]): string {
  if (hashes.length === 0) return "none";
  return hashes.map((hash) => `${hash.name}=${hash.sha256 ? hash.sha256.slice(0, 12) : `unavailable${hash.error ? ` (${hash.error})` : ""}`}`).join(", ");
}

function formatMcpToolExposure(input: { checked: boolean; includesMcpTools: boolean | null; present: string[]; missing: string[]; limitation?: string }): string {
  if (!input.checked) return "not checked";
  const includes = input.includesMcpTools === null ? "unknown" : input.includesMcpTools ? "yes" : "no";
  return `includes MCP tools: ${includes}; present ${joinList(input.present)}; missing ${joinList(input.missing)}${input.limitation ? `; limitation: ${input.limitation}` : ""}`;
}

function formatCheckedAt(checkedAt: string): string | null {
  const date = new Date(checkedAt);
  if (Number.isNaN(date.getTime())) return null;
  return `checked ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** The exact runtime state, for the support engineer reading over someone's shoulder. Closed by default. */
function TechnicalDetails(props: { health: OpenworkCloudMcpHealth }) {
  const health = props.health;
  const projection = health.tools.providerProjection;
  const compatibility = health.compatibility;

  return (
    <details className="group">
      <summary className="flex w-fit cursor-pointer items-center gap-1 text-xs text-muted-foreground">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        Technical details
      </summary>
      <div className="mt-3 grid gap-2">
        <DiagnosticRow label="Active workspace" value={`${health.workspace.id} (${health.workspace.directory ?? "no directory"})`} />
        <DiagnosticRow label="Desired revision" value={health.desired.revision ?? "none"} />
        <DiagnosticRow label="Applied revision" value={health.delivery.appliedRevision ?? "none"} />
        <DiagnosticRow label="Delivery" value={`${health.delivery.state}${health.delivery.trigger ? ` / ${health.delivery.trigger}` : ""}`} />
        <DiagnosticRow label="Engine status" value={health.engine.status} />
        {health.engineInspection?.checked ? (
          <DiagnosticRow
            label="Engine MCP servers"
            value={(health.engineInspection.servers ?? []).length
              ? (health.engineInspection.servers ?? []).map((server) => `${server.name} ${server.status}${server.error ? ` (${server.error})` : ""}`).join("; ")
              : "none tracked"}
          />
        ) : null}
        <DiagnosticRow label="Provider/model" value={projection?.checked ? `${projection.provider ?? "unknown"}/${projection.model ?? "unknown"}; source ${projection.source ?? "unknown"}; tool calling ${formatMaybe(projection.toolCalling)}; present ${joinList(projection.present)}; missing ${joinList(projection.missing)}${projection.limitation ? `; limitation: ${projection.limitation}` : ""}` : "not checked"} />
        <DiagnosticRow label="Cloud tools" value={`derived present ${joinList(health.tools.present)}; missing ${joinList(health.tools.missing)}`} />
        <DiagnosticRow label="Direct tools/list" value={`checked ${health.tools.direct.checked ? "yes" : "no"}; present ${joinList(health.tools.direct.present)}; missing ${joinList(health.tools.direct.missing)}`} />
        {health.tools.direct.trace ? (
          <DiagnosticRow
            label="Direct probe"
            value={`${health.tools.direct.trace.endpoint ?? "unknown endpoint"} · ${health.tools.direct.trace.latencyMs} ms · ${health.tools.direct.trace.steps.map((step) => `${step.step} ${step.ok ? "ok" : "failed"}${step.httpStatus !== undefined ? ` (HTTP ${step.httpStatus})` : ""} ${Math.max(0, Math.round(step.latencyMs))}ms`).join(" → ") || "no steps"}`}
          />
        ) : null}
        {health.firstFailure ? (
          <DiagnosticRow
            label="First failure"
            value={`${health.firstFailure.code} (stage ${health.firstFailure.stage}; ${health.firstFailure.retryable ? "retryable" : "not retryable"}): ${health.firstFailure.message}`}
          />
        ) : null}
        <DiagnosticRow label="Plugin canaries" value={`present ${joinList(health.pluginCanaries.present)}; missing ${joinList(health.pluginCanaries.missing)}`} />
        <DiagnosticRow label="Safe capabilities" value={`schema v${health.schemaVersion}; connect catalog ${health.connectCatalogEnabled ? "enabled" : "disabled"}`} />
        {compatibility ? (
          <>
            <DiagnosticRow label="OpenWork versions" value={`server ${formatMaybe(compatibility.openwork.serverVersion)}; app ${formatMetadataRecord(compatibility.openwork.app)}`} />
            <DiagnosticRow label="OpenCode compatibility" value={`expected ${formatMaybe(compatibility.opencode.expectedVersion)}; actual ${formatMaybe(compatibility.opencode.actualVersion)}; probe ${compatibility.opencode.probe}`} />
            <DiagnosticRow label="Feature probes" value={formatSupportedFeatures(compatibility.supportedFeatures)} />
            <DiagnosticRow label="Experimental tool IDs" value={formatMcpToolExposure(compatibility.experimentalToolIds)} />
            <DiagnosticRow label="Experimental provider tools" value={formatMcpToolExposure(compatibility.experimentalProviderTools)} />
            <DiagnosticRow label="Plugin hashes" value={formatPluginHashes(compatibility.pluginFileHashes)} />
          </>
        ) : null}
        <DiagnosticRow label="Live verification" value={health.checkedAt} />
        <details className="rounded-lg bg-gray-3 p-2">
          <summary className="cursor-pointer text-[11px] font-medium text-gray-11">Show sanitized health JSON</summary>
          <pre className="mt-2 max-h-72 overflow-auto font-mono text-[11px] text-gray-11">
            {JSON.stringify(sanitizeCloudMcpHealthDiagnostic(health), null, 2)}
          </pre>
        </details>
      </div>
    </details>
  );
}

export interface AdvancedDiagnosticsSectionProps {
  appVersion: string | null;
  signedIn: boolean;
  orgSelected: boolean;
  cloudMcpHealth: OpenworkCloudMcpHealth | null;
  onRefresh: () => Promise<OpenworkCloudMcpHealth | null>;
  /** Copies the full sanitized report and tells the person it worked. */
  onCopyReport: () => Promise<void>;
}

export function AdvancedDiagnosticsSection(props: AdvancedDiagnosticsSectionProps) {
  const [checking, setChecking] = useState(false);
  const [copying, setCopying] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const autoChecked = useRef(false);

  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      await props.onRefresh();
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : "Could not run the check.");
    } finally {
      setChecking(false);
    }
  };

  const copy = async () => {
    setCopying(true);
    try {
      await props.onCopyReport();
    } finally {
      setCopying(false);
    }
  };

  // "Run diagnostics" lands here: show a result instead of asking for another click.
  useEffect(() => {
    if (autoChecked.current || props.cloudMcpHealth || !props.signedIn || !props.orgSelected) return;
    autoChecked.current = true;
    void check();
  }, [props.cloudMcpHealth, props.signedIn, props.orgSelected]);

  const summary = summarizeDiagnostics({
    checking,
    signedIn: props.signedIn,
    orgSelected: props.orgSelected,
    health: props.cloudMcpHealth,
  });
  const facts = [
    diagnosticsVersionLine({ appVersion: props.appVersion, health: props.cloudMcpHealth }),
    props.cloudMcpHealth ? formatCheckedAt(props.cloudMcpHealth.checkedAt) : null,
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <LayoutSection id="advanced-agent-access">
      <LayoutSectionHeader>
        <LayoutSectionTitle>Diagnostics</LayoutSectionTitle>
      </LayoutSectionHeader>

      <LayoutSectionItem>
        <SettingsInset className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1" data-testid="diagnostics-summary">
            <SettingsStatusBadge
              className="min-h-0 px-0 text-sm text-foreground"
              tone={summary.tone}
              label={summary.label}
            />
            <div className="text-sm text-muted-foreground">{summary.detail}</div>
            {facts.length > 0 ? (
              <div className="text-xs text-muted-foreground" data-testid="diagnostics-versions">
                {facts.join(" — ")}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <RefreshButton busy={checking} disabled={checking} onRefresh={check}>
              Check again
            </RefreshButton>
            <Button
              type="button"
              size="sm"
              title="Copies a report to send to OpenWork support. Passwords and tokens are removed."
              onClick={() => void copy()}
              disabled={copying}
            >
              <Copy size={14} />
              Copy report
            </Button>
          </div>
        </SettingsInset>

        {checkError ? <SettingsNotice tone="error">{checkError}</SettingsNotice> : null}
        {props.cloudMcpHealth ? <TechnicalDetails health={props.cloudMcpHealth} /> : null}
      </LayoutSectionItem>
    </LayoutSection>
  );
}
