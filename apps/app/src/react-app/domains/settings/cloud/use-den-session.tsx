/** @jsxImportSource react */
import * as React from "react";
import { toast } from "@/components/ui/sonner";

import {
  buildDenAuthUrl,
  clearDenSession,
  createDenClient,
  DEFAULT_DEN_BASE_URL,
  DenApiError,
  ensureDenActiveOrganization,
  denOriginComparisonKey,
  normalizeDenBaseUrl,
  readDenSettings,
  resolveDenBaseUrls,
  writeDenSettings,
  type DenOrgSummary,
} from "@/app/lib/den";
import {
  denSessionUpdatedEvent,
  dispatchDenSessionUpdated,
  type DenSessionUpdatedDetail,
} from "@/app/lib/den-session-events";
import { t } from "@/i18n";
import { useCloudSession } from "./cloud-session-provider";

type SettingsTone = "ready" | "warning" | "neutral" | "error";

declare global {
  interface WindowEventMap {
    "openwork-den-session-updated": CustomEvent<DenSessionUpdatedDetail>;
  }
}

export type UseDenSessionProps = {
  developerMode: boolean;
  openLink: (url: string) => void;
};

function parseManualAuthInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.toLowerCase();
    const routeHost = url.hostname.toLowerCase();
    const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
    const routeSegments = routePath.split("/").filter(Boolean);
    const routeTail = routeSegments[routeSegments.length - 1] ?? "";
    if (
      (protocol === "openwork:" || protocol === "openwork-dev:") &&
      (routeHost === "den-auth" || routePath === "den-auth" || routeTail === "den-auth")
    ) {
      const grant = url.searchParams.get("grant")?.trim() ?? "";
      const nextBaseUrl =
        normalizeDenBaseUrl(url.searchParams.get("denBaseUrl")?.trim() ?? "") ?? undefined;
      return grant ? { grant, baseUrl: nextBaseUrl } : null;
    }
  } catch {
    // Treat non-URL input as a raw handoff grant.
  }

  return trimmed.length >= 12 ? { grant: trimmed } : null;
}

