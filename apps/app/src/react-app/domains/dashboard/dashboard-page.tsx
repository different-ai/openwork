/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Blocks } from "lucide-react";

import { readDenSettings } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { Skeleton } from "@/components/ui/skeleton";
import { CloudSignInBanner, CloudSignInBannerIcon } from "@/react-app/domains/cloud/cloud-sign-in-banner";
import { t } from "../../../i18n";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { dashboardTileCacheScopeKey } from "./dashboard-tile-cache";
import type { DashboardLaunchEndpoint } from "./mcp-app-tile";
import { DashboardApps, type CreateDashboardApp } from "./dashboard-apps";
import { useSavedApps } from "../apps/use-apps";

/** The member's dashboard. Placement belongs to each member. */
export function DashboardPage({ fallbackEndpoints, onCreateApp, headerActionsTarget, onSignIn }: {
  onCreateApp: CreateDashboardApp;
  /** Opens OpenWork Cloud sign-in, the same action Library offers when signed out. */
  onSignIn?: () => void;
  /** Titlebar slot for the Add control, matching Library. */
  headerActionsTarget?: HTMLElement | null;
  /** Other workspace MCP runtimes tiles may launch through when the primary one lacks their server. */
  fallbackEndpoints?: DashboardLaunchEndpoint[];
}) {
  const denAuth = useDenAuth();
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
  // and nothing is launched or fetched, and the page leads with the same
  // sign-in banner as Library.
  if (denAuth.status !== "checking" && !denAuth.isSignedIn) return <DashboardSignedOut onSignIn={onSignIn} />;

  // Hold the board (and every launch) until its user/org scope and saved apps
  // are final.
  if (denAuth.status === "checking"
    || (Boolean(personal.client && personal.orgId) && personal.query.isPending && !personal.query.isFetched)) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-8 sm:px-8" data-dashboard-page>
        <div className="space-y-2 pt-3" role="status" aria-label="Loading dashboard">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }
  return (
    <div
      className="mx-auto w-full max-w-5xl px-6 py-8 sm:px-8"
      data-dashboard-page
      data-dashboard-cache-scope={cacheScopeKey}
    >
      <DashboardApps key={cacheScopeKey} onCreateApp={onCreateApp} fallbackEndpoints={fallbackEndpoints} headerActionsTarget={headerActionsTarget} />
    </div>
  );
}

function DashboardSignedOut({ onSignIn }: { onSignIn?: () => void }) {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 px-6 py-8 sm:px-8" data-dashboard-page data-dashboard-signed-out>
      <CloudSignInBanner
        testId="dashboard-sign-in-banner"
        media={<CloudSignInBannerIcon><Blocks /></CloudSignInBannerIcon>}
        message={t("dashboard.sign_in_banner")}
        onSignIn={onSignIn}
      />
      <section className="flex min-h-96 flex-col items-center justify-center text-center" data-dashboard-empty>
        <div aria-hidden="true" className="mb-10 grid w-full max-w-xl grid-cols-[2fr_3fr_2fr] gap-4">{[0, 1, 2].map((index) => <div key={index} className="h-32 rounded-xl border border-dashed bg-muted/30 p-5">
          <div className="h-2.5 w-3/5 rounded-full bg-muted" />
          <div className="mt-3 h-6 w-10 rounded-md bg-muted" />
        </div>)}</div>
        <h2 className="text-xl font-semibold">Pin the artifacts you check every day</h2>
      </section>
    </div>
  );
}
