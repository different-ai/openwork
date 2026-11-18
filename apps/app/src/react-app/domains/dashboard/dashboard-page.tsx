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

/** The member's dashboard. Placement belongs to each member. */
export function DashboardPage({ fallbackEndpoints, onCreateApp, headerActionsTarget, onSignIn, active = true }: {
  onCreateApp: CreateDashboardApp;
  /** Retained pages refresh access when navigation makes them visible again. */
  active?: boolean;
  /** Opens OpenWork Cloud sign-in, the same action Library offers when signed out. */
  onSignIn?: () => void;
  /** Titlebar slot for the Add control, matching Library. */
  headerActionsTarget?: HTMLElement | null;
  /** Other workspace MCP runtimes tiles may launch through when the primary one lacks their server. */
  fallbackEndpoints?: DashboardLaunchEndpoint[];
}) {
  const denAuth = useDenAuth();
  const { openworkServerClient } = useWorkspace();
  const personal = useSavedApps();
  // The active org lives in den settings, which change outside React; track
  // them through the settings-changed event so an org switch swaps the board
  // scope.
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

  // The dashboard belongs to the signed-in member: signed out, no tile mounts
  // and nothing is launched or fetched, and the page is one empty state whose
  // action is signing in.
  if (denAuth.status !== "checking" && !denAuth.isSignedIn) return <DashboardSignedOut onSignIn={onSignIn} />;

  // Hold the board (and every launch) until its user/org scope and saved apps
  // are final.
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
