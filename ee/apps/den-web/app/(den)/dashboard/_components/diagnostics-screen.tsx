"use client";

import { useEffect, useState } from "react";
import { diagnosticsReportText, installationConfigExportText, installationConfigFileName } from "../../../../components/diagnostics/diagnostics-data";
import { DiagnosticsView } from "../../../../components/diagnostics/diagnostics-view";
import { useOrgDiagnostics } from "../../../../components/diagnostics/use-org-diagnostics";
import { orgFeatureEnabled } from "../../_lib/den-org";
import { markFeatureUsed } from "../../_lib/feature-usage";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const COPIED_MS = 1_600;
const CLOCK_MS = 30_000;

export function DiagnosticsScreen() {
  const { orgContext, orgSlug } = useOrgDashboard();
  const orgId = orgContext?.organization.id ?? "";
  const configExport = orgFeatureEnabled(orgContext, "diagnosticsConfigExport");
  return <DiagnosticsContent key={orgId} orgId={orgId} orgSlug={orgSlug} configExport={configExport} />;
}

function saveTextFile(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DiagnosticsContent({ orgId, orgSlug, configExport }: { orgId: string; orgSlug: string | null; configExport: boolean }) {
  const diagnostics = useOrgDiagnostics(orgId, { enabled: orgId.length > 0, includeConfig: configExport });
  const [copied, setCopied] = useState<"report" | "config" | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(what: "report" | "config", text: string | null) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setCopied(null);
    }
  }

  async function copyReport() {
    if (diagnostics.report) await copy("report", diagnosticsReportText(diagnostics.report));
  }

  async function copyConfig() {
    if (!diagnostics.report) return;
    await copy("config", installationConfigExportText(diagnostics.report));
    markFeatureUsed("diagnosticsConfigExport");
  }

  function downloadConfig() {
    const text = diagnostics.report ? installationConfigExportText(diagnostics.report) : null;
    if (!diagnostics.report || !text) return;
    saveTextFile(installationConfigFileName(diagnostics.report), text);
    markFeatureUsed("diagnosticsConfigExport");
  }

  return (
    <DiagnosticsView
      report={diagnostics.report}
      loading={diagnostics.loading}
      loadFailure={diagnostics.loadFailure}
      checkFailed={diagnostics.checkFailed}
      checking={diagnostics.checking}
      cooldownSeconds={diagnostics.cooldownSeconds}
      copied={copied === "report"}
      now={Math.max(clock, diagnostics.dataUpdatedAt)}
      orgSlug={orgSlug}
      onCheckNow={diagnostics.checkNow}
      onCopyReport={() => void copyReport()}
      onRetry={diagnostics.refresh}
      configActions={configExport ? { copied: copied === "config", onCopy: () => void copyConfig(), onDownload: downloadConfig } : null}
    />
  );
}
