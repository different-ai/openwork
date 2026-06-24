/** @jsxImportSource react */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { captureAnalyticsEvent, initAnalytics } from "../../app/lib/analytics";
import {
  createDenClient,
  readDenBootstrapConfig,
  readDenSettings,
  writeDenSettings,
} from "../../app/lib/den";
import {
  denSettingsChangedEvent,
  denSessionUpdatedEvent,
  dispatchDenSessionUpdated,
} from "../../app/lib/den-session-events";
import { useDenAuth } from "../domains/cloud/den-auth-provider";
import { ForcedSigninPage } from "../domains/cloud/forced-signin-page";
import { OrgOnboardingPage } from "../domains/cloud/org-onboarding-page";
import { NewProvidersListener } from "./new-providers-listener";
import { useDesktopFontZoomBehavior } from "./font-zoom";
import { LoadingOverlay } from "./loading-overlay";
import { DevProfiler, DevProfilerOverlay } from "./dev-profiler";
import { ReactRenderWatchdogOverlay } from "./react-render-watchdog-overlay";
import { useLocal } from "../kernel/local-provider";
import { useDesktopConfig } from "../domains/cloud/desktop-config-provider";
import { useElectronUpdaterStore } from "../domains/settings/state/electron-updater-store";
import { notifyAlert } from "./notifications";
import { t } from "@/i18n";
import { AppMenuProvider } from "./app-menu";
import {
  OpenworkControlProvider,
  OpenworkRouteControlActions,
  useControlAction,
  type OpenworkControlAction,
} from "./control/control-provider";
import { SessionRoute } from "./session-route";
import { SettingsRoute } from "./settings-route";
import { ShellConfigProvider } from "./shell-config";
import { WelcomeRoute } from "./welcome-route";


type DenSigninGateProps = {
  children: ReactNode;
};

const readRequireSigninSnapshot = () => readDenBootstrapConfig().requireSignin;

const subscribeToRequireSignin = (onStoreChange: () => void) => {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(denSettingsChangedEvent, onStoreChange);
  return () => {
    window.removeEventListener(denSettingsChangedEvent, onStoreChange);
  };
};

/**
 * Forced-signin gate ported from the Solid shell.
 *
 * When the desktop bootstrap config has `requireSignin: true` (persisted by
 * the Tauri shell via `desktop-bootstrap.json`), the UI is held at `/signin`
 * until the user authenticates with Den. When sign-in is NOT required, we
 * never let users land on `/signin` — redirect them to `/session` instead.
 *
 * While we're still checking the Den session AND sign-in is required, we
 * render nothing so the transcript/settings never flash behind the gate.
 */
function DenSigninGate({ children }: DenSigninGateProps) {
  const denAuth = useDenAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const requireSignin = useSyncExternalStore(
    subscribeToRequireSignin,
    readRequireSigninSnapshot,
    readRequireSigninSnapshot,
  );

  useEffect(() => {
    // Wait for the first auth check so we don't bounce the user between
    // `/session` and `/signin` every navigation while we figure out if
    // their cached token is still valid.
    if (denAuth.status === "checking") return;

    const path = location.pathname.toLowerCase();
    const onSignin = path === "/signin" || path.startsWith("/signin/");

    const onOnboarding = path === "/onboarding" || path.startsWith("/onboarding/");

    if (requireSignin) {
      if (!denAuth.isSignedIn && !onSignin) {
        navigate("/signin", { replace: true });
      } else if (denAuth.isSignedIn && onSignin) {
        // Signed in — route to onboarding so the user sees their org resources.
        navigate("/onboarding", { replace: true });
      }
    } else if (onSignin) {
      navigate("/session", { replace: true });
    }

    // If on /onboarding but not signed in, bounce to signin or session
    if (onOnboarding && !denAuth.isSignedIn) {
      navigate(requireSignin ? "/signin" : "/session", { replace: true });
    }
  }, [
    denAuth.isSignedIn,
    denAuth.status,
    location,
    navigate,
    requireSignin,
  ]);

  // After a fresh sign-in, navigate to the onboarding page so the
  // user sees what their org provides.
  // Poll for activeOrgId (set asynchronously by refreshOrgs) rather
  // than using a fixed delay — handles both fast and slow org lookups.
  useEffect(() => {
    const handler = (event: WindowEventMap[typeof denSessionUpdatedEvent]) => {
      if (event.detail?.status !== "success") return;
      let attempts = 0;
      const check = () => {
        attempts++;
        const settings = readDenSettings();
        if (settings.authToken?.trim() && settings.activeOrgId?.trim()) {
          navigate("/onboarding", { replace: true });
        } else if (attempts < 10) {
          // Org not selected yet — retry (max ~5 seconds)
          setTimeout(check, 500);
        }
      };
      // First check after a short delay for the auth to settle
      setTimeout(check, 500);
    };
    window.addEventListener(denSessionUpdatedEvent, handler);
    return () => window.removeEventListener(denSessionUpdatedEvent, handler);
  }, [navigate]);

  if (requireSignin && denAuth.status === "checking") {
    return <ForcedSigninPage developerMode={false} />;
  }

  return <>{children}</>;
}

