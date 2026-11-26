/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  clearDenSession,
  createDenClient,
  ensureDenActiveOrganization,
  denOriginComparisonKey,
  isDenSessionRevokedError,
  readDenBootstrapConfig,
  readDenSettings,
  resolveDenBaseUrls,
  setDenBootstrapConfig,
  type DenBootstrapConfig,
  type DenOrgSummary,
  type DenUser,
} from "../../../app/lib/den";
import { exchangeHandoffAndSignIn } from "../../../app/lib/den-handoff";
import { connectionDiagnosticHistory, type ConnectionDiagnosticReason, type ConnectionDiagnosticSource } from "../../../app/lib/connection-diagnostic-history";
import { readOrgSelectionPending } from "../../../app/lib/den-sign-in-intent";
import {
  classifyStartupError,
  failStartup,
  markStartupStep,
  noteStartupDenSession,
} from "../../../app/lib/startup-diagnostics";
import { desktopBridge, readDesktopDistributionInfo } from "../../../app/lib/desktop";
import {
  denSessionUpdatedEvent,
  denSettingsChangedEvent,
} from "../../../app/lib/den-session-events";
import {
  deepLinkBridgeEvent,
  drainPendingDeepLinks,
} from "../../../app/lib/deep-link-bridge";
import { parseDenAuthDeepLink } from "../../../app/lib/openwork-links";
import { explainSignOutAfterDisconnect } from "../devices/disconnected-sign-out";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { t } from "@/i18n";
import { DenAuthContext, publishVerifiedDenIdentity, type DenAuthStatus, type DenAuthStore } from "@/react-app/kernel/den-auth-context";

export { useDenAuth, type DenAuthStatus, type DenAuthStore } from "@/react-app/kernel/den-auth-context";

const authDiagnosticReasons: Record<DenAuthStatus, ConnectionDiagnosticReason> = {
  checking: "den_auth_checking",
  signed_in: "den_auth_signed_in",
  unavailable: "den_auth_unavailable",
  signed_out: "den_auth_signed_out",
};

export const DEN_AUTH_SIGNAL_RETRY_COOLDOWN_MS = 5_000;
export const DEN_AUTH_UNAVAILABLE_RETRY_INTERVAL_MS = 30_000;
export const DEN_AUTH_ORG_REPAIR_INTERVAL_MS = 30_000;
const DEN_ORG_RESOLUTION_RETRY_DELAYS_MS = [0, 200, 600];

export async function resolveDenActiveOrganizationWithRetry(
  resolve: () => Promise<DenOrgSummary | null>,
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolveWait) => window.setTimeout(resolveWait, delayMs)),
) {
  const diagnostics = connectionDiagnosticHistory.createSource();
  try {
    for (const delayMs of DEN_ORG_RESOLUTION_RETRY_DELAYS_MS) {
      if (delayMs > 0) await wait(delayMs);
      diagnostics.attempt("den_org_retry");

      try {
        const organization = await resolve();
        if (organization) {
          diagnostics.recovered("den_org_recovered");
          return organization;
        }
      } catch {
      }
      diagnostics.failed();
      diagnostics.record("den_org_unresolved", "failure");
    }

    return null;
  } finally {
    diagnostics.dispose();
  }
}

export function resolveDenAuthFailureStatus(
  error: unknown,
): Extract<DenAuthStatus, "signed_out" | "unavailable"> {
  return isDenSessionRevokedError(error) ? "signed_out" : "unavailable";
}

export function hasRetainedDenSession(status: DenAuthStatus): boolean {
  return status === "signed_in" || status === "unavailable";
}

export function isDenSessionRestoring(input: {
  status: DenAuthStatus;
  hasUser: boolean;
}): boolean {
  if (input.status === "checking") return true;
  return hasRetainedDenSession(input.status) && !input.hasUser;
}

