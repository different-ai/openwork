"use client";

import { useEffect, useState } from "react";
import { diagnosticsReportText } from "../../../../components/diagnostics/diagnostics-data";
import { DiagnosticsView } from "../../../../components/diagnostics/diagnostics-view";
import { useOrgDiagnostics } from "../../../../components/diagnostics/use-org-diagnostics";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EgressDiagnosticsCard } from "./egress-diagnostics-card";

const COPIED_MS = 1_600;
const CLOCK_MS = 30_000;

export function DiagnosticsScreen() {
  const { orgContext, orgSlug } = useOrgDashboard();
  const orgId = orgContext?.organization.id ?? "";
  // A different organization gets a fresh view and never another organization's report.
  return <DiagnosticsContent key={orgId} orgId={orgId} orgSlug={orgSlug} />;
}

function DiagnosticsContent({ orgId, orgSlug }: { orgId: string; orgSlug: string | null }) {
  const diagnostics = useOrgDiagnostics(orgId, orgId.length > 0);
  const [copied, setCopied] = useState(false);
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyReport() {
    if (!diagnostics.report) return;
    try {
      await navigator.clipboard.writeText(diagnosticsReportText(diagnostics.report));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <DiagnosticsView
      report={diagnostics.report}
      loading={diagnostics.loading}
      loadFailure={diagnostics.loadFailure}
      checkFailed={diagnostics.checkFailed}
      checking={diagnostics.checking}
      cooldownSeconds={diagnostics.cooldownSeconds}
      copied={copied}
      now={Math.max(clock, diagnostics.dataUpdatedAt)}
      orgSlug={orgSlug}
      onCheckNow={diagnostics.checkNow}
      onCopyReport={() => void copyReport()}
      onRetry={diagnostics.refresh}
      renderNetworkCheck={(canRun) => <EgressDiagnosticsCard variant="embedded" canView canManage={canRun} />}
    />
  );
}
