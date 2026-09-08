/** @jsxImportSource react */
import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";

import { t } from "../../i18n";
import {
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceCreateRemote,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  type WorkspaceInfo,
  type WorkspaceList,
} from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";
import { canCreateWorkspaces } from "../../app/lib/workspace-creation-policy";
import { useLocal } from "../kernel/local-provider";
import { usePlatform } from "../kernel/platform";
import { WelcomePage } from "../domains/onboarding/welcome-page";
import { ProviderSelectionStep } from "../domains/onboarding/provider-selection-step";
import { AttributionStep, type AttributionSource } from "../domains/onboarding/attribution-step";
import { CreateWorkspaceModal } from "../domains/workspace/create-workspace-modal";
import type { CreateWorkspaceOptions } from "../domains/workspace/types";
import {
  getOpenWorkModelsActionUrl,
  hideOpenWorkModelsPromo,
  useOpenWorkModelsPromoEligibility,
  markOpenWorkModelsStartupPromoShown,
} from "../domains/cloud/openwork-models-promo";
import { useDenAuth } from "../domains/cloud/den-auth-provider";
import { JoinOrganizationDialog } from "../domains/cloud/join-organization-dialog";
import { resolveOpenworkConnection } from "./openwork-connection";
import { captureAnalyticsEvent } from "../../app/lib/analytics";
import { createOpenworkServerClient } from "../../app/lib/openwork-server";
import { buildDenAuthUrl, DEFAULT_DEN_BASE_URL, readDenSettings } from "../../app/lib/den";
import { markDesktopSignInInitiated } from "../../app/lib/den-sign-in-intent";
import { denSettingsChangedEvent } from "../../app/lib/den-session-events";
import { writeActiveWorkspaceId, writeWorkspaceProjectDimension } from "./session-memory";
import { workspaceSessionRoute } from "./workspace-routes";
import { ensureDesktopLocalOpenworkConnection } from "./desktop-local-openwork";
import { shouldHoldWelcomeForDenSession } from "./welcome-den-session";

function subscribeToDenSettings(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(denSettingsChangedEvent, onStoreChange);
  return () => window.removeEventListener(denSettingsChangedEvent, onStoreChange);
}

function readDenAuthTokenSnapshot() {
  return readDenSettings().authToken?.trim() ?? "";
}

function folderNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
}

function focusPromptSoon() {
  if (typeof window === "undefined") return;
  const focus = () => window.dispatchEvent(new Event("openwork:focusPrompt"));
  [0, 80, 240, 600].forEach((delay) => window.setTimeout(focus, delay));
}

type WelcomeState = {
  modalOpen: boolean;
  createBusy: boolean;
  createError: string | null;
  remoteBusy: boolean;
  remoteError: string | null;
  providerStep: boolean;
  attributionStep: boolean;
  pendingRoute: string | null;
  pendingWorkspaceId: string | null;
};

type WelcomeAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "create:start" }
  | { type: "create:error"; error: string }
  | { type: "create:finish" }
  | { type: "remote:start" }
  | { type: "remote:error"; error: string }
  | { type: "remote:finish" }
  | { type: "provider-step"; workspaceId: string }
  | { type: "attribution-step"; route: string };

const initialWelcomeState: WelcomeState = {
  modalOpen: false,
  createBusy: false,
  createError: null,
  remoteBusy: false,
  remoteError: null,
  providerStep: false,
  attributionStep: false,
  pendingRoute: null,
  pendingWorkspaceId: null,
};

function welcomeReducer(state: WelcomeState, action: WelcomeAction): WelcomeState {
  switch (action.type) {
    case "open":
      return { ...state, modalOpen: true };
    case "close":
      return { ...state, modalOpen: false, createError: null, remoteError: null };
    case "create:start":
      return { ...state, createBusy: true, createError: null };
    case "create:error":
      return { ...state, createError: action.error };
    case "create:finish":
      return { ...state, createBusy: false };
    case "remote:start":
      return { ...state, remoteBusy: true, remoteError: null };
    case "remote:error":
      return { ...state, remoteError: action.error };
    case "remote:finish":
      return { ...state, remoteBusy: false };
    case "provider-step":
      return { ...state, providerStep: true, pendingWorkspaceId: action.workspaceId };
    case "attribution-step":
      return { ...state, providerStep: false, attributionStep: true, pendingRoute: action.route };
  }
}