const SETTINGS_UPDATE_AUTO_CHECK_KEY = "openwork.react.settings.update-auto-check";
const SETTINGS_UPDATE_AUTO_DOWNLOAD_KEY = "openwork.react.settings.update-auto-download";

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
  } catch {}
  return fallback;
}

function BackgroundUpdater() {
  const local = useLocal();
  const desktopConfig = useDesktopConfig();
  const navigate = useNavigate();
  const checkForUpdates = useElectronUpdaterStore((state) => state.checkForUpdates);
  const updateStatus = useElectronUpdaterStore((state) => state.updateStatus);
  const releaseChannel = local.prefs.releaseChannel ?? "stable";

  const checkOptionsRef = useRef({
    releaseChannel,
    desktopConfig: desktopConfig.config,
    local,
  });

  useEffect(() => {
    checkOptionsRef.current = {
      releaseChannel,
      desktopConfig: desktopConfig.config,
      local,
    };
  });

  const [settingsVersion, setSettingsVersion] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleSettingsChange = () => {
      setSettingsVersion((prev) => prev + 1);
    };
    window.addEventListener("openwork:update-settings-changed", handleSettingsChange);
    return () => {
      window.removeEventListener("openwork:update-settings-changed", handleSettingsChange);
    };
  }, []);

  useEffect(() => {
    const autoCheck = readStoredBoolean(SETTINGS_UPDATE_AUTO_CHECK_KEY, true);
    if (!autoCheck) return;

    const check = () => {
      const { releaseChannel: channel, desktopConfig: config, local: loc } = checkOptionsRef.current;
      const autoDownload = readStoredBoolean(SETTINGS_UPDATE_AUTO_DOWNLOAD_KEY, false);
      void checkForUpdates({
        releaseChannel: channel,
        desktopConfig: config,
        updateAutoDownload: autoDownload,
        onReleaseChannelChange: (next) => {
          loc.setPrefs((previous) => ({ ...previous, releaseChannel: next }));
        },
      });
    };

    // Run first check on startup after 5 seconds to let application fully initialize
    const delayId = setTimeout(check, 5000);

    // Re-check periodically every 4 hours
    const intervalId = setInterval(check, 4 * 60 * 60 * 1000);

    return () => {
      clearTimeout(delayId);
      clearInterval(intervalId);
    };
  }, [checkForUpdates, settingsVersion]);

  // Listen for updateState changes to show the notification alert
  const lastStateRef = useRef<string | null>(null);

  useEffect(() => {
    if (!updateStatus) return;
    if (updateStatus.state === "available" && lastStateRef.current !== "available") {
      notifyAlert(
        {
          kind: "update",
          severity: "info",
          title: t("notifications.updater_available_title", undefined, { version: updateStatus.version ?? "" }),
          body: t("notifications.updater_available_body"),
          dedupeKey: "updater-available",
          action: { type: "navigate", path: "/settings/updates" },
          actionLabel: t("notifications.updater_view_button"),
        },
        {
          onClick: () => navigate("/settings/updates"),
          toastAction: {
            label: t("notifications.updater_view_button") || "View",
            onClick: () => navigate("/settings/updates"),
          },
        }
      );
    }
    lastStateRef.current = updateStatus.state;
  }, [updateStatus, navigate]);

  return null;
}

/**
 * Control actions for cloud auth. Placed inside OpenworkControlProvider so
 * the actions are available on every route (including /welcome and /signin).
 */
