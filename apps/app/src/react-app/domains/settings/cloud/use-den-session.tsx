/** @jsxImportSource react */
import * as React from "react";

import {
  buildDenAuthUrl,
  clearDenSession,
  createDenClient,
  DEFAULT_DEN_BASE_URL,
  DenApiError,
  ensureDenActiveOrganization,
  normalizeDenBaseUrl,
  readDenSettings,
  resolveDenBaseUrls,
  writeDenSettings,
  type DenOrgSummary,
} from "../../../../app/lib/den";
import {
  denSessionUpdatedEvent,
  dispatchDenSessionUpdated,
  type DenSessionUpdatedDetail,
} from "../../../../app/lib/den-session-events";
import { t } from "@/i18n";
import { useStatusToasts } from "../../shell-feedback/status-toasts";
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
  const { showToast } = useStatusToasts();
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
    const resolved = resolveDenBaseUrls(baseUrl);
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
    (message?: string | null) => {
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
    clearSignedInState(t("den.status_base_url_updated"));
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
        const fallback = response.defaultOrgId ?? response.orgs[0]?.id ?? "";
        const next = response.orgs.some((org) => org.id === current) ? current : fallback;
        const nextOrg = response.orgs.find((org) => org.id === next) ?? null;
        setActiveOrgId(next);
        writeDenSettings({
          baseUrl,
          authToken: authToken || null,
          activeOrgId: next || null,
          activeOrgSlug: nextOrg?.slug ?? null,
          activeOrgName: nextOrg?.name ?? null,
        });
        if (next) {
          await ensureDenActiveOrganization({ forceServerSync: true }).catch(() => null);
        }
        if (!quiet && response.orgs.length > 0) {
          showToast({
            title: t("den.status_loaded_orgs", { count: response.orgs.length }),
            tone: "info",
          });
        }
      } catch (error) {
        setOrgsError(error instanceof Error ? error.message : t("den.error_load_orgs"));
      } finally {
        setOrgsBusy(false);
      }
    },
    [activeOrgId, authToken, baseUrl, client, showToast],
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
      const result = await createDenClient({ baseUrl: nextBaseUrl }).exchangeDesktopHandoff(parsed.grant);
      if (!result.token) {
        throw new Error(t("den.error_no_token"));
      }

      if (developerMode) {
        setBaseUrl(nextBaseUrl);
        setBaseUrlDraft(nextBaseUrl);
      }

      writeDenSettings({
        baseUrl: nextBaseUrl,
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
    (nextId: string) => {
      const nextOrg = orgs.find((org) => org.id === nextId) ?? null;
      setActiveOrgId(nextId);
      writeDenSettings({
        baseUrl,
        authToken: authToken ? authToken : null,
        activeOrgId: nextId ? nextId : null,
        activeOrgSlug: nextOrg?.slug ?? null,
        activeOrgName: nextOrg?.name ?? null,
      });
      if (nextId) {
        void ensureDenActiveOrganization({ forceServerSync: true }).catch(() => null);
      }
      showToast({
        title: t("den.org_switched", { name: nextOrg?.name ?? t("den.active_org_title") }),
        tone: "success",
      });
    },
    [authToken, baseUrl, orgs, showToast],
  );

  return {
    authBusy,
    authError,
    baseUrlDraft,
    baseUrlError,
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
