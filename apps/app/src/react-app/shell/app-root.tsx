/** @jsxImportSource react */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";

import { captureAnalyticsEvent, initAnalytics, captureOnboardingEvent } from "../../app/lib/analytics";
import {
  readDenBootstrapConfig,
  readDenSettings,
  setDenBootstrapConfig,
} from "../../app/lib/den";
import { exchangeHandoffAndSignIn } from "../../app/lib/den-handoff";
import { denDeviceLogin, isConfiguredDenDeviceDestination } from "../../app/lib/den-device-login";
import { createDeviceLoginControl, readDeviceLoginRequestId } from "../../app/lib/device-login-control";
import { useDeploymentFeature } from "../domains/session/status/use-deployment-feature";
import {
  denSettingsChangedEvent,
  denSessionUpdatedEvent,
} from "../../app/lib/den-session-events";
import { evalRelaunchDesktopApp, readDesktopDistributionInfo } from "../../app/lib/desktop";
import { outboundEgressAllowed } from "../../app/lib/enterprise-activation";
import { isDesktopRuntime, isElectronRuntime } from "../../app/lib/runtime-env";
import { DeviceReporter } from "../domains/devices/device-reporter";
import { ComputerBridge } from "../domains/session/computer/computer-store";
import { Button } from "../../components/ui/button";
import { t } from "../../i18n";
import { useDenAuth } from "../domains/cloud/den-auth-provider";
import { useMemberActivitySync } from "../domains/cloud/use-member-activity-sync";
import { useDesktopConfig } from "../domains/cloud/desktop-config-provider";
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
import { LowStorageNotifier } from "./low-storage-notifier";
import { AutomationFailureNotifier } from "@/react-app/domains/automations/automation-failure-notifier";
import { useDesktopFontZoomBehavior } from "./font-zoom";
import { LoadingOverlay } from "./loading-overlay";
import { useVisualViewportInset } from "../../hooks/use-visual-viewport-inset";
import { DevProfiler, DevProfilerOverlay } from "./dev-profiler";
import { ReactRenderWatchdogOverlay } from "./react-render-watchdog-overlay";
import { CloudWorkspaceOverlay, CloudWorkspaceStatusProvider } from "./cloud-workspace-overlay";
import { EngineSwitchOverlay } from "./engine-switch";
import { useEngineRouting } from "./use-engine-routing";
import { MemberApiKeyDialog } from "../domains/connections/member-api-key-dialog";
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
import { readSignInReturnTarget, resolvePostHandoffRoute, shouldHandleSignInReturnAttempt } from "../../app/lib/den-sign-in-return";
import { completeSignInReturn } from "../domains/cloud/sign-in-return";
import {
  resolveDenSigninRedirect,
  shouldRenderPreparedRedirect,
  signedInRoute,
} from "./den-signin-routing";
import { StartupScreen } from "./startup-screen";
import { WebStartupScreen } from "./workspace-startup-status";
import { isOpenworkGatewayRuntime } from "../../app/lib/gateway-runtime";


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
  const routeInput = {
    authChecking: denAuth.status === "checking",
    isSignedIn: denAuth.isSignedIn,
    requireSignin,
    hasPreparedBootstrap,
    onSignin,
    onOnboarding,
    orgSelectionPending: false,
  };
  const redirectingPreparedWorkspace = shouldRenderPreparedRedirect(routeInput);

  useEffect(() => {
    const redirect = resolveDenSigninRedirect({
      authChecking: denAuth.status === "checking",
      isSignedIn: denAuth.isSignedIn,
      requireSignin,
      hasPreparedBootstrap,
      onSignin,
      onOnboarding,
      orgSelectionPending: denAuth.isSignedIn && readOrgSelectionPending().pending,
    });
    if (redirect === "signed-in-home") {
      navigate(
        signedInRoute(readDenSettings().activeOrgId, {
          orgSelectionPending: readOrgSelectionPending().pending,
        }),
        { replace: true },
      );
    } else if (redirect) {
      navigate(redirect, { replace: true });
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

  useEffect(() => {
    const handler = (event: WindowEventMap[typeof denSessionUpdatedEvent]) => {
      if (event.detail?.status === "error") {
        captureOnboardingEvent("onboarding_signin_failed", { reason: "handoff_failed" });
      }
      if (event.detail?.status !== "success") return;
      const signInLocation = locationRef.current;
      const signInAttempt = readSignInReturnTarget();
      let attempts = 0;
      const check = () => {
        const currentLocation = locationRef.current;
        if (
          currentLocation.pathname !== signInLocation.pathname
          || currentLocation.search !== signInLocation.search
          || currentLocation.hash !== signInLocation.hash
        ) return;
        const target = readSignInReturnTarget();
        if (!shouldHandleSignInReturnAttempt(signInAttempt, target)) return;
        attempts++;
        const settings = readDenSettings();
        const route = resolvePostHandoffRoute({
          hasToken: Boolean(settings.authToken?.trim()),
          activeOrgId: settings.activeOrgId,
          orgSelectionPending: readOrgSelectionPending().pending,
          target,
        });
        if (route) {
          if (route.kind !== "return" || !completeSignInReturn(navigate)) {
            navigate(route.kind === "return" ? "/session" : route.path, { replace: true });
          }
        } else if (attempts < 10) {
          setTimeout(check, 500);
        } else if (settings.authToken?.trim()) {
          navigate(signedInRoute(settings.activeOrgId), { replace: true });
        }
      };
      setTimeout(check, 500);
    };
    window.addEventListener(denSessionUpdatedEvent, handler);
    return () => window.removeEventListener(denSessionUpdatedEvent, handler);
  }, [navigate]);

  if (requireSignin && denAuth.status === "checking") {
    if (isOpenworkGatewayRuntime()) return <WebStartupScreen message="Checking sign-in…" />;
    return <StartupScreen message="Checking your sign-in" />;
  }

  if (redirectingPreparedWorkspace) return <Navigate to="/onboarding" replace />;

  return (
    <>
      {denAuth.status === "unavailable" ? (
        <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex justify-center px-4">
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-2xl bg-popover/95 px-4 py-3 text-popover-foreground shadow-md backdrop-blur-sm"
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

function DenAuthControlActions() {
  const denAuth = useDenAuth();
  const deviceLoginEnabled = useDeploymentFeature("remoteDesktopDeviceLogin");
  const deviceLoginEnabledRef = useRef(deviceLoginEnabled);
  deviceLoginEnabledRef.current = deviceLoginEnabled;
  const deviceLoginControl = useMemo(() => createDeviceLoginControl({
    flow: denDeviceLogin,
    deploymentFeature: () => deviceLoginEnabledRef.current,
    isConfiguredDestination: isConfiguredDenDeviceDestination,
  }), []);
  useEffect(() => {
    if (deviceLoginEnabled.enabled === false) deviceLoginControl.status();
  }, [deviceLoginControl, deviceLoginEnabled]);

  const exchangeGrantAction = useMemo<OpenworkControlAction>(() => ({
    id: "auth.exchange-grant",
    label: "Sign in with a handoff grant",
    description: "Exchange a desktop handoff grant string to sign in without the browser flow.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [
      { name: "grant", type: "string", required: true, description: "The raw handoff grant string." },
      { name: "baseUrl", type: "string", required: false, description: "Optional Den base URL." },
      { name: "apiBaseUrl", type: "string", required: false, description: "Optional Den API URL for a separately hosted API." },
    ],
    execute: async (args) => {
      const value = args && typeof args === "object" ? args : {};
      const grant = "grant" in value && typeof value.grant === "string" ? value.grant : undefined;
      const argBaseUrl = "baseUrl" in value && typeof value.baseUrl === "string" ? value.baseUrl : undefined;
      const apiBaseUrl = "apiBaseUrl" in value && typeof value.apiBaseUrl === "string" ? value.apiBaseUrl : undefined;
      if (!grant?.trim()) return { ok: false, error: "grant is required" };
      const settings = readDenSettings();
      const targetBaseUrl = argBaseUrl?.trim() || settings.baseUrl;
      const result = await exchangeHandoffAndSignIn(grant.trim(), {
        baseUrl: targetBaseUrl,
        apiBaseUrl,
        desktopInitiated: false,
        fallbackErrorMessage: "No token returned",
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { email: result.exchange.user?.email };
    },
  }), []);
  useControlAction(exchangeGrantAction);

  const deviceLoginStartAction = useMemo<OpenworkControlAction>(() => ({
    id: "auth.device-login.start",
    label: "Start device sign-in",
    description: "Sign this computer in by approving a code on another computer. Requires this server's device sign-in feature.",
    sideEffect: "mutation",
    args: [
      { name: "baseUrl", type: "string", required: false, description: "Optional Den base URL." },
      { name: "apiBaseUrl", type: "string", required: false, description: "Optional separately hosted Den API URL." },
      { name: "force", type: "boolean", required: false, description: "Replace an existing sign-in (equivalent to --force)." },
      { name: "requestId", type: "string", required: false, description: "Public caller ID to scope later status and cancellation to this attempt." },
    ],
    execute: (args) => {
      const request = readDeviceLoginRequestId(args);
      if (!request.ok) return request;
      const value = args && typeof args === "object" ? args : {};
      return deviceLoginControl.start({
        requestId: request.requestId,
        baseUrl: "baseUrl" in value && typeof value.baseUrl === "string" ? value.baseUrl : undefined,
        apiBaseUrl: "apiBaseUrl" in value && typeof value.apiBaseUrl === "string" ? value.apiBaseUrl : undefined,
        force: "force" in value && value.force === true,
      });
    },
  }), [deviceLoginControl]);
  useControlAction(deviceLoginStartAction);

  const deviceLoginStatusAction = useMemo<OpenworkControlAction>(() => ({
    id: "auth.device-login.status",
    label: "Get device sign-in status",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    args: [
      { name: "requestId", type: "string", required: false, description: "Public caller ID of the sign-in attempt to inspect." },
    ],
    execute: (args) => {
      const request = readDeviceLoginRequestId(args);
      return request.ok ? deviceLoginControl.status(request.requestId) : request;
    },
  }), [deviceLoginControl]);
  useControlAction(deviceLoginStatusAction);

  const deviceLoginCancelAction = useMemo<OpenworkControlAction>(() => ({
    id: "auth.device-login.cancel",
    label: "Cancel device sign-in",
    description: "Stop polling and discard this computer's pending sign-in code.",
    sideEffect: "mutation",
    args: [
      { name: "requestId", type: "string", required: false, description: "Public caller ID of the sign-in attempt to cancel." },
    ],
    execute: (args) => {
      const request = readDeviceLoginRequestId(args);
      return request.ok ? deviceLoginControl.cancel(request.requestId) : request;
    },
  }), [deviceLoginControl]);
  useControlAction(deviceLoginCancelAction);

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

  const [renderThrow, setRenderThrow] = useState<string | null>(null);
  const renderThrowAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.app.render_throw",
      label: "Throw during render for eval",
      description: "Dev-only eval hook that throws during React render so the app-level recovery screen can be exercised.",
      sideEffect: "mutation",
      requiresArgs: true,
      args: [{ name: "message", type: "string", required: true, description: "Error message to throw." }],
      execute: (args) => {
        if (typeof args !== "object" || args === null || !("message" in args) || typeof args.message !== "string") {
          return { ok: false, error: "message is required" };
        }
        setRenderThrow(args.message);
        return undefined;
      },
    };
  }, []);
  useControlAction(renderThrowAction);
  if (renderThrow) throw new Error(renderThrow);

  return null;
}

let appOpenedCaptured = false;

function useOutboundEgressAllowed() {
  const bootstrap = useSyncExternalStore(
    subscribeToDenBootstrap,
    readDenBootstrapSnapshot,
    readDenBootstrapSnapshot,
  );
  const desktopConfig = useDesktopConfig();
  return outboundEgressAllowed(readDesktopDistributionInfo(), bootstrap, {
    desktopConfigLoading: desktopConfig.loading,
  });
}

export function AppRoot() {
  useDesktopFontZoomBehavior();
  useVisualViewportInset();
  const egressAllowed = useOutboundEgressAllowed();
  useMemberActivitySync(egressAllowed);
  useEngineRouting(egressAllowed);

  useEffect(() => {
    if (!egressAllowed || appOpenedCaptured) return;
    appOpenedCaptured = true;
    initAnalytics();
    captureAnalyticsEvent("app_opened", {});
  }, [egressAllowed]);

  useEffect(() => {
    if (!egressAllowed) return;
    prefetchCloudInventory();
    const handleSessionChanged = () => {
      clearCloudInventoryCache();
      prefetchCloudInventory();
    };
    window.addEventListener(denSettingsChangedEvent, handleSessionChanged);
    return () => window.removeEventListener(denSettingsChangedEvent, handleSessionChanged);
  }, [egressAllowed]);

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
                  {isElectronRuntime() ? <ComputerBridge /> : null}
                  {isElectronRuntime() ? <DeviceReporter /> : null}
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
                    {isDesktopRuntime() ? <Navigate to="/session" replace /> : <WelcomeRoute />}
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
              <Route path="/activity" element={<DevProfiler id="ActivityRoute"><SessionRoute /></DevProfiler>} />
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
              <Route path="/" element={<Navigate to="/session" replace />} />
              <Route path="*" element={<Navigate to="/session" replace />} />
                  </Routes>
                  <LoadingOverlay />
                  <CloudWorkspaceOverlay />
                  <EngineSwitchOverlay />
                  <MemberApiKeyDialog />
                </CloudWorkspaceStatusProvider>
              </OpenWorkWebAccessGate>
            </DenSigninGate>
          </EnterpriseActivationGate>
        </OpenworkControlProvider>
        </AppMenuProvider>
        </ShellConfigProvider>
        </DesktopUpdaterProvider>
      </DevProfiler>
      <NewProvidersListener />
      <AutomationFailureNotifier />
      <LowStorageNotifier />
      <DevProfilerOverlay />
      <ReactRenderWatchdogOverlay />
    </>
  );
}
