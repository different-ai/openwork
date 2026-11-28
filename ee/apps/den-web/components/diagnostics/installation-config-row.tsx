"use client";

import { Check, Copy, Download, SlidersHorizontal } from "lucide-react";
import type { InstallationConfig } from "@openwork/types/den/diagnostics";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { INSTALLATION_CONFIG_COPY } from "./diagnostics-copy";
import { diagnosticsRowId, installationVersionState } from "./diagnostics-data";
import { DiagnosticsBadge, DiagnosticsCode, DiagnosticsFacts, DiagnosticsLead, DiagnosticsRow } from "./diagnostics-row";

export type InstallationConfigActions = { copied: boolean; onCopy: () => void; onDownload: () => void };

function VersionBadge({ config }: { config: InstallationConfig }) {
  const state = installationVersionState(config);
  if (state === "mismatch") return <DiagnosticsBadge tone="warning">{INSTALLATION_CONFIG_COPY.mismatch}</DiagnosticsBadge>;
  if (state === "match") return <DiagnosticsBadge tone="neutral">{INSTALLATION_CONFIG_COPY.match}</DiagnosticsBadge>;
  return null;
}

function LockedFeatures({ config }: { config: InstallationConfig }) {
  const locked = Object.entries(config.lockedFeatures);
  if (locked.length === 0) return INSTALLATION_CONFIG_COPY.noLockedFeatures;
  return locked.map(([key, on], index) => (
    <span key={key}>
      {index > 0 ? ", " : null}
      <DiagnosticsCode>{key}</DiagnosticsCode> {on ? INSTALLATION_CONFIG_COPY.on : INSTALLATION_CONFIG_COPY.off}
    </span>
  ));
}

export function InstallationConfigRow({ config, actions }: { config: InstallationConfig; actions: InstallationConfigActions }) {
  const mismatch = config.versionSkew && config.helmAppVersion;
  return (
    <DiagnosticsRow
      id={diagnosticsRowId("installation", "config")}
      testId="installation-config"
      detailsTestId="installation-config-details"
      summaryTestId="installation-config-toggle"
      stateTestId="installation-config-state"
      lead={<DiagnosticsLead><SlidersHorizontal size={16} strokeWidth={1.5} /></DiagnosticsLead>}
      name={INSTALLATION_CONFIG_COPY.name}
      sub={config.helmChartVersion ? INSTALLATION_CONFIG_COPY.chart(config.helmChartVersion) : null}
      metric={INSTALLATION_CONFIG_COPY.running(config.appVersion)}
      state={<VersionBadge config={config} />}
    >
      <DiagnosticsFacts facts={[
        mismatch ? { label: INSTALLATION_CONFIG_COPY.mismatchLabel, value: INSTALLATION_CONFIG_COPY.mismatchDetail(mismatch, config.appVersion) } : null,
        { label: INSTALLATION_CONFIG_COPY.runningVersion, value: <DiagnosticsCode>{config.appVersion}</DiagnosticsCode> },
        config.helmChartVersion ? { label: INSTALLATION_CONFIG_COPY.chartVersion, value: <DiagnosticsCode>{config.helmChartVersion}</DiagnosticsCode> } : null,
        config.helmAppVersion ? { label: INSTALLATION_CONFIG_COPY.chartAppVersion, value: <DiagnosticsCode>{config.helmAppVersion}</DiagnosticsCode> } : null,
        { label: INSTALLATION_CONFIG_COPY.lockedFeatures, value: <LockedFeatures config={config} /> },
        { label: INSTALLATION_CONFIG_COPY.contents, value: INSTALLATION_CONFIG_COPY.contentsValue },
      ]} />
      <div className="mt-3 flex flex-wrap gap-2">
        <DenButton data-testid="installation-config-copy" variant="secondary" size="sm" icon={actions.copied ? Check : Copy} onClick={actions.onCopy}>
          {actions.copied ? INSTALLATION_CONFIG_COPY.copied : INSTALLATION_CONFIG_COPY.copy}
        </DenButton>
        <DenButton data-testid="installation-config-download" variant="secondary" size="sm" icon={Download} onClick={actions.onDownload}>
          {INSTALLATION_CONFIG_COPY.download}
        </DenButton>
      </div>
    </DiagnosticsRow>
  );
}
