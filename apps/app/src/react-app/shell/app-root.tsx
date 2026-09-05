/** @jsxImportSource react */

import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";

import { captureAnalyticsEvent, initAnalytics } from "../../app/lib/analytics";
import {
  readDenBootstrapConfig,
  readDenSettings,
  setDenBootstrapConfig,
} from "../../app/lib/den";
import { exchangeHandoffAndSignIn } from "../../app/lib/den-handoff";
import {
  denSettingsChangedEvent,
  denSessionUpdatedEvent,
} from "../../app/lib/den-session-events";
import { evalRelaunchDesktopApp } from "../../app/lib/desktop";
import { Button } from "../../components/ui/button";
import { t } from "../../i18n";
import { useDenAuth } from "../domains/cloud/den-auth-provider";
import {
  clearCloudInventoryCache,
  prefetchCloudInventory,
} from "../domains/connections/cloud-inventory-cache";
import { ForcedSigninPage } from "../domains/cloud/forced-signin-page";
import { EnterpriseActivationGate } from "../domains/cloud/enterprise-activation-gate";
import { OpenWorkWebAccessGate } from "../domains/cloud/openwork-web-access-gate";
import { OrgOnboardingPage } from "../domains/cloud/org-onboarding-page";
import { ChatDeepLinkListener } from "./chat-deep-link-listener";
import { NewProvidersListener } from "./new-providers-listener";
import { useDesktopFontZoomBehavior } from "./font-zoom";
import { LoadingOverlay } from "./loading-overlay";
import { useVisualViewportInset } from "../../hooks/use-visual-viewport-inset";
import { DevProfiler, DevProfilerOverlay } from "./dev-profiler";
import { ReactRenderWatchdogOverlay } from "./react-render-watchdog-overlay";
import { CloudWorkspaceOverlay, CloudWorkspaceStatusProvider } from "./cloud-workspace-overlay";
import { AppMenuProvider } from "./app-menu";
import {
  OpenworkControlProvider,
  OpenworkRouteControlActions,
  useControlAction,
  type OpenworkControlAction,
} from "./control/control-provider";
import { OpenworkContextPublisher } from "./openwork-context-publisher";
import { SessionRoute } from "./session-route";
import { DesktopUpdaterProvider } from "../domains/settings/state/desktop-updater-provider";
import { SettingsRoute } from "./settings-route";
import { ShellConfigProvider } from "./shell-config";
import { WelcomeRoute } from "./welcome-route";
import { readOrgSelectionPending } from "../../app/lib/den-sign-in-intent";
import { signedInRoute } from "./den-signin-routing";


type DenSigninGateProps = {
  children: ReactNode;
};

const readDenBootstrapSnapshot = () => readDenBootstrapConfig();

