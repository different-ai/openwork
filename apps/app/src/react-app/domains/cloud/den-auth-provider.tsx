/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  use,
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
import { readOrgSelectionPending } from "../../../app/lib/den-sign-in-intent";
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

export type DenAuthStatus =
  | "checking"
  | "signed_in"
  | "unavailable"
  | "signed_out";

export const DEN_AUTH_SIGNAL_RETRY_COOLDOWN_MS = 5_000;
export const DEN_AUTH_UNAVAILABLE_RETRY_INTERVAL_MS = 30_000;
export const DEN_AUTH_ORG_REPAIR_INTERVAL_MS = 30_000;
const DEN_ORG_RESOLUTION_RETRY_DELAYS_MS = [0, 200, 600];

export async function resolveDenActiveOrganizationWithRetry(
  resolve: () => Promise<DenOrgSummary | null>,
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolveWait) => window.setTimeout(resolveWait, delayMs)),
) {
  for (const delayMs of DEN_ORG_RESOLUTION_RETRY_DELAYS_MS) {
    if (delayMs > 0) await wait(delayMs);

    try {
      const organization = await resolve();
      if (organization) return organization;
    } catch {
      // A newly accepted membership can take a moment to become visible.
    }
  }

  return null;
}

export function resolveDenAuthFailureStatus(
  error: unknown,
): Extract<DenAuthStatus, "signed_out" | "unavailable"> {
  return isDenSessionRevokedError(error) ? "signed_out" : "unavailable";
}

export function hasRetainedDenSession(status: DenAuthStatus): boolean {
  return status === "signed_in" || status === "unavailable";
}

/**
 * True while a retained session has not produced a confirmed user yet: the
 * initial check is still running, or it failed with a transient error
 * ("unavailable") before the first success — e.g. the control plane or a
 * local proxy is unreachable during an app update or server restart. Account
 * UI must show a restoring state in this window, never "Sign in".
 */
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

export type DenAuthStore = {
  status: DenAuthStatus;
  user: DenUser | null;
  verifiedIdentity: { principalId: string; organizationId: string } | null;
  error: string | null;
  isSignedIn: boolean;
  refresh: () => Promise<void>;
};

const DenAuthContext = createContext<DenAuthStore | undefined>(undefined);

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
  // An enterprise activation permanently binds the installation to the issuing
  // Den, so confirm a control-plane change even when no bootstrap file
  // provisioned one. Otherwise any openwork://den-auth link can repoint the
  // control plane and activate the app in a single unattended step.
  if (bootstrap.source !== "file" && !input.isEnterpriseActivation) return null;

  const currentApiBaseUrl = resolveDenBaseUrls(bootstrap).apiBaseUrl;
  const newApiBaseUrl = resolveDenBaseUrls(input.denBaseUrl).apiBaseUrl;
  const currentOrigin = denOriginComparisonKey(currentApiBaseUrl);
  const newOrigin = denOriginComparisonKey(newApiBaseUrl);
  if (!currentOrigin || !newOrigin || currentOrigin === newOrigin) return null;

  return {
    grant: input.grant,
    denBaseUrl: input.denBaseUrl,
    isEnterpriseActivation: input.isEnterpriseActivation,
    currentHost: hostLabel(currentApiBaseUrl),
    newHost: hostLabel(newApiBaseUrl),
  };
}

/**
 * React port of the Solid `DenAuthProvider` (`apps/app/src/app/cloud/den-auth-provider.tsx`
 * on dev). Drives the Den auth status signal the forced-signin gate and
 * desktop-config reader rely on, and syncs Better-Auth's active organization
 * on every refresh so subsequent requests resolve against the right org.
 */