/**
 * WelcomeRoute: full-screen welcome page shown on first launch when
 * the user has no workspaces and has not completed onboarding.
 *
 * Clicking "Get started" opens the CreateWorkspaceModal. Once a
 * workspace is created, provider and attribution onboarding runs before
 * hasCompletedOnboarding is set and the user is redirected to /session.
 */
export function WelcomeRoute() {
  const navigate = useNavigate();
  const local = useLocal();
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const [state, dispatch] = useReducer(welcomeReducer, initialWelcomeState);
  const [manualFolder, setManualFolder] = useState("");
  const [joinOrganizationOpen, setJoinOrganizationOpen] = useState(false);
  const showOpenWorkModelsPromo = useOpenWorkModelsPromoEligibility();
  const denAuthTokenSnapshot = useSyncExternalStore(
    subscribeToDenSettings,
    readDenAuthTokenSnapshot,
    readDenAuthTokenSnapshot,
  );
  const holdSignedOutSurface = shouldHoldWelcomeForDenSession({
    authStatus: denAuth.status,
    hasStoredAuthToken: Boolean(denAuthTokenSnapshot),
    isSignedIn: denAuth.isSignedIn,
  });

  // If user already completed onboarding, redirect away immediately.
  useEffect(() => {
    if (local.prefs.hasCompletedOnboarding) {
      navigate("/session", { replace: true });
    }
  }, [local.prefs.hasCompletedOnboarding, navigate]);

  useEffect(() => {
    if (denAuth.isSignedIn) {
      navigate("/onboarding", { replace: true });
    }
  }, [denAuth.isSignedIn, navigate]);

  const markOnboardingComplete = useCallback(() => {
    local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true }));
  }, [local]);

  const handleCreateWorkspace = useCallback(
    async (_preset: string, folder: string | null, options?: CreateWorkspaceOptions) => {
      if (!folder) return;
      const projectLabel = options?.projectLabel?.trim() ?? "";
      dispatch({ type: "create:start" });
      try {
        const workspaceName = folderNameFromPath(folder);
        let list: WorkspaceList | null = null;
        try {
          const { normalizedBaseUrl, resolvedToken, resolvedHostToken } =
            await resolveOpenworkConnection();
          if (normalizedBaseUrl && (resolvedToken || resolvedHostToken)) {
            const openworkClient = createOpenworkServerClient({
              baseUrl: normalizedBaseUrl,
              token: resolvedToken || undefined,
              hostToken: resolvedHostToken || undefined,
            });
            list = await openworkClient.createLocalWorkspace({
              folderPath: folder,
              name: workspaceName,
              preset: "starter",
            });
          }
        } catch {
          list = null;
        }
        if (!list) {
          throw new Error("OpenWork server is unavailable. Start or reconnect the server before creating a workspace.");
        }
        const createdId =
          resolveWorkspaceListSelectedId(list) ||
          list.workspaces[list.workspaces.length - 1]?.id ||
          "";
        let targetWorkspaceId = createdId;
        let targetWorkspace = list.workspaces.find((workspace: WorkspaceInfo) => workspace.id === createdId) ?? null;
        if (createdId) {
          await workspaceSetSelected(createdId).catch(() => undefined);
          await workspaceSetRuntimeActive(createdId).catch(() => undefined);
          writeActiveWorkspaceId(createdId);
        }
        if (targetWorkspace) {
          await ensureDesktopLocalOpenworkConnection({
            route: "session",
            workspace: targetWorkspace,
            allWorkspaces: list.workspaces,
          }).catch(() => undefined);
        }
        if (targetWorkspaceId) {
          writeActiveWorkspaceId(targetWorkspaceId);
          if (projectLabel) {
            writeWorkspaceProjectDimension(targetWorkspaceId, {
              label: projectLabel,
            });
          }
        }
        dispatch({ type: "close" });
        // Show the provider selection step before navigating to the session.
        // Keep the new-task screen stable. The first explicit submission
        // creates a session, just like any other empty workspace.
        dispatch({ type: "provider-step", workspaceId: targetWorkspaceId });

      } catch (error) {
        dispatch({
          type: "create:error",
          error: error instanceof Error ? error.message : "Failed to create workspace.",
        });
      } finally {
        dispatch({ type: "create:finish" });
      }
    },
    [],
  );

  const handleCreateRemote = useCallback(
    async (input: {
      openworkHostUrl?: string | null;
      openworkToken?: string | null;
      directory?: string | null;
      displayName?: string | null;
    }) => {
      const baseUrlValue = input.openworkHostUrl?.trim() ?? "";
      if (!baseUrlValue) return false;
      dispatch({ type: "remote:start" });
      try {
        const remoteType: "openwork" = "openwork";
        const payload = {
          baseUrl: baseUrlValue,
          openworkHostUrl: baseUrlValue,
          openworkToken: input.openworkToken?.trim() || null,
          displayName: input.displayName?.trim() || null,
          directory: input.directory?.trim() || null,
          remoteType,
        };
        let list: WorkspaceList | null = null;
        if (isDesktopRuntime()) {
          list = await workspaceCreateRemote(payload);
        } else {
          try {
            const { normalizedBaseUrl, resolvedToken, resolvedHostToken } =
              await resolveOpenworkConnection();
            if (normalizedBaseUrl && (resolvedToken || resolvedHostToken)) {
              list = await createOpenworkServerClient({
                baseUrl: normalizedBaseUrl,
                token: resolvedToken || undefined,
                hostToken: resolvedHostToken || undefined,
              }).createRemoteWorkspace(payload);
            }
          } catch {
            list = null;
          }
        }
        if (!list) {
          throw new Error("OpenWork server is unavailable. Start or reconnect the server before connecting a remote workspace.");
        }
        const createdId =
          resolveWorkspaceListSelectedId(list) ||
          list.workspaces[list.workspaces.length - 1]?.id ||
          "";
        if (createdId) {
          await workspaceSetSelected(createdId).catch(() => undefined);
          await workspaceSetRuntimeActive(createdId).catch(() => undefined);
          writeActiveWorkspaceId(createdId);
        }
        markOnboardingComplete();
        dispatch({ type: "close" });
        navigate(createdId ? workspaceSessionRoute(createdId) : "/session", { replace: true });
        return true;
      } catch (error) {
        dispatch({
          type: "remote:error",
          error: error instanceof Error ? error.message : "Connection failed.",
        });
        return false;
      } finally {
        dispatch({ type: "remote:finish" });
      }
    },
    [markOnboardingComplete, navigate],
  );

  const handleGetStarted = useCallback(async () => {
    if (!isDesktopRuntime()) {
      if (!canCreateWorkspaces()) return;
      // Non-desktop: fall back to the modal for remote workspace creation.
      dispatch({ type: "open" });
      return;
    }
    const picked = await pickDirectory({ title: t("onboarding.authorize_folder") });
    const folder = typeof picked === "string" ? picked : null;
    if (!folder) return;
    await handleCreateWorkspace("starter", folder);
  }, [handleCreateWorkspace]);

  const handleUseManualFolder = useCallback(async () => {
    const folder = manualFolder.trim();
    if (!folder) return;
    await handleCreateWorkspace("starter", folder);
  }, [handleCreateWorkspace, manualFolder]);

  const handleTeamSignIn = useCallback(() => {
    markOnboardingComplete();
    const settings = readDenSettings();
    markDesktopSignInInitiated();
    platform.openLink(buildDenAuthUrl(settings.baseUrl || DEFAULT_DEN_BASE_URL, "sign-in"));
  }, [markOnboardingComplete, platform]);

  const finishOnboarding = useCallback(() => {
    markOnboardingComplete();
    navigate(state.pendingRoute ?? "/session", { replace: true });
    focusPromptSoon();
  }, [markOnboardingComplete, navigate, state.pendingRoute]);

  const handleAttributionSubmit = useCallback(
    (source: AttributionSource, aiPrompt?: string) => {
      const prompt = aiPrompt?.trim().slice(0, 500) ?? "";
      captureAnalyticsEvent("attribution_survey_submitted", {
        source,
        // User-volunteered survey answer (not session content); see survey UI.
        ai_prompt: prompt || null,
        ai_prompt_length: prompt.length,
      });
      finishOnboarding();
    },
    [finishOnboarding],
  );

  const handleAttributionSkip = useCallback(() => {
    captureAnalyticsEvent("attribution_survey_skipped");
    finishOnboarding();
  }, [finishOnboarding]);

  if (holdSignedOutSurface) {
    return null;
  }

  return (
    <>
      <WelcomePage
        onGetStarted={handleGetStarted}
        busy={state.createBusy}
        error={state.createError}
        manualFolder={manualFolder}
        onManualFolderChange={setManualFolder}
        onUseManualFolder={handleUseManualFolder}
        showManualFolder={import.meta.env.DEV && isDesktopRuntime()}
        onTeamSignIn={handleTeamSignIn}
        onJoinOrganization={() => setJoinOrganizationOpen(true)}
      />
      <JoinOrganizationDialog
        open={joinOrganizationOpen}
        onOpenChange={setJoinOrganizationOpen}
        onConnected={() => {
          markOnboardingComplete();
          setJoinOrganizationOpen(false);
        }}
      />
      <CreateWorkspaceModal
        open={state.modalOpen}
        onClose={() => dispatch({ type: "close" })}
        onConfirm={handleCreateWorkspace}
        onConfirmRemote={handleCreateRemote}
        onPickFolder={() =>
          pickDirectory({ title: t("onboarding.authorize_folder") }) as Promise<
            string | null
          >
        }
        submitting={state.createBusy}
        localError={state.createError}
        remoteSubmitting={state.remoteBusy}
        remoteError={state.remoteError}
        localDisabled={!isDesktopRuntime()}
        localDisabledReason={
          isDesktopRuntime()
            ? undefined
            : t("app.local_disabled_reason")
        }
      />
      {state.providerStep ? (
        <ProviderSelectionStep
          showOpenWorkModels={showOpenWorkModelsPromo}
          onOpenWorkModels={() => {
            // Land on the OpenWork Models value-prop page when already
            // signed in to Den; otherwise start sign-up. Previously this
            // always opened a bare sign-up page — payment before value.
            platform.openLink(getOpenWorkModelsActionUrl(denAuth.isSignedIn, "sign-up"));
            const route = state.pendingWorkspaceId
              ? workspaceSessionRoute(state.pendingWorkspaceId)
              : "/session";
            dispatch({ type: "attribution-step", route });
          }}
          onBringYourOwn={() => {
            markOpenWorkModelsStartupPromoShown();
            hideOpenWorkModelsPromo();
            const route = state.pendingWorkspaceId
              ? workspaceSessionRoute(state.pendingWorkspaceId)
              : "/session";
            dispatch({ type: "attribution-step", route: `${route}?onboarding=1` });
          }}
          onSkip={() => {
            const route = state.pendingWorkspaceId
              ? workspaceSessionRoute(state.pendingWorkspaceId)
              : "/session";
            dispatch({ type: "attribution-step", route });
          }}
        />
      ) : null}
      {state.attributionStep ? (
        <AttributionStep
          onSubmit={handleAttributionSubmit}
          onSkip={handleAttributionSkip}
        />
      ) : null}
    </>
  );
}
