import { createContext, createMemo, createSignal, onCleanup, onMount, useContext, type Accessor, type ParentProps } from "solid-js";
import { clearDenSession, createDenClient, DenApiError, ensureDenActiveOrganization, readDenSettings, type DenUser } from "../lib/den";
import { denSessionUpdatedEvent } from "../lib/den-session-events";

type DenAuthStatus = "checking" | "signed_in" | "signed_out";

type DenAuthStore = {
  status: Accessor<DenAuthStatus>;
  user: Accessor<DenUser | null>;
  error: Accessor<string | null>;
  isSignedIn: Accessor<boolean>;
  refresh: () => Promise<void>;
};

const DenAuthContext = createContext<DenAuthStore>();

export function DenAuthProvider(props: ParentProps) {
  const [status, setStatus] = createSignal<DenAuthStatus>("checking");
  const [user, setUser] = createSignal<DenUser | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let refreshToken = 0;

  const refresh = async () => {
    const currentRun = ++refreshToken;
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

      if (currentRun !== refreshToken) {
        return;
      }

      await ensureDenActiveOrganization({
        forceServerSync:
          !settings.activeOrgId?.trim() ||
          !settings.activeOrgSlug?.trim(),
      }).catch(() => null);

      if (currentRun !== refreshToken) {
        return;
      }

      setUser(nextUser);
      setError(null);
      setStatus("signed_in");
    } catch (nextError) {
      if (currentRun !== refreshToken) {
        return;
      }

      if (nextError instanceof DenApiError && nextError.status === 401) {
        clearDenSession();
      }

      setUser(null);
      setError(nextError instanceof Error ? nextError.message : "Failed to restore OpenWork Cloud session.");
      setStatus("signed_out");
    }
  };

  onMount(() => {
    void refresh();

    if (typeof window === "undefined") {
      return;
    }

    const handleSessionUpdated = () => {
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