const subscribeToDenBootstrap = (onStoreChange: () => void) => {
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
  const locationRef = useRef(location);
  locationRef.current = location;
  const bootstrap = useSyncExternalStore(
    subscribeToDenBootstrap,
    readDenBootstrapSnapshot,
    readDenBootstrapSnapshot,
  );
  const requireSignin = bootstrap.requireSignin;
  const path = location.pathname.toLowerCase();
  const onSignin = path === "/signin" || path.startsWith("/signin/");
  const onOnboarding = path === "/onboarding" || path.startsWith("/onboarding/");
  const hasPreparedBootstrap = Boolean(bootstrap.prepared);
  const redirectingPreparedWorkspace =
    denAuth.status !== "checking" &&
    !requireSignin &&
    !denAuth.isSignedIn &&
    hasPreparedBootstrap &&
    !onOnboarding;

  useEffect(() => {
    // Wait for the first auth check so we don't bounce the user between
    // `/session` and `/signin` every navigation while we figure out if
    // their cached token is still valid.
    if (denAuth.status === "checking") return;

    if (requireSignin) {
      if (!denAuth.isSignedIn && !onSignin) {
        navigate("/signin", { replace: true });
      } else if (denAuth.isSignedIn && onSignin) {
        navigate(
          signedInRoute(readDenSettings().activeOrgId, {
            orgSelectionPending: readOrgSelectionPending().pending,
          }),
          { replace: true },
        );
      }
    } else if (onSignin) {
      navigate("/session", { replace: true });
    } else if (!denAuth.isSignedIn && hasPreparedBootstrap && !onOnboarding) {
      navigate("/onboarding", { replace: true });
    } else if (
      denAuth.isSignedIn &&
      !onOnboarding &&
      readOrgSelectionPending().pending
    ) {
      // A desktop-initiated sign-in is still waiting for the user's explicit
      // organization choice (including after an app relaunch mid-flow); the
      // onboarding step owns resolving it.
      navigate("/onboarding", { replace: true });
    }

    // If on /onboarding but not signed in, bounce to signin or session
    if (onOnboarding && !denAuth.isSignedIn && !hasPreparedBootstrap) {
      navigate(requireSignin ? "/signin" : "/session", { replace: true });
    }
  }, [
    denAuth.isSignedIn,
    denAuth.status,
    hasPreparedBootstrap,
    location,
    navigate,
    onOnboarding,
    onSignin,
    requireSignin,
  ]);

  // After a fresh sign-in, returning members go straight to chat. Give org
  // restoration a brief chance to settle before treating the user as new.
  useEffect(() => {
    const handler = (event: WindowEventMap[typeof denSessionUpdatedEvent]) => {
      if (event.detail?.status !== "success") return;
      const signInLocation = locationRef.current;
      let attempts = 0;
      const check = () => {
        const currentLocation = locationRef.current;
        if (
          currentLocation.pathname !== signInLocation.pathname
          || currentLocation.search !== signInLocation.search
          || currentLocation.hash !== signInLocation.hash
        ) return;
        attempts++;
        const settings = readDenSettings();
        if (settings.authToken?.trim() && readOrgSelectionPending().pending) {
          // Desktop-initiated sign-in: the org chooser decides — do not race
          // it to /session while the choice is deliberately open.
          navigate("/onboarding", { replace: true });
        } else if (settings.authToken?.trim() && settings.activeOrgId?.trim()) {
          navigate("/session", { replace: true });
        } else if (attempts < 10) {
          // Session persistence should already be done, but retry briefly in
          // case another consumer is still applying the handoff result.
          setTimeout(check, 500);
        } else if (settings.authToken?.trim()) {
          navigate(signedInRoute(settings.activeOrgId), { replace: true });
        }
      };
      // First check after a short delay for the auth to settle
      setTimeout(check, 500);
    };
    window.addEventListener(denSessionUpdatedEvent, handler);
    return () => window.removeEventListener(denSessionUpdatedEvent, handler);
  }, [navigate]);

  if (requireSignin && denAuth.status === "checking") {
    return null;
  }

  if (redirectingPreparedWorkspace) return <Navigate to="/onboarding" replace />;

  return (
    <>
      {denAuth.status === "unavailable" ? (
        <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex justify-center px-4">
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-2xl border border-amber-7/50 bg-popover/95 px-4 py-3 text-popover-foreground shadow-md backdrop-blur-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t("den.cloud_unavailable_title")}</p>
              <p className="text-xs text-muted-foreground">{t("den.cloud_unavailable_body")}</p>
            </div>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => void denAuth.refresh()}
            >
              {t("den.refresh")}
            </Button>
          </div>
        </div>
      ) : null}
      {children}
    </>
  );
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
      const result = await exchangeHandoffAndSignIn(grant.trim(), {
        baseUrl: targetBaseUrl,
        // Automation surface: commit the exchange-reported org directly; a
        // UI chooser would strand a headless driver.
        desktopInitiated: false,
        fallbackErrorMessage: "No token returned",
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { email: result.exchange.user?.email };
    },
  }), []);
  useControlAction(exchangeGrantAction);

  const authStatusAction = useMemo<OpenworkControlAction>(() => ({
    id: "auth.status",
    label: "Get auth status",
    description: "Return the current cloud sign-in status and user.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    execute: () => ({
      status: denAuth.status,
      user: denAuth.user ? { email: denAuth.user.email, name: denAuth.user.name } : null,
    }),
  }), [denAuth.status, denAuth.user]);
  useControlAction(authStatusAction);

  const setEvalBaseUrlAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.auth.set-base-url",
      label: "Set the eval Cloud URL",
      description: "Point the live auth provider at an eval control plane and refresh its session state.",
      sideEffect: "mutation",
      requiresArgs: true,
      args: [
        { name: "baseUrl", type: "string", required: true, description: "Temporary Den base URL." },
      ],
      execute: async (args) => {
        if (
          !args ||
          typeof args !== "object" ||
          !("baseUrl" in args) ||
          typeof args.baseUrl !== "string" ||
          !args.baseUrl.trim()
        ) {
          return { ok: false, error: "baseUrl is required" };
        }
        const current = readDenBootstrapConfig();
        await setDenBootstrapConfig({
          baseUrl: args.baseUrl.trim(),
          requireSignin: current.requireSignin,
          requireActivation: current.requireActivation,
        });
        await denAuth.refresh();
        return { baseUrl: readDenBootstrapConfig().baseUrl };
      },
    };
  }, [denAuth.refresh]);
  useControlAction(setEvalBaseUrlAction);

  return null;
}

