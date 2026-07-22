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
  type DenUser,
} from "../../../app/lib/den";
import { exchangeHandoffAndSignIn } from "../../../app/lib/den-handoff";
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

export function resolveDenAuthFailureStatus(
  error: unknown,
): Extract<DenAuthStatus, "signed_out" | "unavailable"> {
  return isDenSessionRevokedError(error) ? "signed_out" : "unavailable";
}

export function hasRetainedDenSession(status: DenAuthStatus): boolean {
  return status === "signed_in" || status === "unavailable";
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

function pendingServerSwitchForDeepLink(input: { grant: string; denBaseUrl: string }): PendingServerSwitch | null {
  const bootstrap = readDenBootstrapConfig();
  if (bootstrap.source !== "file") return null;

  const currentApiBaseUrl = resolveDenBaseUrls(bootstrap).apiBaseUrl;
  const newApiBaseUrl = resolveDenBaseUrls(input.denBaseUrl).apiBaseUrl;
  const currentOrigin = denOriginComparisonKey(currentApiBaseUrl);
  const newOrigin = denOriginComparisonKey(newApiBaseUrl);
  if (!currentOrigin || !newOrigin || currentOrigin === newOrigin) return null;

  return {
    grant: input.grant,
    denBaseUrl: input.denBaseUrl,
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

  const refresh = useCallback(async () => {
    const currentRun = ++refreshTokenRef.current;
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";

    if (!token) {
      setUser(null);
      setError(null);
      lastSignalRetryAtRef.current = null;
      updateStatus("signed_out");
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

      await ensureDenActiveOrganization({
        forceServerSync:
          !settings.activeOrgId?.trim() || !settings.activeOrgSlug?.trim(),
      }).catch(() => null);

      if (currentRun !== refreshTokenRef.current) return;

      setUser(nextUser);
      setError(null);
      lastSignalRetryAtRef.current = null;
      updateStatus("signed_in");
    } catch (nextError) {
      if (currentRun !== refreshTokenRef.current) return;

      const failureStatus = resolveDenAuthFailureStatus(nextError);
      if (failureStatus === "signed_out") {
        clearDenSession();
        setUser(null);
        lastSignalRetryAtRef.current = null;
      }

      setError(
        nextError instanceof Error
          ? nextError.message
          : "Failed to restore OpenWork Cloud session.",
      );
      updateStatus(failureStatus);
    }
  }, [updateStatus]);

  useEffect(() => {
    void refresh();

    if (typeof window === "undefined") return;

    const handleSessionUpdated = () => {
      void refresh();
    };

    window.addEventListener(denSessionUpdatedEvent, handleSessionUpdated);
    return () => {
      window.removeEventListener(denSessionUpdatedEvent, handleSessionUpdated);
    };
  }, [refresh]);

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
    return () => {
      window.removeEventListener("online", retryUnavailableSession);
      window.removeEventListener("focus", retryUnavailableSession);
      window.clearInterval(retryInterval);
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
    const client = createDenClient({
      baseUrl: handoff.denBaseUrl,
    });

    void exchangeHandoffAndSignIn(handoff.grant, {
      baseUrl: handoff.denBaseUrl,
      client,
      activeOrg: { id: handoff.orgId, slug: handoff.orgSlug || null, name: handoff.orgName || null },
    }).then((result) => {
      if (!result.ok) {
        handledGrantsRef.current.delete(handoff.grant);
        return;
      }
      // Best-effort cleanup; not part of the auth success/failure path.
      clearConsumedBootstrapHandoff(bootstrap, handoff.denBaseUrl);
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

  const exchangeDeepLinkGrant = useCallback((grant: string, denBaseUrl: string) => {
    handledGrantsRef.current.add(grant);
    const client = createDenClient({
      baseUrl: denBaseUrl,
    });
    void exchangeHandoffAndSignIn(grant, {
      baseUrl: denBaseUrl,
      client,
    }).then((result) => {
      if (!result.ok) handledGrantsRef.current.delete(grant);
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleUrls = (urls: readonly string[]) => {
      for (const rawUrl of urls) {
        const parsed = parseDenAuthDeepLink(rawUrl);
        if (!parsed || handledGrantsRef.current.has(parsed.grant)) continue;
        handledGrantsRef.current.add(parsed.grant);

        const pending = pendingServerSwitchForDeepLink(parsed);
        if (pending) {
          setPendingServerSwitch(pending);
          continue;
        }

        exchangeDeepLinkGrant(parsed.grant, parsed.denBaseUrl);
      }
    };

    handleUrls(drainPendingDeepLinks(window));
    const handleDeepLink = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      handleUrls(readDeepLinkEventUrls(event.detail));
    };

    window.addEventListener(deepLinkBridgeEvent, handleDeepLink);
    return () => window.removeEventListener(deepLinkBridgeEvent, handleDeepLink);
  }, [exchangeDeepLinkGrant]);

  const value = useMemo<DenAuthStore>(
    () => ({
      status,
      user,
      error,
      isSignedIn: hasRetainedDenSession(status),
      refresh,
    }),
    [error, refresh, status, user],
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
                exchangeDeepLinkGrant(next.grant, next.denBaseUrl);
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
