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
  DenApiError,
  ensureDenActiveOrganization,
  denOriginComparisonKey,
  readDenBootstrapConfig,
  readDenSettings,
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
  type DeepLinkBridgeDetail,
} from "../../../app/lib/deep-link-bridge";
import { parseDenAuthDeepLink } from "../../../app/lib/openwork-links";

export type DenAuthStatus = "checking" | "signed_in" | "signed_out";

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
  const handledGrantsRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const currentRun = ++refreshTokenRef.current;
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";

    if (!token) {
      setUser(null);
      setError(null);
      setStatus("signed_out");
      return;
    }

    setStatus("checking");

    try {
      const nextUser = await createDenClient({
        baseUrl: settings.baseUrl,
        apiBaseUrl: settings.apiBaseUrl,
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
      setStatus("signed_in");
    } catch (nextError) {
      if (currentRun !== refreshTokenRef.current) return;

      if (nextError instanceof DenApiError && nextError.status === 401) {
        clearDenSession();
      }

      setUser(null);
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Failed to restore OpenWork Cloud session.",
      );
      setStatus("signed_out");
    }
  }, []);

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

  // Strip the consumed one-time grant from the persisted bootstrap so a
  // relaunch never re-exchanges it. Persisting is best-effort: a failure here
  // must NOT be reported as an auth failure, since the user is already signed
  // in at this point.
  const clearConsumedBootstrapHandoff = useCallback((bootstrap: DenBootstrapConfig, denBaseUrl: string, apiBaseUrl: string) => {
    void setDenBootstrapConfig({
      baseUrl: denBaseUrl,
      apiBaseUrl,
      requireSignin: bootstrap.requireSignin,
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
      clearConsumedBootstrapHandoff(bootstrap, bootstrap.baseUrl, bootstrap.apiBaseUrl);
      return;
    }

    handledGrantsRef.current.add(handoff.grant);
    const client = createDenClient({
      baseUrl: handoff.denBaseUrl,
      apiBaseUrl: bootstrap.apiBaseUrl,
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
      clearConsumedBootstrapHandoff(bootstrap, handoff.denBaseUrl, result.apiBaseUrl);
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

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleUrls = (urls: readonly string[]) => {
      for (const rawUrl of urls) {
        const parsed = parseDenAuthDeepLink(rawUrl);
        if (!parsed || handledGrantsRef.current.has(parsed.grant)) continue;
        handledGrantsRef.current.add(parsed.grant);

        // Keep the configured apiBaseUrl when the deep link targets the
        // control plane we are already pointed at; deriving from the link's
        // base URL alone breaks deployments where the advertised proxy path
        // does not match how this app actually reaches the Den API.
        const settings = readDenSettings();
        const targetKey = denOriginComparisonKey(parsed.denBaseUrl);
        const sameControlPlane =
          denOriginComparisonKey(settings.baseUrl) === targetKey ||
          denOriginComparisonKey(settings.apiBaseUrl ?? null) === targetKey;
        const client = createDenClient({
          baseUrl: parsed.denBaseUrl,
          apiBaseUrl: sameControlPlane ? settings.apiBaseUrl ?? null : null,
        });
        // Persist the API base URL the exchange actually succeeds against; the
        // helper reads it from the client (#1808).
        void exchangeHandoffAndSignIn(parsed.grant, {
          baseUrl: parsed.denBaseUrl,
          client,
        }).then((result) => {
          if (!result.ok) handledGrantsRef.current.delete(parsed.grant);
        });
      }
    };

    handleUrls(drainPendingDeepLinks(window));
    const handleDeepLink = (event: Event) => {
      handleUrls(((event as CustomEvent<DeepLinkBridgeDetail>).detail?.urls ?? []) as string[]);
    };

    window.addEventListener(deepLinkBridgeEvent, handleDeepLink);
    return () => window.removeEventListener(deepLinkBridgeEvent, handleDeepLink);
  }, []);

  const value = useMemo<DenAuthStore>(
    () => ({
      status,
      user,
      error,
      isSignedIn: status === "signed_in",
      refresh,
    }),
    [error, refresh, status, user],
  );

  return (
    <DenAuthContext.Provider value={value}>{children}</DenAuthContext.Provider>
  );
}

export function useDenAuth(): DenAuthStore {
  const context = use(DenAuthContext);
  if (!context) {
    throw new Error("useDenAuth must be used within a DenAuthProvider");
  }
  return context;
}
