/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Blocks } from "lucide-react";

import { createDenClient, readDenSettings, type DenGrantedDashboard } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { dashboardTileCacheScopeKey } from "./dashboard-tile-cache";
import {
  grantedConsentScopeKey,
  grantedDashboardEntry,
  grantedEntryId,
  readGrantedConsent,
  writeGrantedConsent,
  type GrantedConsentMap,
} from "./granted-dashboard-store";
import { McpAppTile, type DashboardLaunchEndpoint } from "./mcp-app-tile";
import { DashboardApps, type CreateDashboardApp } from "./dashboard-apps";

/**
 * Personal apps alongside the dashboards shared by the organization.
 * Company definitions stay in Den; personal placement belongs to each member.
 */
export function DashboardPage({ fallbackEndpoints, onCreateApp }: {
  onCreateApp: CreateDashboardApp;
  /** Other workspace MCP runtimes tiles may launch through when the primary one lacks their server. */
  fallbackEndpoints?: DashboardLaunchEndpoint[];
}) {
  const denAuth = useDenAuth();
  // The active org lives in den settings, which change outside React; track
  // them through the settings-changed event so an org switch swaps the board
  // scope and the granted-dashboard fetch together.
  const [denSettings, setDenSettings] = useState(() => readDenSettings());
  useEffect(() => {
    const sync = () => setDenSettings(readDenSettings());
    window.addEventListener(denSettingsChangedEvent, sync);
    return () => window.removeEventListener(denSettingsChangedEvent, sync);
  }, []);
  const activeOrgId = denSettings.activeOrgId ?? null;
  const consentScopeKey = useMemo(
    () => grantedConsentScopeKey(denAuth.user?.id ?? null, activeOrgId),
    [activeOrgId, denAuth.user?.id],
  );
  const cacheScopeKey = useMemo(
    () => dashboardTileCacheScopeKey(denAuth.user?.id ?? null, activeOrgId),
    [activeOrgId, denAuth.user?.id],
  );

  const token = denSettings.authToken?.trim() || null;
  const denClient = useMemo(
    () => (token ? createDenClient({
      baseUrl: denSettings.baseUrl,
      apiBaseUrl: denSettings.apiBaseUrl,
      token,
    }) : null),
    [denSettings.apiBaseUrl, denSettings.baseUrl, token],
  );
  const grantedReady = denAuth.isSignedIn && Boolean(denClient && activeOrgId);
  const grantedQuery = useQuery({
    queryKey: ["den", "granted-dashboards", denAuth.user?.id ?? null, activeOrgId],
    queryFn: () => {
      if (!denClient || !activeOrgId) return Promise.resolve([]);
      return denClient.listGrantedDashboards(activeOrgId);
    },
    enabled: grantedReady,
    staleTime: 30_000,
  });

  // Hold the board (and every launch) until its user/org scope and managed
  // dashboard payload are final.
  if (denAuth.status === "checking" || (grantedReady && grantedQuery.isPending)) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-6" data-dashboard-page>
        <div className="space-y-2 pt-3" role="status" aria-label="Loading dashboard">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }
  return (
    <DashboardBoard
      key={consentScopeKey}
      consentScopeKey={consentScopeKey}
      cacheScopeKey={cacheScopeKey}
      grantedDashboards={grantedReady ? grantedQuery.data ?? [] : []}
      grantedError={grantedReady && grantedQuery.error ? true : false}
      fallbackEndpoints={fallbackEndpoints}
      onCreateApp={onCreateApp}
    />
  );
}

function DashboardBoard({ consentScopeKey, cacheScopeKey, grantedDashboards, grantedError, fallbackEndpoints, onCreateApp }: {
  onCreateApp: CreateDashboardApp;
  consentScopeKey: string;
  cacheScopeKey: string;
  /** Organization-managed dashboards granted to this member, rendered read-only. */
  grantedDashboards: DenGrantedDashboard[];
  grantedError: boolean;
  fallbackEndpoints?: DashboardLaunchEndpoint[];
}) {
  const [consent, setConsent] = useState<GrantedConsentMap>(() => readGrantedConsent(consentScopeKey));
  useEffect(() => {
    setConsent(readGrantedConsent(consentScopeKey));
  }, [consentScopeKey]);
  const updateConsent = (id: string, patch: { launchApproved?: true; autoLaunch?: boolean }) => {
    setConsent((current) => {
      const next: GrantedConsentMap = { ...current, [id]: { ...current[id], ...patch } };
      writeGrantedConsent(consentScopeKey, next);
      return next;
    });
  };

  return (
    <div
      className="mx-auto w-full max-w-6xl px-6 py-6"
      data-dashboard-page
      data-dashboard-cache-scope={cacheScopeKey}
      data-dashboard-consent-scope={consentScopeKey}
    >
      <DashboardApps key={consentScopeKey} onCreateApp={onCreateApp} />
      {grantedError ? (
        <p className="mb-4 text-xs text-muted-foreground" role="status">
          Your organization&apos;s dashboards could not be loaded right now.
        </p>
      ) : null}
      {grantedDashboards.map((dashboard) => (
        <section key={dashboard.id} className="mb-6" data-granted-dashboard={dashboard.id}>
          <header className="mb-2 flex items-baseline gap-2">
            <h2 className="text-sm font-medium">{dashboard.name}</h2>
            <span className="text-xs text-muted-foreground">From your company</span>
          </header>
          {dashboard.elements.length === 0 ? (
            <p className="text-xs text-muted-foreground">This dashboard has no apps yet.</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-4">
              {dashboard.elements.map((element) => {
                const id = grantedEntryId(dashboard.id, element);
                return (
                  <McpAppTile
                    key={id}
                    entry={grantedDashboardEntry(dashboard, element, consent[id])}
                    cacheScopeKey={cacheScopeKey}
                    onApprovedLaunch={() => updateConsent(id, { launchApproved: true })}
                    onAutoLaunchEnabled={() => updateConsent(id, { autoLaunch: true })}
                    onAutoLaunchDisabled={() => updateConsent(id, { autoLaunch: false })}
                    fallbackEndpoints={fallbackEndpoints}
                  />
                );
              })}
            </div>
          )}
        </section>
      ))}
      {!grantedError && grantedDashboards.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Blocks /></EmptyMedia>
            <EmptyTitle>No company apps yet</EmptyTitle>
            <EmptyDescription>
              Apps shared by your company will appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
    </div>
  );
}
