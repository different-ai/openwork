/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { t } from "../../i18n";
import {
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceCreate,
  workspaceCreateRemote,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
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
  const [modalOpen, setModalOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);

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
      setCreateBusy(true);
      setCreateError(null);
      try {
        const workspaceName = folderNameFromPath(folder);
        const list = await workspaceCreate({
          folderPath: folder,
          name: workspaceName,
          preset: "starter",
        });
        const createdId =
          resolveWorkspaceListSelectedId(list) ||
          list.workspaces[list.workspaces.length - 1]?.id ||
          "";
        let targetWorkspaceId = createdId;
        let targetWorkspace = list.workspaces.find((workspace) => workspace.id === createdId) ?? null;
        let targetSessionId: string | null = null;
        if (createdId) {
          await workspaceSetSelected(createdId).catch(() => undefined);
          await workspaceSetRuntimeActive(createdId).catch(() => undefined);
          writeActiveWorkspaceId(createdId);
        }
        // Register with the running openwork-server if available.
        try {
          const { normalizedBaseUrl, resolvedToken, resolvedHostToken } =
            await resolveOpenworkConnection();
          if (normalizedBaseUrl && resolvedToken) {
            const openworkClient = createOpenworkServerClient({
              baseUrl: normalizedBaseUrl,
              token: resolvedToken,
              hostToken: resolvedHostToken || undefined,
            });
            const serverList = await openworkClient
              .createLocalWorkspace({
                folderPath: folder,
                name: workspaceName,
                preset: "starter",
              })
              .catch(() => null);
            targetWorkspaceId = serverList
              ? resolveWorkspaceListSelectedId(serverList) || serverList.workspaces[serverList.workspaces.length - 1]?.id || targetWorkspaceId
              : targetWorkspaceId;
            targetWorkspace = serverList?.workspaces.find((workspace) => workspace.id === targetWorkspaceId) ?? targetWorkspace;
            if (targetWorkspaceId) {
              const workspacePath = targetWorkspace?.path?.trim() || folder;
              const session = unwrap(await createClient(
                `${(buildOpenworkWorkspaceBaseUrl(normalizedBaseUrl, targetWorkspaceId) ?? normalizedBaseUrl).replace(/\/+$/, "")}/opencode`,
                workspacePath || undefined,
                { token: resolvedToken, mode: "openwork" },
              ).session.create({ directory: workspacePath || undefined }));
              targetSessionId = session.id;
            }
          }
        } catch {
          // Best-effort server registration.
        }
        if (targetWorkspaceId) {
          writeActiveWorkspaceId(targetWorkspaceId);
          if (targetSessionId) writeLastSessionFor(targetWorkspaceId, targetSessionId);
        }
        markOnboardingComplete();
        setModalOpen(false);
        navigate(targetWorkspaceId ? workspaceSessionRoute(targetWorkspaceId, targetSessionId) : "/session", { replace: true });
        if (targetSessionId) focusPromptSoon();
      } catch (error) {
        setCreateError(
          error instanceof Error ? error.message : "Failed to create workspace.",
        );
      } finally {
        setCreateBusy(false);
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
      setRemoteBusy(true);
      setRemoteError(null);
      try {
        const list = await workspaceCreateRemote({
          baseUrl: baseUrlValue,
          openworkHostUrl: baseUrlValue,
          openworkToken: input.openworkToken?.trim() || null,
          displayName: input.displayName?.trim() || null,
          directory: input.directory?.trim() || null,
          remoteType: "openwork",
        });
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
        setModalOpen(false);
        navigate(createdId ? workspaceSessionRoute(createdId) : "/session", { replace: true });
        return true;
      } catch (error) {
        setRemoteError(
          error instanceof Error ? error.message : "Connection failed.",
        );
        return false;
      } finally {
        setRemoteBusy(false);
      }
    },
    [markOnboardingComplete, navigate],
  );

  return (
    <>
      <WelcomePage onGetStarted={() => setModalOpen(true)} />
      <CreateWorkspaceModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setCreateError(null);
          setRemoteError(null);
        }}
        onConfirm={handleCreateWorkspace}
        onConfirmRemote={handleCreateRemote}
        onPickFolder={() =>
          pickDirectory({ title: t("onboarding.authorize_folder") }) as Promise<
            string | null
          >
        }
        submitting={createBusy}
        localError={createError}
        remoteSubmitting={remoteBusy}
        remoteError={remoteError}
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
