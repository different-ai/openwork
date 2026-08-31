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
  initializeDenBootstrapConfig,
  isDenSessionRevokedError,
  mergePassiveDenSettings,
  normalizeDenBaseUrl,
  readDenSettings,
  resolveDenBaseUrls,
  writeDenSettings,
  type DenSettings,
  type DenOrgSummary,
} from "@/app/lib/den";
import { markDesktopSignInInitiated } from "@/app/lib/den-sign-in-intent";
import { clearDesktopBootstrapConfig } from "@/app/lib/desktop";
import { exchangeHandoffAndSignIn } from "@/app/lib/den-handoff";
import { parseManualAuthInput } from "@/app/lib/manual-auth-input";
import { normalizeOrganizationServerInput } from "@/app/lib/organization-server-input";
import {
  denSessionUpdatedEvent,
  type DenSessionUpdatedDetail,
} from "@/app/lib/den-session-events";
import { t } from "@/i18n";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { tryOpenBrowserAuthUrl } from "../../cloud/open-browser-auth";
import {
  cloudSessionOrganizationFromSettings,
  useCloudSession,
} from "./cloud-session-provider";
import { defaultControlPlaneUrl, saveControlPlaneUrl } from "./control-plane-url";

type SettingsTone = "ready" | "warning" | "neutral" | "error";

declare global {
  interface WindowEventMap {
    "openwork-den-session-updated": CustomEvent<DenSessionUpdatedDetail>;
  }
}

export type UseDenSessionProps = {
  developerMode: boolean;
  openLink: (url: string) => void;
  onBeforeSignedOut?: (settings: DenSettings) => void | Promise<void>;
};

const SIGN_OUT_CLEANUP_TIMEOUT_MS = 5_000;