function DenAuthControlActions() {
  const denAuth = useDenAuth();

  const exchangeGrantAction = useMemo<OpenworkControlAction>(() => ({
    id: "auth.exchange-grant",
    label: "Sign in with a handoff grant",
    description: "Exchange a desktop handoff grant string to sign in without the browser flow.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [
      { name: "grant", type: "string", required: true, description: "The raw handoff grant string." },
      { name: "baseUrl", type: "string", required: false, description: "Optional Den base URL." },
    ],
    execute: async (args) => {
      const { grant, baseUrl: argBaseUrl } = (args ?? {}) as { grant?: string; baseUrl?: string };
      if (!grant?.trim()) return { ok: false, error: "grant is required" };
      const settings = readDenSettings();
      const targetBaseUrl = argBaseUrl?.trim() || settings.baseUrl;
      const client = createDenClient({ baseUrl: targetBaseUrl, apiBaseUrl: settings.apiBaseUrl });
      const result = await client.exchangeDesktopHandoff(grant.trim());
      if (!result.token) return { ok: false, error: "No token returned" };
      writeDenSettings({
        baseUrl: targetBaseUrl,
        apiBaseUrl: client.baseUrls.apiBaseUrl,
        authToken: result.token,
        activeOrgId: null,
        activeOrgSlug: null,
        activeOrgName: null,
      });
      dispatchDenSessionUpdated({
        status: "success",
        baseUrl: targetBaseUrl,
        token: result.token,
        user: result.user,
        email: result.user?.email ?? null,
      });
      return { email: result.user?.email };
    },
  }), []);
  useControlAction(exchangeGrantAction);

  const authStatusAction = useMemo<OpenworkControlAction>(() => ({
    id: "auth.status",
    label: "Get auth status",
    description: "Return the current cloud sign-in status and user.",
    sideEffect: "none",
    execute: () => ({
      status: denAuth.status,
      user: denAuth.user ? { email: denAuth.user.email, name: denAuth.user.name } : null,
    }),
  }), [denAuth.status, denAuth.user]);
  useControlAction(authStatusAction);

  return null;
}


let appOpenedCaptured = false;

export function AppRoot() {
  useDesktopFontZoomBehavior();

  // Module-level dedupe keeps StrictMode double-mounts from double-counting.
  useEffect(() => {
    if (appOpenedCaptured) return;
    appOpenedCaptured = true;
    initAnalytics();
    captureAnalyticsEvent("app_opened", {});
  }, []);

  return (
    <>
      <BackgroundUpdater />
      <DevProfiler id="AppRoot">
        <ShellConfigProvider>
        <AppMenuProvider>
        <OpenworkControlProvider>
          <OpenworkRouteControlActions />
          <DenAuthControlActions />
          <DenSigninGate>
            <Routes>
              <Route
                path="/signin"
                element={
                  <DevProfiler id="SigninRoute">
                    <ForcedSigninPage developerMode={false} />
                  </DevProfiler>
                }
              />
              <Route
                path="/onboarding"
                element={
                  <DevProfiler id="OrgOnboarding">
                    <OrgOnboardingPage />
                  </DevProfiler>
                }
              />
              <Route
                path="/welcome"
                element={
                  <DevProfiler id="WelcomeRoute">
                    <WelcomeRoute />
                  </DevProfiler>
                }
              />
              <Route
                path="/session"
                element={
                  <DevProfiler id="SessionRoute">
                    <SessionRoute />
                  </DevProfiler>
                }
              />
              <Route
                path="/session/:sessionId"
                element={
                  <DevProfiler id="SessionRoute">
                    <SessionRoute />
                  </DevProfiler>
                }
              />
              <Route
                path="/workspace/:workspaceId/session"
                element={
                  <DevProfiler id="SessionRoute">
                    <SessionRoute />
                  </DevProfiler>
                }
              />
              <Route
                path="/workspace/:workspaceId/session/:sessionId"
                element={
                  <DevProfiler id="SessionRoute">
                    <SessionRoute />
                  </DevProfiler>
                }
              />
              <Route
                path="/workspace/:workspaceId/settings/*"
                element={
                  <DevProfiler id="SettingsRoute">
                    <SettingsRoute />
                  </DevProfiler>
                }
              />
              <Route
                path="/settings/*"
                element={
                  <DevProfiler id="SettingsRoute">
                    <SettingsRoute />
                  </DevProfiler>
                }
              />
              {/* Default + fallback: land on the session view. Users open
                  settings deliberately via the sidebar or command palette. */}
              <Route path="/" element={<Navigate to="/session" replace />} />
              <Route path="*" element={<Navigate to="/session" replace />} />
            </Routes>
          </DenSigninGate>
        </OpenworkControlProvider>
        </AppMenuProvider>
        </ShellConfigProvider>
        <LoadingOverlay />
      </DevProfiler>
      {/*
        DevProfilerOverlay sits OUTSIDE the AppRoot <Profiler> zone on
        purpose. The overlay re-renders on every emit() to refresh its
        table, and any commit inside a <Profiler> is recorded as a
        commit on that zone. Mounting the overlay inside AppRoot would
        inflate AppRoot's commit count by hundreds of overlay
        self-renders for every real user-visible commit, masking the
        true app-level signal.
      */}
      <NewProvidersListener />
      <DevProfilerOverlay />
      <ReactRenderWatchdogOverlay />
    </>
  );
}
