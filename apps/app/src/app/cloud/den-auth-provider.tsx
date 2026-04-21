import { createContext, createMemo, createSignal, onCleanup, onMount, useContext, type Accessor, type ParentProps } from "solid-js";
import { clearDenSession, createDenClient, DenApiError, ensureDenActiveOrganization, readDenSettings, type DenUser } from "../lib/den";
import { denSessionUpdatedEvent } from "../lib/den-session-events";
import { recordDevLog } from "../lib/dev-log";

type DenAuthStatus = "checking" | "signed_in" | "signed_out";

type DenAuthStore = {
  status: Accessor<DenAuthStatus>;
  user: Accessor<DenUser | null>;
  error: Accessor<string | null>;
  isSignedIn: Accessor<boolean>;
  refresh: () => Promise<void>;
};

const DenAuthContext = createContext<DenAuthStore>();

function logDenAuth(label: string, payload?: unknown) {
  try {
    recordDevLog(true, { level: "debug", source: "den-auth", label, payload });
    if (payload === undefined) {
      console.log(`[DEN-AUTH] ${label}`);
    } else {
      console.log(`[DEN-AUTH] ${label}`, payload);
    }
  } catch {
    // ignore
  }
}

export function DenAuthProvider(props: ParentProps) {
  const [status, setStatus] = createSignal<DenAuthStatus>("checking");
  const [user, setUser] = createSignal<DenUser | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let refreshToken = 0;

  const refresh = async () => {
    const currentRun = ++refreshToken;
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";

    logDenAuth("refresh-start", {
      currentRun,
      hasToken: Boolean(token),
      activeOrgId: settings.activeOrgId ?? null,
      activeOrgSlug: settings.activeOrgSlug ?? null,
      baseUrl: settings.baseUrl,
    });

    if (!token) {
      setUser(null);
      setError(null);
      setStatus("signed_out");
      logDenAuth("refresh-signed-out-no-token", { currentRun });
      return;
    }

    setStatus("checking");
    logDenAuth("refresh-status-checking", { currentRun });

    try {
      const nextUser = await createDenClient({
        baseUrl: settings.baseUrl,
        apiBaseUrl: settings.apiBaseUrl,
        token,
      }).getSession();

      if (currentRun !== refreshToken) {
        logDenAuth("refresh-stale-after-session", { currentRun, refreshToken });
        return;
      }

      await ensureDenActiveOrganization({
        forceServerSync:
          !settings.activeOrgId?.trim() ||
          !settings.activeOrgSlug?.trim(),
      }).catch(() => null);

      if (currentRun !== refreshToken) {
        logDenAuth("refresh-stale-after-org-sync", { currentRun, refreshToken });
        return;
      }

      setUser(nextUser);
      setError(null);
      setStatus("signed_in");
      logDenAuth("refresh-signed-in", {
        currentRun,
        userId: nextUser.id,
        activeOrgId: readDenSettings().activeOrgId ?? null,
        activeOrgSlug: readDenSettings().activeOrgSlug ?? null,
      });
    } catch (nextError) {
      if (currentRun !== refreshToken) {
        logDenAuth("refresh-stale-after-error", { currentRun, refreshToken });
        return;
      }

      if (nextError instanceof DenApiError && nextError.status === 401) {
        clearDenSession();
      }

      setUser(null);
      setError(nextError instanceof Error ? nextError.message : "Failed to restore OpenWork Cloud session.");
      setStatus("signed_out");
      logDenAuth("refresh-error", {
        currentRun,
        error: nextError instanceof Error ? nextError.message : String(nextError),
      });
    }
  };

  onMount(() => {
    void refresh();

    if (typeof window === "undefined") {
      return;
    }

    const handleSessionUpdated = () => {
      logDenAuth("session-updated-event");
      void refresh();
    };

    window.addEventListener(denSessionUpdatedEvent, handleSessionUpdated);
    onCleanup(() => {
      window.removeEventListener(denSessionUpdatedEvent, handleSessionUpdated);
    });
  });

  const store: DenAuthStore = {
    status,
    user,
    error,
    isSignedIn: createMemo(() => status() === "signed_in"),
    refresh,
  };

  return (
    <DenAuthContext.Provider value={store}>
      {props.children}
    </DenAuthContext.Provider>
  );
}

export function useDenAuth() {
  const context = useContext(DenAuthContext);
  if (!context) {
    throw new Error("useDenAuth must be used within a DenAuthProvider");
  }
  return context;
}
