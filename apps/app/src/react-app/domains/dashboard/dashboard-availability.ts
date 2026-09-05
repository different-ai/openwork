import { useDesktopConfig } from "@/react-app/domains/cloud/desktop-config-provider";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";

/**
 * Deployment-level Dashboard availability advertised by Den.
 *
 * Older Den versions and stale cached configs omit the field. Treat both as
 * disabled so hosted and self-deployed installations stay fail-closed.
 */
export function useDashboardDeploymentAvailability(): { enabled: boolean; loading: boolean } {
  const { config, freshConfigStatus, loading } = useDesktopConfig();
  const denAuth = useDenAuth();
  const decisionPending = loading
    || denAuth.status === "checking"
    || freshConfigStatus === "pending";
  return {
    enabled: !decisionPending
      && freshConfigStatus === "ready"
      && config.dashboardEnabled === true,
    loading: decisionPending,
  };
}