export function useDenSession({
  developerMode,
  openLink,
}: UseDenSessionProps) {
  const {
    authToken,
    baseUrl,
    client,
    setActiveOrganization,
    setAuthToken,
    setBaseUrl,
    setIsSignedIn,
    setStatusMessage,
    setUser,
    user,
  } = useCloudSession();
  const initial = React.useMemo(() => readDenSettings(), []);

  const [baseUrlDraft, setBaseUrlDraft] = React.useState(baseUrl);
  const [baseUrlError, setBaseUrlError] = React.useState<string | null>(null);

  const [authBusy, setAuthBusy] = React.useState(false);
  const [sessionBusy, setSessionBusy] = React.useState(false);
  const [authError, setAuthError] = React.useState<string | null>(null);

  const [activeOrgId, setActiveOrgId] = React.useState(initial.activeOrgId?.trim() || "");
  const [orgsBusy, setOrgsBusy] = React.useState(false);
  const [orgs, setOrgs] = React.useState<DenOrgSummary[]>([]);
  const [orgsError, setOrgsError] = React.useState<string | null>(null);
  const activeOrg = React.useMemo(
    () => orgs.find((org) => org.id === activeOrgId) ?? null,
    [activeOrgId, orgs],
  );

  const isSignedIn = Boolean(user && authToken.trim());

  const summaryTone = React.useMemo<SettingsTone>(() => {
    if (authError || orgsError) {
      return "error";
    }
    if (sessionBusy || orgsBusy) {
      return "warning";
    }
    if (isSignedIn) return "ready";
    return "neutral";
  }, [authError, isSignedIn, orgsBusy, orgsError, sessionBusy]);

  const summaryLabel = React.useMemo(() => {
    if (authError) return t("den.needs_attention");
    if (sessionBusy) return t("den.checking_session");
    if (isSignedIn) return t("dashboard.connected");
    return t("den.signed_out");
  }, [authError, isSignedIn, sessionBusy]);

  const syncCurrentDenSettings = React.useCallback(() => {
    const currentSettings = readDenSettings();
    const resolved = resolveDenBaseUrls({
      baseUrl,
      apiBaseUrl: currentSettings.apiBaseUrl,
    });
    writeDenSettings({
      baseUrl: resolved.baseUrl,
      apiBaseUrl: resolved.apiBaseUrl,
      authToken: authToken || null,
      activeOrgId: activeOrgId || null,
      activeOrgSlug: activeOrg?.slug ?? null,
      activeOrgName: activeOrg?.name ?? null,
    });
  }, [activeOrg, activeOrgId, authToken, baseUrl]);

  React.useEffect(() => {
    setIsSignedIn(isSignedIn);
    if (activeOrg || !activeOrgId.trim()) {
      setActiveOrganization(activeOrg);
    }
  }, [activeOrg, activeOrgId, isSignedIn, setActiveOrganization, setIsSignedIn]);

  const clearSessionState = React.useCallback(() => {
    setUser(null);
    setOrgs([]);
    setActiveOrgId("");
    setOrgsError(null);
  }, []);

  const clearSignedInState = React.useCallback(
    (
      message?: string | null,
      eventDetail?: Pick<DenSessionUpdatedDetail, "baseUrl">,
    ) => {
      clearDenSession({ includeBaseUrls: !developerMode });
      if (!developerMode) {
        setBaseUrl(DEFAULT_DEN_BASE_URL);
        setBaseUrlDraft(DEFAULT_DEN_BASE_URL);
      }
      setAuthToken("");
      clearSessionState();
      setBaseUrlError(null);
      setAuthError(null);
      setStatusMessage(message ?? null);
      // Remove ONLY the cloud (lpr_*) provider IDs from the acknowledged
      // list. Local providers (openai, opencode) stay acknowledged so they
      // don't re-trigger the onboarding modal. When the user signs in
      // again, fresh cloud providers will be detected as new and surface
      // the toast (which is the intended behavior).
      try {
        const raw = window.localStorage.getItem("openwork.acknowledgedProviders");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            const kept = parsed.filter(
              (id: unknown) => typeof id === "string" && !/^lpr_/i.test(id),
            );
            window.localStorage.setItem(
              "openwork.acknowledgedProviders",
              JSON.stringify(kept),
            );
          }
        }
      } catch {}
      // Notify provider auth store so it can clean up cloud-imported providers
      dispatchDenSessionUpdated({ status: "signed_out", ...eventDetail });
    },
    [clearSessionState, developerMode, setAuthToken, setBaseUrl],
  );

  React.useEffect(() => {
    syncCurrentDenSettings();
  }, [syncCurrentDenSettings]);

  const openControlPlane = React.useCallback(() => {
    openLink(resolveDenBaseUrls(baseUrl).baseUrl);
  }, [baseUrl, openLink]);

  const openBrowserAuth = React.useCallback(
    (mode: "sign-in" | "sign-up") => {
      openLink(buildDenAuthUrl(baseUrl, mode));
      setStatusMessage(
        mode === "sign-up"
          ? t("den.status_browser_signup")
          : t("den.status_browser_signin"),
      );
      setAuthError(null);
    },
    [baseUrl, openLink],
  );

  const applyBaseUrl = React.useCallback(() => {
    const normalized = normalizeDenBaseUrl(baseUrlDraft);
    if (!normalized) {
      setBaseUrlError(t("den.error_base_url"));
      return;
    }

    const resolved = resolveDenBaseUrls(normalized);
    setBaseUrlError(null);
    if (resolved.baseUrl === baseUrl) {
      setBaseUrlDraft(resolved.baseUrl);
      return;
    }

    setBaseUrl(resolved.baseUrl);
    setBaseUrlDraft(resolved.baseUrl);
    writeDenSettings({
      baseUrl: resolved.baseUrl,
      apiBaseUrl: resolved.apiBaseUrl,
      authToken: null,
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    });
    clearSignedInState(t("den.status_base_url_updated"), {
      baseUrl: resolved.baseUrl,
    });
  }, [baseUrl, baseUrlDraft, clearSignedInState]);

  React.useEffect(() => {
    const token = authToken.trim();
    if (!token) {
      setSessionBusy(false);
      clearSessionState();
      setAuthError(null);
      return;
    }

    let cancelled = false;
    setSessionBusy(true);
    setAuthError(null);

    void client
      .getSession()
      .then((nextUser) => {
        if (cancelled) return;
        setUser(nextUser);
        setStatusMessage(t("den.status_signed_in_as", { email: nextUser.email }));
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof DenApiError && error.status === 401) {
          clearSignedInState();
        } else {
          clearSessionState();
        }
        setAuthError(error instanceof Error ? error.message : t("den.error_no_session"));
      })
      .finally(() => {
        if (!cancelled) setSessionBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authToken, clearSessionState, clearSignedInState, client]);

  const refreshOrgs = React.useCallback(
    async (quiet = false) => {
      if (!authToken.trim()) {
        setOrgs([]);
        setActiveOrgId("");
        return;
      }

      setOrgsBusy(true);
      if (!quiet) setOrgsError(null);

      try {
        const response = await client.listOrgs();
        setOrgs(response.orgs);
        const current = activeOrgId.trim();

        // Determine the next org to select:
        // - If the user already had an org selected and it still exists, keep it.
        // - If there's exactly one org, auto-select it (no choice needed).
        // - Otherwise, leave blank so the user is prompted to choose.
        let next = "";
        if (current && response.orgs.some((org) => org.id === current)) {
          next = current;
        } else if (response.orgs.length === 1) {
          next = response.orgs[0].id;
        }
        // else: leave next = "" so the org picker is shown

        const nextOrg = next ? (response.orgs.find((org) => org.id === next) ?? null) : null;
        setActiveOrgId(next);
        writeDenSettings({
          baseUrl,
          authToken: authToken || null,
          activeOrgId: next || null,
          activeOrgSlug: nextOrg?.slug ?? null,
          activeOrgName: nextOrg?.name ?? null,
        });
        // Push to context immediately so consumers see the new org
        if (nextOrg) {
          setActiveOrganization({ id: nextOrg.id, name: nextOrg.name, slug: nextOrg.slug });
        } else if (!next) {
          setActiveOrganization(null);
        }
        if (next) {
          await ensureDenActiveOrganization({ forceServerSync: true }).catch(() => null);
        }
        if (!quiet && response.orgs.length > 0) {
          toast.info(t("den.status_loaded_orgs", { count: response.orgs.length }));
        }
      } catch (error) {
        setOrgsError(error instanceof Error ? error.message : t("den.error_load_orgs"));
      } finally {
        setOrgsBusy(false);
      }
    },
    [activeOrgId, authToken, baseUrl, client, setActiveOrganization],
  );

  React.useEffect(() => {
    if (!user) return;
    void refreshOrgs(true);
  }, [refreshOrgs, user]);

  React.useEffect(() => {
    const handler = (event: WindowEventMap[typeof denSessionUpdatedEvent]) => {
      const nextSettings = readDenSettings();
      const nextBaseUrl =
        event.detail?.baseUrl?.trim() || nextSettings.baseUrl || DEFAULT_DEN_BASE_URL;
      const nextToken =
        event.detail?.token?.trim() || nextSettings.authToken?.trim() || "";
      setBaseUrl(nextBaseUrl);
      setBaseUrlDraft(nextBaseUrl);
      setAuthToken(nextToken);
      setActiveOrgId(nextSettings.activeOrgId?.trim() || "");
      if (event.detail?.status === "success") {
        clearSessionState();
        if (event.detail.user) {
          setUser(event.detail.user);
        }
        setAuthError(null);
        setSessionBusy(false);
        setStatusMessage(
          event.detail.email?.trim()
            ? t("den.status_cloud_signed_in_as", { email: event.detail.email.trim() })
            : t("den.status_cloud_signin_done"),
        );
      } else if (event.detail?.status === "error") {
        setAuthError(event.detail.message?.trim() || t("den.error_signin_failed"));
      }
    };

    window.addEventListener(denSessionUpdatedEvent, handler);
    return () => window.removeEventListener(denSessionUpdatedEvent, handler);
  }, [clearSessionState, setAuthToken, setBaseUrl]);

  const submitManualAuth = React.useCallback(async (input: string) => {
    const parsed = parseManualAuthInput(input);
    if (!parsed || authBusy) {
      if (!parsed) setAuthError(t("den.error_paste_valid_code"));
      return false;
    }

    const nextBaseUrl = parsed.baseUrl ?? baseUrl;
    setAuthBusy(true);
    setAuthError(null);
    setStatusMessage(t("den.signing_in"));

    try {
      // When the pasted link targets the control plane we are already
      // configured for, keep the configured apiBaseUrl. Deriving it from the
      // link's base URL alone breaks deployments where the advertised proxy
      // path does not match how this app actually reaches the Den API.
      const settings = readDenSettings();
      const targetKey = denOriginComparisonKey(nextBaseUrl);
      const configuredApiBaseUrl =
        denOriginComparisonKey(settings.baseUrl) === targetKey ||
        denOriginComparisonKey(settings.apiBaseUrl ?? null) === targetKey
          ? settings.apiBaseUrl ?? null
          : null;
      const exchangeClient = createDenClient({ baseUrl: nextBaseUrl, apiBaseUrl: configuredApiBaseUrl });
      const result = await exchangeClient.exchangeDesktopHandoff(parsed.grant);
      if (!result.token) {
        throw new Error(t("den.error_no_token"));
      }

      if (developerMode) {
        setBaseUrl(nextBaseUrl);
        setBaseUrlDraft(nextBaseUrl);
      }

      // Persist the API base URL the exchange actually succeeded against so
      // relaunches reuse the same working endpoint (#1808).
      writeDenSettings({
        baseUrl: nextBaseUrl,
        apiBaseUrl: exchangeClient.baseUrls.apiBaseUrl,
        authToken: result.token,
        activeOrgId: null,
        activeOrgSlug: null,
        activeOrgName: null,
      });

      dispatchDenSessionUpdated({
        status: "success",
        baseUrl: nextBaseUrl,
        token: result.token,
        user: result.user,
        email: result.user?.email ?? null,
      });
      return true;
    } catch (error) {
      dispatchDenSessionUpdated({
        status: "error",
        message: error instanceof Error ? error.message : t("den.error_signin_failed"),
      });
      return false;
    } finally {
      setAuthBusy(false);
    }
  }, [authBusy, baseUrl, developerMode]);

  const signOut = React.useCallback(async () => {
    if (authBusy) return;

    setAuthBusy(true);
    try {
      if (authToken.trim()) {
        await client.signOut();
      }
    } catch {
      // Ignore remote sign-out failures.
    } finally {
      setAuthBusy(false);
    }

    clearSignedInState(t("den.status_signed_out"));
  }, [authBusy, authToken, clearSignedInState, client]);

  const handleActiveOrgChange = React.useCallback(
    async (nextId: string) => {
      const nextOrg = orgs.find((org) => org.id === nextId) ?? null;
      if (!nextOrg) {
        setOrgsError(t("den.error_load_orgs"));
        return;
      }

      setOrgsBusy(true);
      setOrgsError(null);

      try {
        // 1. Sync Den server-side (cookie/session)
        await client.setActiveOrganization({ organizationId: nextOrg.id });
      } catch (error) {
        setOrgsError(error instanceof Error ? error.message : t("den.error_load_orgs"));
        setOrgsBusy(false);
        return;
      }

      // 2. Persist to localStorage FIRST so any code that reads from settings
      //    (e.g. refreshCloudOrgProviders which reads readDenSettings()) sees
      //    the new org immediately.
      writeDenSettings({
        baseUrl,
        authToken: authToken ? authToken : null,
        activeOrgId: nextId ? nextId : null,
        activeOrgSlug: nextOrg?.slug ?? null,
        activeOrgName: nextOrg?.name ?? null,
      });

      // 3. Update local state
      setActiveOrgId(nextId);

      // 4. Update CloudSessionProvider context IMMEDIATELY so consumers
      //    (cloud providers / marketplace / workers views) re-fetch with
      //    the new org without waiting for the sync effect to fire.
      setActiveOrganization({
        id: nextOrg.id,
        name: nextOrg.name,
        slug: nextOrg.slug,
      });

      // 5. Force a full server sync (Den + localStorage reconciliation)
      try {
        await ensureDenActiveOrganization({ forceServerSync: true });
      } catch {
        // Best-effort; the explicit setActiveOrganization above already
        // covered the critical path.
      }

      setOrgsBusy(false);
    },
    [authToken, baseUrl, client, orgs, setActiveOrganization],
  );

  // User is signed in, orgs loaded, multiple orgs available, but none selected yet.
  // The UI should prompt the user to pick an org before cloud features activate.
  const needsOrgSelection =
    !!authToken.trim() && !!user && !orgsBusy && orgs.length > 1 && !activeOrgId;

  return {
    authBusy,
    authError,
    baseUrlDraft,
    baseUrlError,
    needsOrgSelection,
    orgs,
    orgsBusy,
    orgsError,
    sessionBusy,
    summaryLabel,
    summaryTone,
    syncCurrentDenSettings,
    onActiveOrgChange: handleActiveOrgChange,
    onApplyBaseUrl: applyBaseUrl,
    onBaseUrlDraftChange: setBaseUrlDraft,
    onClearAuthError: () => setAuthError(null),
    onOpenBrowserAuth: openBrowserAuth,
    onOpenControlPlane: openControlPlane,
    onRefreshOrgs: refreshOrgs,
    onResetBaseUrl: () => setBaseUrlDraft(baseUrl),
    onSignOut: signOut,
    onSubmitManualAuth: submitManualAuth,
  };
}
