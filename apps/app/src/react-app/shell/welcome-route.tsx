/** @jsxImportSource react */
import { useCallback, useEffect, useReducer } from "react";
import { useNavigate } from "react-router-dom";

import { t } from "../../i18n";
import {
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  type WorkspaceInfo,
  type WorkspaceList,
} from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";
import { createClient, unwrap } from "../../app/lib/opencode";
import { useLocal } from "../kernel/local-provider";
import { WelcomePage } from "../domains/onboarding/welcome-page";
import { CreateWorkspaceModal } from "../domains/workspace/create-workspace-modal";
import { resolveOpenworkConnection } from "./openwork-connection";
import { buildOpenworkWorkspaceBaseUrl, createOpenworkServerClient } from "../../app/lib/openwork-server";
import { writeActiveWorkspaceId, writeLastSessionFor } from "./session-memory";
import { workspaceSessionRoute } from "./workspace-routes";

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
};

type WelcomeAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "create:start" }
  | { type: "create:error"; error: string }
  | { type: "create:finish" }
  | { type: "remote:start" }
  | { type: "remote:error"; error: string }
  | { type: "remote:finish" };

const initialWelcomeState: WelcomeState = {
  modalOpen: false,
  createBusy: false,
  createError: null,
  remoteBusy: false,
  remoteError: null,
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
  }
}

/**
 * WelcomeRoute: full-screen welcome page shown on first launch when
 * the user has no workspaces and has not completed onboarding.
 *
 * Clicking "Get started" opens the CreateWorkspaceModal. Once a
 * workspace is created, hasCompletedOnboarding is set and the user
 * is redirected to /session.
 */
export function WelcomeRoute() {
  const navigate = useNavigate();
  const local = useLocal();
  const [state, dispatch] = useReducer(welcomeReducer, initialWelcomeState);

  // If user already completed onboarding, redirect away immediately.
  useEffect(() => {
    if (local.prefs.hasCompletedOnboarding) {
      navigate("/session", { replace: true });
    }
  }, [local.prefs.hasCompletedOnboarding, navigate]);

  const markOnboardingComplete = useCallback(() => {
    local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true }));
  }, [local]);

  const handleCreateWorkspace = useCallback(
    async (_preset: string, folder: string | null) => {
      if (!folder) return;
      dispatch({ type: "create:start" });
      try {
        const workspaceName = folderNameFromPath(folder);
        let list: WorkspaceList | null = null;
        let serverBaseUrl = "";
        let serverToken = "";
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
            serverBaseUrl = normalizedBaseUrl;
            serverToken = resolvedToken;
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
        let targetSessionId: string | null = null;
        if (createdId) {
          await workspaceSetSelected(createdId).catch(() => undefined);
          await workspaceSetRuntimeActive(createdId).catch(() => undefined);
          writeActiveWorkspaceId(createdId);
        }
        if (targetWorkspaceId && serverBaseUrl && serverToken) {
          try {
            const workspacePath = targetWorkspace?.path?.trim() || folder;
            const session = unwrap(await createClient(
              `${(buildOpenworkWorkspaceBaseUrl(serverBaseUrl, targetWorkspaceId) ?? serverBaseUrl).replace(/\/+$/, "")}/opencode`,
              workspacePath || undefined,
              { token: serverToken, mode: "openwork" },
            ).session.create({ directory: workspacePath || undefined }));
            targetSessionId = session.id;
          } catch {
            // Best-effort first task creation.
          }
        }
        if (targetWorkspaceId) {
          writeActiveWorkspaceId(targetWorkspaceId);
          if (targetSessionId) writeLastSessionFor(targetWorkspaceId, targetSessionId);
        }
        markOnboardingComplete();
        dispatch({ type: "close" });
        navigate(targetWorkspaceId ? workspaceSessionRoute(targetWorkspaceId, targetSessionId) : "/session", { replace: true });
        if (targetSessionId) focusPromptSoon();
      } catch (error) {
        dispatch({
          type: "create:error",
          error: error instanceof Error ? error.message : "Failed to create workspace.",
        });
      } finally {
        dispatch({ type: "create:finish" });
      }
    },
    [markOnboardingComplete, navigate],
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

  return (
    <>
      <WelcomePage onGetStarted={() => dispatch({ type: "open" })} />
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
    </>
  );
}