async function runBeforeSignedOut(callback: UseDenSessionProps["onBeforeSignedOut"], settings: DenSettings): Promise<void> {
  if (!callback) return;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.resolve(callback(settings)),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SIGN_OUT_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Best-effort cleanup must not trap the user in a signed-in state.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function useDenSession({
  developerMode,
  onBeforeSignedOut,
  openLink,
}: UseDenSessionProps) {
  const denAuth = useDenAuth();
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
  const [baseUrlBusy, setBaseUrlBusy] = React.useState(false);
  const [baseUrlError, setBaseUrlError] = React.useState<string | null>(null);

  const [authBusy, setAuthBusy] = React.useState(false);
  const [sessionBusy, setSessionBusy] = React.useState(false);
  const [authError, setAuthError] = React.useState<string | null>(null);
  const [signinFallbackUrl, setSigninFallbackUrl] = React.useState<string | null>(null);

  const [activeOrgId, setActiveOrgId] = React.useState(initial.activeOrgId?.trim() || "");
  const [orgsBusy, setOrgsBusy] = React.useState(false);
  const [orgs, setOrgs] = React.useState<DenOrgSummary[]>([]);
  const [orgsError, setOrgsError] = React.useState<string | null>(null);
  const activeOrg = React.useMemo(
    () => orgs.find((org) => org.id === activeOrgId) ?? null,
    [activeOrgId, orgs],
  );

  const isSignedIn = Boolean(authToken.trim()) && (Boolean(user) || denAuth.isSignedIn);

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
    writeDenSettings(
      mergePassiveDenSettings(readDenSettings(), {
        baseUrl: resolved.baseUrl,
        authToken: authToken || null,
        activeOrgId: activeOrgId || null,
        activeOrgSlug: activeOrg?.slug ?? null,
        activeOrgName: activeOrg?.name ?? null,
      }),
    );
  }, [activeOrg, activeOrgId, authToken, baseUrl]);

  React.useEffect(() => {
    const nextUser = denAuth.user;
    if (authToken.trim() && nextUser) {
      setUser((current) => (
        current?.id === nextUser.id
        && current.email === nextUser.email
        && current.name === nextUser.name
          ? current
          : nextUser
      ));
    }
  }, [authToken, denAuth.user, setUser]);

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
      options?: { includeBaseUrls?: boolean },
    ) => {
      const includeBaseUrls = options?.includeBaseUrls ?? !developerMode;
      const previousSettings = readDenSettings();
      return runBeforeSignedOut(onBeforeSignedOut, previousSettings).then(() => {
        clearDenSession({ includeBaseUrls });
      if (includeBaseUrls) {
        setBaseUrl(DEFAULT_DEN_BASE_URL);
        setBaseUrlDraft(DEFAULT_DEN_BASE_URL);
      }
      setAuthToken("");
      clearSessionState();
      setBaseUrlError(null);
      setAuthError(null);
      setSigninFallbackUrl(null);
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
      });
    },
    [clearSessionState, developerMode, onBeforeSignedOut, setAuthToken, setBaseUrl],
  );

  React.useEffect(() => {
    syncCurrentDenSettings();
  }, [syncCurrentDenSettings]);

  const openControlPlane = React.useCallback(() => {
    openLink(resolveDenBaseUrls(baseUrl).baseUrl);
  }, [baseUrl, openLink]);

  const openBrowserAuth = React.useCallback(
    (mode: "sign-in" | "sign-up") => {
      const url = buildDenAuthUrl(baseUrl, mode);
      const usesPasteHandoff = new URL(url).searchParams.get("desktopAuth") === "1";
      markDesktopSignInInitiated();
      setSigninFallbackUrl(url);
      setStatusMessage(
        mode === "sign-up"
          ? t(usesPasteHandoff ? "den.status_browser_signup_paste" : "den.status_browser_signup")
          : t(usesPasteHandoff ? "den.status_browser_signin_paste" : "den.status_browser_signin"),
      );
      setAuthError(null);
      void tryOpenBrowserAuthUrl(url).then((opened) => {
        if (opened) return;
        setStatusMessage(null);
      });
    },
    [baseUrl, setStatusMessage],
  );

  const applyBaseUrl = React.useCallback(async () => {
    const serverOrigin = normalizeOrganizationServerInput(baseUrlDraft);
    const normalized = serverOrigin ? normalizeDenBaseUrl(serverOrigin) : null;
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

    setBaseUrlBusy(true);
    try {
      const persisted = await saveControlPlaneUrl(resolved.baseUrl);
      if (!persisted) {
        setBaseUrlError(t("den.error_base_url"));
        return;
      }

      setBaseUrl(persisted.baseUrl);
      setBaseUrlDraft(persisted.baseUrl);
      await clearSignedInState(t("den.status_base_url_updated"), { includeBaseUrls: false });
    } catch (error) {
      setBaseUrlError(error instanceof Error ? error.message : t("den.error_base_url"));
    } finally {
      setBaseUrlBusy(false);
    }
  }, [baseUrl, baseUrlDraft, clearSignedInState]);

  const resetBaseUrlToDefault = React.useCallback(async () => {
    setBaseUrlDraft(defaultControlPlaneUrl());
    setBaseUrlBusy(true);
    try {
      const persisted = await saveControlPlaneUrl(defaultControlPlaneUrl());
      if (!persisted) {
        setBaseUrlError(t("den.error_base_url"));
        return;
      }

      setBaseUrlError(null);
      setBaseUrl(persisted.baseUrl);
      setBaseUrlDraft(persisted.baseUrl);
      await clearSignedInState(t("den.status_base_url_updated"), { includeBaseUrls: false });
    } catch (error) {
      setBaseUrlError(error instanceof Error ? error.message : t("den.error_base_url"));
    } finally {
      setBaseUrlBusy(false);
    }
  }, [clearSignedInState, setBaseUrl]);

  const clearServerConfiguration = React.useCallback(async () => {
    if (baseUrlBusy) return;

    setBaseUrlBusy(true);
    setBaseUrlError(null);
    setAuthError(null);
    try {
      // Reset-to-default writes a default-pointing bootstrap file; clear removes
      // bootstrap files entirely so an MDM-dropped config can win on next launch.
      await clearDesktopBootstrapConfig();
      const bootstrap = await initializeDenBootstrapConfig();
      const resolved = resolveDenBaseUrls(bootstrap);
      writeDenSettings(
        {
          baseUrl: resolved.baseUrl,
          authToken: null,
          activeOrgId: null,
          activeOrgSlug: null,
          activeOrgName: null,
        },
        { persistBootstrap: false, intentionalActiveOrgClear: true },
      );
      setBaseUrl(resolved.baseUrl);
      setBaseUrlDraft(resolved.baseUrl);
      await clearSignedInState(t("den.status_server_config_cleared"), { includeBaseUrls: false });
    } catch (error) {
      setBaseUrlError(error instanceof Error ? error.message : t("den.error_base_url"));
    } finally {
      setBaseUrlBusy(false);
    }
  }, [baseUrlBusy, clearSignedInState, setBaseUrl]);

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
      .catch(async (error) => {
        if (cancelled) return;
        if (isDenSessionRevokedError(error)) {
          await clearSignedInState();
        }
        // A timeout, offline state, or server failure does not invalidate the
        // last confirmed session. Keep it available while surfacing the error.
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
        setOrgs((currentOrgs) => (
          currentOrgs.length === response.orgs.length
          && currentOrgs.every((org, index) => {
            const nextOrg = response.orgs[index];
            return org.id === nextOrg?.id
              && org.name === nextOrg.name
              && org.slug === nextOrg.slug
              && org.role === nextOrg.role;
          })
            ? currentOrgs
            : response.orgs
        ));
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
        setActiveOrgId((currentId) => currentId === next ? currentId : next);
        writeDenSettings({
          baseUrl,
          authToken: authToken || null,
          activeOrgId: next || null,
          activeOrgSlug: nextOrg?.slug ?? null,
          activeOrgName: nextOrg?.name ?? null,
        });
        // Push to context immediately so consumers see the new org
        if (nextOrg) {
          setActiveOrganization((currentOrg) => (
            currentOrg?.id === nextOrg.id
            && currentOrg.name === nextOrg.name
            && currentOrg.role === nextOrg.role
            && currentOrg.slug === nextOrg.slug
              ? currentOrg
              : { id: nextOrg.id, name: nextOrg.name, role: nextOrg.role, slug: nextOrg.slug }
          ));
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

  const userId = user?.id ?? "";
  React.useEffect(() => {
    if (!userId) return;
    void refreshOrgs(true);
  }, [refreshOrgs, userId]);

  React.useEffect(() => {
    const handler = (event: WindowEventMap[typeof denSessionUpdatedEvent]) => {
      const nextSettings = readDenSettings();
      const nextBaseUrl =
        event.detail?.baseUrl?.trim() || nextSettings.baseUrl || DEFAULT_DEN_BASE_URL;
      const nextToken =
        event.detail?.token?.trim() || nextSettings.authToken?.trim() || "";
      if (event.detail?.status === "success") {
        // Clear the pre-handoff snapshot before restoring the newly persisted
        // organization. Clearing afterward used to erase activeOrgId and let
        // the org refresh persist a blank selection for multi-org users.
        clearSessionState();
      }
      setBaseUrl(nextBaseUrl);
      setBaseUrlDraft(nextBaseUrl);
      setAuthToken(nextToken);
      setActiveOrgId(nextSettings.activeOrgId?.trim() || "");
      const nextOrganization = cloudSessionOrganizationFromSettings(nextSettings);
      if (nextOrganization) setActiveOrganization(nextOrganization);
      if (event.detail?.status === "success") {
        setSigninFallbackUrl(null);
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
  }, [clearSessionState, setActiveOrganization, setAuthToken, setBaseUrl, setStatusMessage, setUser]);

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
      const exchangeClient = createDenClient({ baseUrl: nextBaseUrl });
      // The helper exchanges, persists, and dispatches the success/error session events.
      const result = await exchangeHandoffAndSignIn(parsed.grant, {
        baseUrl: nextBaseUrl,
        client: exchangeClient,
        // Pasted one-time codes are desktop-initiated sign-ins.
        desktopInitiated: true,
        fallbackErrorMessage: t("den.error_no_token"),
      });
      if (!result.ok) {
        return false;
      }

      if (developerMode) {
        setBaseUrl(nextBaseUrl);
        setBaseUrlDraft(nextBaseUrl);
      }
      setSigninFallbackUrl(null);
      return true;
    } finally {
      setAuthBusy(false);
    }
  }, [authBusy, baseUrl, developerMode]);

  const signOut = React.useCallback(async () => {
    if (authBusy) return;

    setAuthBusy(true);
    setAuthError(null);
    try {
      if (authToken.trim()) {
        await client.signOut();
      }
      await clearSignedInState(t("den.status_signed_out"));
    } catch (error) {
      setAuthError(
        error instanceof DenApiError
          ? error.message
          : t("den.error_signout_failed"),
      );
    } finally {
      setAuthBusy(false);
    }
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
        role: nextOrg.role,
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
    baseUrl,
    baseUrlBusy,
    baseUrlDraft,
    baseUrlError,
    needsOrgSelection,
    orgs,
    orgsBusy,
    orgsError,
    sessionBusy,
    signinFallbackUrl,
    summaryLabel,
    summaryTone,
    syncCurrentDenSettings,
    onActiveOrgChange: handleActiveOrgChange,
    onApplyBaseUrl: applyBaseUrl,
    onBaseUrlDraftChange: setBaseUrlDraft,
    onClearServerConfiguration: clearServerConfiguration,
    onClearAuthError: () => setAuthError(null),
    onOpenBrowserAuth: openBrowserAuth,
    onOpenControlPlane: openControlPlane,
    onRefreshOrgs: refreshOrgs,
    onResetBaseUrl: () => setBaseUrlDraft(baseUrl),
    onResetBaseUrlToDefault: resetBaseUrlToDefault,
    onSignOut: signOut,
    onSubmitManualAuth: submitManualAuth,
  };
}
