/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Blocks } from "lucide-react";

import { readDenSettings } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { McpAppWarmSandbox } from "@/components/chat/mcp-app-warm-sandbox";
import { Skeleton } from "@/components/ui/skeleton";
import { CloudSignInEmptyState } from "@/react-app/domains/cloud/cloud-sign-in-banner";
import { t } from "../../../i18n";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { useWorkspace } from "@/react-app/shell/workspace-provider";
import { dashboardTileCacheScopeKey } from "./dashboard-tile-cache";
import type { DashboardLaunchEndpoint } from "./mcp-app-tile";
import type { CreateDashboardApp } from "./dashboard-apps";
import { useSavedApps } from "../apps/use-apps";
import { ArtifactsPage } from "./artifacts-page";

export function DashboardPage({ fallbackEndpoints, onCreateApp, headerActionsTarget, onSignIn, active = true }: {
  onCreateApp: CreateDashboardApp;
  active?: boolean;
  onSignIn?: () => void;
  headerActionsTarget?: HTMLElement | null;
  fallbackEndpoints?: DashboardLaunchEndpoint[];
}) {
  const denAuth = useDenAuth();
  const { openworkServerClient } = useWorkspace();
  const personal = useSavedApps();
  const [denSettings, setDenSettings] = useState(() => readDenSettings());
  useEffect(() => {
    const sync = () => setDenSettings(readDenSettings());
    window.addEventListener(denSettingsChangedEvent, sync);
    return () => window.removeEventListener(denSettingsChangedEvent, sync);
  }, []);
  const activeOrgId = denSettings.activeOrgId ?? null;
  const cacheScopeKey = useMemo(
    () => `${dashboardTileCacheScopeKey(denAuth.user?.id ?? null, activeOrgId)}.deployment.${encodeURIComponent(JSON.stringify([denSettings.baseUrl, denSettings.apiBaseUrl]))}`,
    [activeOrgId, denAuth.user?.id, denSettings.baseUrl, denSettings.apiBaseUrl],
  );

  if (denAuth.status !== "checking" && !denAuth.isSignedIn) return <DashboardSignedOut onSignIn={onSignIn} />;

  if (denAuth.status === "checking"
    || (Boolean(personal.client && personal.orgId) && personal.query.isPending && !personal.query.isFetched)) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-8 sm:px-8" data-dashboard-page>
        <div className="space-y-2 pt-3" role="status" aria-label="Loading artifacts">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }
  return (
    <div
      className="h-full w-full"
      data-dashboard-page
      data-dashboard-cache-scope={cacheScopeKey}
    >
      {openworkServerClient ? <McpAppWarmSandbox client={openworkServerClient} /> : null}
      <ArtifactsPage key={cacheScopeKey} active={active} onCreateApp={onCreateApp} fallbackEndpoints={fallbackEndpoints} headerActionsTarget={headerActionsTarget} />
    </div>
  );
}

function DashboardSignedOut({ onSignIn }: { onSignIn?: () => void }) {
  return (
    <div className="h-full w-full" data-dashboard-page data-dashboard-signed-out>
      <CloudSignInEmptyState
        testId="dashboard-sign-in"
        icon={<Blocks />}
        title={t("dashboard.signed_out_title")}
        onSignIn={onSignIn}
      />
    </div>
  );
}