export function shouldRetryDenAuthOnSignal(input: {
  status: DenAuthStatus;
  online: boolean;
  now: number;
  lastAttemptAt: number | null;
}): boolean {
  if (input.status !== "unavailable" || !input.online) return false;
  if (input.lastAttemptAt === null || input.now < input.lastAttemptAt) return true;
  return input.now - input.lastAttemptAt >= DEN_AUTH_SIGNAL_RETRY_COOLDOWN_MS;
}

type DenAuthProviderProps = {
  children: ReactNode;
};

type PendingServerSwitch = {
  grant: string;
  denBaseUrl: string;
  isEnterpriseActivation: boolean;
  currentHost: string;
  newHost: string;
};

function hostLabel(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

function readDeepLinkEventUrls(detail: unknown): string[] {
  if (!detail || typeof detail !== "object" || !("urls" in detail)) return [];
  const urlsValue = detail.urls;
  const items: readonly unknown[] = Array.isArray(urlsValue) ? urlsValue : [];
  return items.flatMap((url) => typeof url === "string" ? [url] : []);
}

function pendingServerSwitchForDeepLink(input: {
  grant: string;
  denBaseUrl: string;
  isEnterpriseActivation: boolean;
}): PendingServerSwitch | null {
  const bootstrap = readDenBootstrapConfig();
  if (bootstrap.source !== "file" && !input.isEnterpriseActivation) return null;

  const currentWebBaseUrl = resolveDenBaseUrls(bootstrap).baseUrl;
  const newWebBaseUrl = resolveDenBaseUrls(input.denBaseUrl).baseUrl;
  const currentOrigin = denOriginComparisonKey(currentWebBaseUrl);
  const newOrigin = denOriginComparisonKey(newWebBaseUrl);
  if (!currentOrigin || !newOrigin || currentOrigin === newOrigin) return null;

  return {
    grant: input.grant,
    denBaseUrl: input.denBaseUrl,
    isEnterpriseActivation: input.isEnterpriseActivation,
    currentHost: hostLabel(currentWebBaseUrl),
    newHost: hostLabel(newWebBaseUrl),
  };
}

export function DenAuthProvider({ children }: DenAuthProviderProps) {
  const [status, setStatus] = useState<DenAuthStatus>("checking");
  const [user, setUser] = useState<DenUser | null>(null);
  const [verifiedIdentity, setVerifiedIdentity] = useState<{
    principalId: string;
    organizationId: string;
  } | null>(null);
  const verifiedCredentialRef = useRef<{ token: string; organizationId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshTokenRef = useRef(0);
  const statusRef = useRef<DenAuthStatus>("checking");
  const lastSignalRetryAtRef = useRef<number | null>(null);
  const signalRetryInFlightRef = useRef(false);
  const handledGrantsRef = useRef<Set<string>>(new Set());
  const [pendingServerSwitch, setPendingServerSwitch] = useState<PendingServerSwitch | null>(null);

  const diagnosticsRef = useRef<ConnectionDiagnosticSource | null>(null);

  const updateVerifiedIdentity = useCallback((next: { principalId: string; organizationId: string } | null) => {
    setVerifiedIdentity(next);
    publishVerifiedDenIdentity(next);
  }, []);

  const updateStatus = useCallback((nextStatus: DenAuthStatus) => {
    diagnosticsRef.current?.transition(authDiagnosticReasons[nextStatus]);
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  }, []);

  const syncDesktopSentrySession = useCallback((nextUser: DenUser | null) => {
    if (typeof window === "undefined" || !window.__OPENWORK_ELECTRON__) return;
    const settings = readDenSettings();
    const userId = nextUser?.id?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!settings.authToken?.trim() || !userId || !orgId) return;
    void desktopBridge.desktopSentrySetSession({ userId, orgId }).catch(() => undefined);
  }, []);

  const clearDesktopSentrySession = useCallback(() => {
    if (typeof window === "undefined" || !window.__OPENWORK_ELECTRON__) return;
    void desktopBridge.desktopSentryClearSession().catch(() => undefined);
  }, []);

  const refresh = useCallback(async () => {
    const currentRun = ++refreshTokenRef.current;
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const organizationId = settings.activeOrgId?.trim() ?? "";
    const verifiedCredential = verifiedCredentialRef.current;

    if (
      !verifiedCredential
      || verifiedCredential.token !== token
      || verifiedCredential.organizationId !== organizationId
    ) {
      verifiedCredentialRef.current = null;
      updateVerifiedIdentity(null);
    }

    if (!token) {
      noteStartupDenSession(null);
      setUser(null);
      updateVerifiedIdentity(null);
      setError(null);
      lastSignalRetryAtRef.current = null;
      updateStatus("signed_out");
      clearDesktopSentrySession();
      return;
    }

    if (statusRef.current === "signed_out") {
      updateStatus("checking");
    }

    noteStartupDenSession({ baseUrl: settings.baseUrl, organizationId: organizationId || null });
    const diagnostics = diagnosticsRef.current;
    diagnostics?.attempt("den_session_retry");
    try {
      const nextUser = await createDenClient({
        baseUrl: settings.baseUrl,
        token,
      }).getSession();

      if (currentRun !== refreshTokenRef.current) return;

      const confirmedSettings = readDenSettings();
      const confirmedToken = confirmedSettings.authToken?.trim() ?? "";
      const confirmedOrganizationId = confirmedSettings.activeOrgId?.trim() ?? "";
      const principalId = nextUser.id.trim();
      if (confirmedToken === token && principalId && confirmedOrganizationId) {
        verifiedCredentialRef.current = { token, organizationId: confirmedOrganizationId };
        updateVerifiedIdentity({ principalId, organizationId: confirmedOrganizationId });
      } else {
        verifiedCredentialRef.current = null;
        updateVerifiedIdentity(null);
      }
      setUser(nextUser);
      setError(null);
      lastSignalRetryAtRef.current = null;
      diagnostics?.recovered("den_session_recovered");
      updateStatus("signed_in");
      markStartupStep("signed_in", { organizationId: confirmedOrganizationId || null });
      syncDesktopSentrySession(nextUser);

      if (!readOrgSelectionPending().pending) {
        await resolveDenActiveOrganizationWithRetry(() => {
          if (currentRun !== refreshTokenRef.current || readOrgSelectionPending().pending) {
            return Promise.resolve(null);
          }
          return ensureDenActiveOrganization({
            forceServerSync:
              !settings.activeOrgId?.trim() || !settings.activeOrgSlug?.trim(),
            verifiedSession: { userId: nextUser.id, token, baseUrl: settings.baseUrl },
          });
        });
      }
    } catch (nextError) {
      if (currentRun !== refreshTokenRef.current) return;

      diagnostics?.failed();
      failStartup("signed_in", classifyStartupError(nextError));
      const failureStatus = resolveDenAuthFailureStatus(nextError);
      if (failureStatus === "signed_out") {
        explainSignOutAfterDisconnect();
        clearDenSession();
        setUser(null);
        verifiedCredentialRef.current = null;
        updateVerifiedIdentity(null);
        lastSignalRetryAtRef.current = null;
        clearDesktopSentrySession();
      }

      setError(
        nextError instanceof Error
          ? nextError.message
          : "Failed to restore OpenWork Cloud session.",
      );
      updateStatus(failureStatus);
    }
  }, [clearDesktopSentrySession, syncDesktopSentrySession, updateStatus]);

  useEffect(() => {
    const resetDiagnostics = () => {
      diagnosticsRef.current?.dispose();
      diagnosticsRef.current = connectionDiagnosticHistory.createSource();
      diagnosticsRef.current.transition(authDiagnosticReasons[statusRef.current]);
    };
    resetDiagnostics();
    void refresh();

    if (typeof window === "undefined") return () => diagnosticsRef.current?.dispose();

    const handleSessionUpdated = () => {
      resetDiagnostics();
      void refresh();
    };

    window.addEventListener(denSessionUpdatedEvent, handleSessionUpdated);
    window.addEventListener(denSettingsChangedEvent, handleSessionUpdated);
    return () => {
      window.removeEventListener(denSessionUpdatedEvent, handleSessionUpdated);
      window.removeEventListener(denSettingsChangedEvent, handleSessionUpdated);
      diagnosticsRef.current?.dispose();
      diagnosticsRef.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.__OPENWORK_ELECTRON__) return;

    if (status === "signed_out") return clearDesktopSentrySession();

    const settings = readDenSettings();
    const userId = user?.id?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!hasRetainedDenSession(status) || !userId || !orgId || !settings.authToken?.trim()) return;

    syncDesktopSentrySession(user);
  }, [clearDesktopSentrySession, status, syncDesktopSentrySession, user, user?.id]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const retryUnavailableSession = () => {
      const now = Date.now();
      if (
        signalRetryInFlightRef.current ||
        !shouldRetryDenAuthOnSignal({
          status: statusRef.current,
          online: window.navigator.onLine !== false,
          now,
          lastAttemptAt: lastSignalRetryAtRef.current,
        })
      ) {
        return;
      }

      lastSignalRetryAtRef.current = now;
      signalRetryInFlightRef.current = true;
      void refresh().finally(() => {
        signalRetryInFlightRef.current = false;
      });
    };

    window.addEventListener("online", retryUnavailableSession);
    window.addEventListener("focus", retryUnavailableSession);
    const retryInterval = window.setInterval(
      retryUnavailableSession,
      DEN_AUTH_UNAVAILABLE_RETRY_INTERVAL_MS,
    );
    const repairMissingOrganization = () => {
      if (statusRef.current !== "signed_in") return;
      if (readOrgSelectionPending().pending) return;
      const settings = readDenSettings();
      if (!settings.authToken?.trim() || settings.activeOrgId?.trim()) return;
      void resolveDenActiveOrganizationWithRetry(() =>
        ensureDenActiveOrganization({ forceServerSync: true })
      );
    };
    const orgRepairInterval = window.setInterval(
      repairMissingOrganization,
      DEN_AUTH_ORG_REPAIR_INTERVAL_MS,
    );
    return () => {
      window.removeEventListener("online", retryUnavailableSession);
      window.removeEventListener("focus", retryUnavailableSession);
      window.clearInterval(retryInterval);
      window.clearInterval(orgRepairInterval);
    };
  }, [refresh]);

  const clearConsumedBootstrapHandoff = useCallback((bootstrap: DenBootstrapConfig, denBaseUrl: string) => {
    void setDenBootstrapConfig({
      baseUrl: denBaseUrl,
      requireSignin: bootstrap.requireSignin,
      requireActivation: bootstrap.requireActivation,
      ...(bootstrap.brandAppName ? { brandAppName: bootstrap.brandAppName } : {}),
      ...(bootstrap.brandLogoUrl ? { brandLogoUrl: bootstrap.brandLogoUrl } : {}),
      ...(bootstrap.brandIconUrl ? { brandIconUrl: bootstrap.brandIconUrl } : {}),
      ...(bootstrap.claimLinks ? { claimLinks: bootstrap.claimLinks } : {}),
      handoff: null,
      ...(bootstrap.prepared ? { prepared: bootstrap.prepared } : {}),
    }).catch(() => undefined);
  }, []);

  const consumeBootstrapHandoff = useCallback(() => {
    if (typeof window === "undefined") return;

    const bootstrap = readDenBootstrapConfig();
    const handoff = bootstrap.handoff;
    if (!handoff?.grant || handledGrantsRef.current.has(handoff.grant)) return;

    if (readDenSettings().authToken?.trim()) {
      handledGrantsRef.current.add(handoff.grant);
      clearConsumedBootstrapHandoff(bootstrap, bootstrap.baseUrl);
      return;
    }

    handledGrantsRef.current.add(handoff.grant);
    void exchangeHandoffAndSignIn(handoff.grant, {
      baseUrl: handoff.denBaseUrl,
      activeOrg: { id: handoff.orgId, slug: handoff.orgSlug || null, name: handoff.orgName || null },
      bootstrap: { clearHandoff: true },
    }).then((result) => {
      if (result.ok) return;
      if (!result.grantConsumed) {
        handledGrantsRef.current.delete(handoff.grant);
        return;
      }
      clearConsumedBootstrapHandoff(bootstrap, bootstrap.baseUrl);
    });
  }, [clearConsumedBootstrapHandoff]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    consumeBootstrapHandoff();
    const handleSettingsChanged = () => consumeBootstrapHandoff();
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged);
    return () => window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
  }, [consumeBootstrapHandoff]);

  const exchangeDeepLinkGrant = useCallback((
    grant: string,
    denBaseUrl: string,
    isEnterpriseActivation: boolean,
  ) => {
    handledGrantsRef.current.add(grant);
    void exchangeHandoffAndSignIn(grant, {
      baseUrl: denBaseUrl,
      ...(isEnterpriseActivation
        ? {
            bootstrap: {
              requireSignin: true,
              enterpriseActivation: {
                activatedAt: new Date().toISOString(),
                denBaseUrl,
              },
            },
          }
        : {}),
    }).then((result) => {
      if (!result.ok && !result.grantConsumed) {
        handledGrantsRef.current.delete(grant);
      }
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleUrls = (urls: readonly string[]) => {
      for (const rawUrl of urls) {
        const parsed = parseDenAuthDeepLink(rawUrl);
        if (!parsed || handledGrantsRef.current.has(parsed.grant)) continue;
        handledGrantsRef.current.add(parsed.grant);

        const isEnterpriseActivation =
          readDesktopDistributionInfo().flavor === "enterprise";
        const pending = pendingServerSwitchForDeepLink({
          ...parsed,
          isEnterpriseActivation,
        });
        if (pending) {
          setPendingServerSwitch(pending);
          continue;
        }

        exchangeDeepLinkGrant(
          parsed.grant,
          parsed.denBaseUrl,
          isEnterpriseActivation,
        );
      }
    };

    handleUrls(drainPendingDeepLinks(window));
    const handleDeepLink = (event: Event) => {
      handleUrls(readDeepLinkEventUrls((event as CustomEvent<unknown>).detail));
    };

    window.addEventListener(deepLinkBridgeEvent, handleDeepLink);
    return () => window.removeEventListener(deepLinkBridgeEvent, handleDeepLink);
  }, [exchangeDeepLinkGrant]);

  const value = useMemo<DenAuthStore>(
    () => ({
      status,
      user,
      verifiedIdentity,
      error,
      isSignedIn: hasRetainedDenSession(status),
      refresh,
    }),
    [error, refresh, status, user, verifiedIdentity],
  );

  return (
    <DenAuthContext.Provider value={value}>
      {children}
      <AlertDialog
        open={Boolean(pendingServerSwitch)}
        onOpenChange={(open) => {
          if (!open) setPendingServerSwitch(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("den.switch_server_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingServerSwitch
                ? t("den.switch_server_body", {
                    currentHost: pendingServerSwitch.currentHost,
                    newHost: pendingServerSwitch.newHost,
                  })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingServerSwitch(null)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!pendingServerSwitch) return;
                const next = pendingServerSwitch;
                setPendingServerSwitch(null);
                exchangeDeepLinkGrant(
                  next.grant,
                  next.denBaseUrl,
                  next.isEnterpriseActivation,
                );
              }}
            >
              {t("den.switch_server_confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DenAuthContext.Provider>
  );
}
