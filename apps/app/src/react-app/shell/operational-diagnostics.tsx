import { useEffect } from "react";
import { desktopBridge, readInitialDesktopBootstrapConfig } from "@/app/lib/desktop";
import { useOrgFeatureState } from "@/react-app/domains/cloud/use-org-feature";

function ConfiguredOperationalDiagnostics() {
  const feature = useOrgFeatureState("operationalDiagnostics", { desktopOnly: true });
  const enabled = feature.enabled && feature.resolved;
  useEffect(() => {
    void desktopBridge.operationalDiagnostics(enabled).catch(() => {});
    return () => { void desktopBridge.operationalDiagnostics(false).catch(() => {}); };
  }, [enabled]);
  return null;
}

export function OperationalDiagnostics() {
  return readInitialDesktopBootstrapConfig()?.diagnostics?.enabled === true
    ? <ConfiguredOperationalDiagnostics />
    : null;
}