/**
 * Control action for eval automation: inject brand theme (logo, icon, accent color)
 * via the dev-only desktop config bridge. Placed inside OpenworkControlProvider.
 */
function BrandThemeControlActions() {
  const applyAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.brand_theme.apply",
      label: "Apply brand theme override",
      description: "Inject brand theme (logo, icon, accent color) via desktop config for eval testing.",
      sideEffect: "mutation",
      args: [
        { name: "brandLogoUrl", type: "string", description: "Logo URL" },
        { name: "brandIconUrl", type: "string", description: "Icon URL" },
        { name: "brandAccentColor", type: "string", description: "Radix color family" },
      ],
      execute: (args) => {
        const bridge = (window as unknown as Record<string, unknown>).__openworkApplyDesktopConfig;
        if (typeof bridge !== "function") {
          return { ok: false, error: "Desktop config bridge not available (dev mode only)." };
        }
        bridge(args);
        return { applied: args };
      },
    };
  }, []);
  useControlAction(applyAction);

  const relaunchAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.app.relaunch",
      label: "Relaunch app for eval",
      description: "Dev-only eval hook that relaunches the Electron app.",
      sideEffect: "mutation",
      execute: () => evalRelaunchDesktopApp(),
    };
  }, []);
  useControlAction(relaunchAction);

  return null;
}

let appOpenedCaptured = false;

export function AppRoot() {
  useDesktopFontZoomBehavior();
  useVisualViewportInset();

  // Module-level dedupe keeps StrictMode double-mounts from double-counting.
  useEffect(() => {
    if (appOpenedCaptured) return;
    appOpenedCaptured = true;
    initAnalytics();
    captureAnalyticsEvent("app_opened", {});
  }, []);

  // Fetch what the organization shares with this member up front. Settings
  // mounts cold every time the extensions panel opens, so without this the
  // readiness groups wait on a Den round-trip the app could have done already.
  useEffect(() => {
    prefetchCloudInventory();
    const handleSessionChanged = () => {
      clearCloudInventoryCache();
      prefetchCloudInventory();
    };
    window.addEventListener(denSettingsChangedEvent, handleSessionChanged);
    return () => window.removeEventListener(denSettingsChangedEvent, handleSessionChanged);
  }, []);

  return (
    <>
      <DevProfiler id="AppRoot">
        <DesktopUpdaterProvider>
        <ShellConfigProvider>
        <AppMenuProvider>
        <OpenworkControlProvider>
          <OpenworkRouteControlActions />
          <ChatDeepLinkListener />
          <OpenworkContextPublisher />
          <DenAuthControlActions />
          <BrandThemeControlActions />
          <EnterpriseActivationGate>
            <DenSigninGate>
              <OpenWorkWebAccessGate>
                <CloudWorkspaceStatusProvider>
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
                path="/automations"
                element={
                  <DevProfiler id="AutomationsRoute">
                    <SessionRoute />
                  </DevProfiler>
                }
              />
              <Route path="/apps" element={<DevProfiler id="AppsRoute"><SessionRoute /></DevProfiler>} />
              <Route path="/dashboard/apps/:appId" element={<DevProfiler id="DashboardAppRoute"><SessionRoute /></DevProfiler>} />
              <Route path="/apps/:appId" element={<DevProfiler id="AppPreviewRoute"><SessionRoute /></DevProfiler>} />
              <Route
                path="/dashboard"
                element={
                  <DevProfiler id="DashboardRoute">
                    <SessionRoute />
                  </DevProfiler>
                }
              />
              <Route
                path="/workspace/:workspaceId/extensions/*"
                element={
                  <DevProfiler id="SessionRoute">
                    <SessionRoute />
                  </DevProfiler>
                }
              />
              <Route
                path="/extensions/*"
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
                  <LoadingOverlay />
                  <CloudWorkspaceOverlay />
                </CloudWorkspaceStatusProvider>
              </OpenWorkWebAccessGate>
            </DenSigninGate>
          </EnterpriseActivationGate>
        </OpenworkControlProvider>
        </AppMenuProvider>
        </ShellConfigProvider>
        </DesktopUpdaterProvider>
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
