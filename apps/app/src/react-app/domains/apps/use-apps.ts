import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createDenClient, DenApiError, readDenSettings } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { useDenAuth } from "../cloud/den-auth-provider";

export function useAppsClient() {
  const auth = useDenAuth();
  const [settings, setSettings] = useState(readDenSettings);
  useEffect(() => {
    const sync = () => setSettings(readDenSettings());
    window.addEventListener(denSettingsChangedEvent, sync);
    return () => window.removeEventListener(denSettingsChangedEvent, sync);
  }, []);
  const token = settings.authToken;
  const client = useMemo(() => token ? createDenClient({ baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl, token }) : null,
    [settings.baseUrl, settings.apiBaseUrl, token]);
  return {
    client: auth.isSignedIn ? client : null,
    orgId: settings.activeOrgId,
    orgName: settings.activeOrgName,
    scope: [settings.baseUrl, auth.user?.id, settings.activeOrgId],
  };
}

export function useSavedApps() {
  const context = useAppsClient();
  const { client, orgId, scope } = context;
  const query = useQuery({
    queryKey: ["saved-apps", ...scope],
    enabled: Boolean(client && orgId),
    queryFn: async () => {
      if (!client || !orgId) throw new Error("Sign in to open your apps.");
      try { return await client.listSavedApps(orgId); }
      catch (error) {
        if (error instanceof DenApiError && error.status === 404) return { enabled: false, items: [] };
        throw error;
      }
    },
    staleTime: 15_000,
  });
  return { ...context, query, available: Boolean(client && orgId && query.data?.enabled) };
}