export function DenAuthProvider({ children }: DenAuthProviderProps) {
  const [status, setStatus] = useState<DenAuthStatus>("checking");
  const [user, setUser] = useState<DenUser | null>(null);
  const [verifiedIdentity, setVerifiedIdentity] = useState<{
    principalId: string;
    organizationId: string;
  } | null>(null);
  const verifiedCredentialRef = useRef<{ token: string; organizationId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Monotonic token so stale async refreshes can't clobber a newer result.
  const refreshTokenRef = useRef(0);
  const statusRef = useRef<DenAuthStatus>("checking");
  const lastSignalRetryAtRef = useRef<number | null>(null);
  const signalRetryInFlightRef = useRef(false);
  const handledGrantsRef = useRef<Set<string>>(new Set());
  const [pendingServerSwitch, setPendingServerSwitch] = useState<PendingServerSwitch | null>(null);

  const updateStatus = useCallback((nextStatus: DenAuthStatus) => {
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
      setVerifiedIdentity(null);
    }

    if (!token) {
      setUser(null);
      setVerifiedIdentity(null);
      setError(null);
      lastSignalRetryAtRef.current = null;
      updateStatus("signed_out");
      clearDesktopSentrySession();
      return;
    }

    // Keep a usable session visible during background checks. Only the first
    // check (or a refresh from a confirmed signed-out state) should gate the
    // app while the request is in flight.
    if (statusRef.current === "signed_out") {
      updateStatus("checking");
    }

    try {
      const nextUser = await createDenClient({
        baseUrl: settings.baseUrl,
        token,
      }).getSession();

      if (currentRun !== refreshTokenRef.current) return;

      // While a desktop-initiated sign-in is waiting for the user's explicit
      // organization choice, do not auto-resolve a default — that would
      // silently commit an org the chooser is still asking about.
      if (!readOrgSelectionPending().pending) {
        await resolveDenActiveOrganizationWithRetry(() =>
          ensureDenActiveOrganization({
            forceServerSync:
              !settings.activeOrgId?.trim() || !settings.activeOrgSlug?.trim(),
          })
        );
      }

      if (currentRun !== refreshTokenRef.current) return;

      const confirmedSettings = readDenSettings();
      const confirmedToken = confirmedSettings.authToken?.trim() ?? "";
      const confirmedOrganizationId = confirmedSettings.activeOrgId?.trim() ?? "";
      const principalId = nextUser.id.trim();
      if (confirmedToken === token && principalId && confirmedOrganizationId) {
        verifiedCredentialRef.current = { token, organizationId: confirmedOrganizationId };
        setVerifiedIdentity({ principalId, organizationId: confirmedOrganizationId });
      } else {
        verifiedCredentialRef.current = null;
        setVerifiedIdentity(null);
      }
      setUser(nextUser);
      setError(null);
      lastSignalRetryAtRef.current = null;
      updateStatus("signed_in");
      syncDesktopSentrySession(nextUser);
    } catch (nextError) {
      if (currentRun !== refreshTokenRef.current) return;

      const failureStatus = resolveDenAuthFailureStatus(nextError);
      if (failureStatus === "signed_out") {
        clearDenSession();
        setUser(null);
        verifiedCredentialRef.current = null;
        setVerifiedIdentity(null);
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
    void refresh();

    if (typeof window === "undefined") return;

    const handleSessionUpdated = () => {
      void refresh();
    };

    window.addEventListener(denSessionUpdatedEvent, handleSessionUpdated);
    window.addEventListener(denSettingsChangedEvent, handleSessionUpdated);
    return () => {
      window.removeEventListener(denSessionUpdatedEvent, handleSessionUpdated);
      window.removeEventListener(denSettingsChangedEvent, handleSessionUpdated);
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
    // A signed-in session without an organization is a stranded first
    // sign-in (e.g. org discovery was rate limited during a handoff). Keep
    // repairing in the background until an organization resolves — unless the
    // missing org is deliberate because the chooser is waiting for the user.
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

  // Strip the consumed one-time grant from the persisted bootstrap so a
  // relaunch never re-exchanges it. Persisting is best-effort: a failure here
  // must NOT be reported as an auth failure, since the user is already signed
  // in at this point.
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

    // Already signed in: just drop the now-unused grant from disk.
    if (readDenSettings().authToken?.trim()) {
      handledGrantsRef.current.add(handoff.grant);
      clearConsumedBootstrapHandoff(bootstrap, bootstrap.baseUrl);
      return;
    }

    handledGrantsRef.current.add(handoff.grant);
    void exchangeHandoffAndSignIn(handoff.grant, {
      baseUrl: handoff.denBaseUrl,
      activeOrg: { id: handoff.orgId, slug: handoff.orgSlug || null, name: handoff.orgName || null },
      // The consumed grant is stripped from the persisted bootstrap in the
      // same durable commit that enrolls the session, so a relaunch can
      // neither re-exchange it nor lose the enrollment it produced.
      bootstrap: { clearHandoff: true },
    }).then((result) => {
      if (result.ok) return;
      if (!result.grantConsumed) {
        // The grant never reached the destination; a later bootstrap heal may
        // retry it.
        handledGrantsRef.current.delete(handoff.grant);
        return;
      }
      // The one-time grant is spent but the enrollment did not commit. Drop
      // the grant from disk (best effort) so restarts do not retry it forever;
      // the user needs a fresh handoff link.
      clearConsumedBootstrapHandoff(bootstrap, bootstrap.baseUrl);
    });
  }, [clearConsumedBootstrapHandoff]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Run now, and again whenever the bootstrap config heals in later (the
    // shell IPC bridge can deliver the prepared bootstrap after first render).
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
      // Enterprise activation is part of the same durable commit as the
      // enrollment: the stamp and the session it locks in land together.
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

export function useDenAuth(): DenAuthStore {
  const context = use(DenAuthContext);
  if (!context) {
    throw new Error("useDenAuth must be used within a DenAuthProvider");
  }
  return context;
}
