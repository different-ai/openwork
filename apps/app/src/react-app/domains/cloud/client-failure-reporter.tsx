import { useEffect } from "react";
import { createDenClient, readDenSettings, resolveDenBaseUrls } from "@/app/lib/den";
import { desktopBridge } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { subscribeClientFailures } from "@/app/lib/client-failure-events";
import { useDenAuth } from "./den-auth-provider";
import { useOrgFeatureState } from "./use-org-feature";

export function ClientFailureReporter() {
  const auth = useDenAuth();
  const feature = useOrgFeatureState("clientFailureReports", { desktopOnly: true });
  const enabled = feature.enabled;
  const settings = readDenSettings();
  const token = settings.authToken ?? "";
  const organizationId = settings.activeOrgId ?? "";
  const baseUrl = resolveDenBaseUrls(settings).apiBaseUrl;
  const principalId = auth.verifiedIdentity?.principalId;
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    if (!token || auth.status === "signed_out" || (feature.resolved && !enabled)) {
      void desktopBridge.clientFailuresConfigure({ enabled: false }).catch(() => undefined);
      return;
    }
    if (!enabled || !principalId || !organizationId || !auth.isSignedIn) return;
    let stopped = false;
    let busy = false;
    const ready = desktopBridge.clientFailuresConfigure({ enabled: true, principalId, organizationId, denBaseUrl: baseUrl, token }).then(() => true, () => false);
    const flush = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        if (!await ready || stopped) return;
        const reports = await desktopBridge.clientFailuresBatch();
        if (!reports.length) return;
        const current = readDenSettings();
        const sameTarget = current.authToken === token && current.activeOrgId === organizationId
          && resolveDenBaseUrls(current).apiBaseUrl === baseUrl;
        let delivered = false;
        if (!stopped && sameTarget) delivered = await createDenClient({ ...current, token }).reportClientFailures(organizationId, reports).catch(() => false);
        await desktopBridge.clientFailuresSettle(reports.map((report) => report.reportId), delivered);
      } catch {} finally { busy = false; }
    };
    const unsubscribe = subscribeClientFailures((failure, target) => {
      if (target.token !== token || target.organizationId !== organizationId || target.baseUrl !== baseUrl || stopped) return;
      if (!failure) void flush();
    });
    void flush();
    const timer = setInterval(() => { void flush(); }, 30_000);
    return () => { stopped = true; clearInterval(timer); unsubscribe(); };
  }, [enabled, feature.resolved, principalId, token, organizationId, baseUrl, auth.isSignedIn, auth.status]);
  return null;
}
