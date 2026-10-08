import { useCallback } from "react";
import type { ModelRef } from "@/app/types";
import { readDenSettings } from "@/app/lib/den";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { useDenAuth } from "../domains/cloud/den-auth-provider";
import { resolveSessionDraftScope } from "../domains/session/sync/draft-store";
import { useWorkspaceMaybe } from "../shell/workspace-provider";
import { setWorkspaceDefaultModel, workspaceModelScope } from "./model-config";

export function useWorkspaceModelProfile() {
  const auth = useDenAuth();
  const settings = readDenSettings();
  const identity = resolveSessionDraftScope({ hasCloudCredential: Boolean(settings.authToken?.trim()), verifiedIdentity: auth.verifiedIdentity });
  if (!identity) return null;
  if (identity === "local") return identity;
  try {
    const url = new URL(settings.baseUrl);
    return JSON.stringify([url.origin, url.pathname.replace(/\/+$/, ""), identity]);
  } catch { return null; }
}

export function useSetWorkspaceDefaultModel() {
  const workspace = useWorkspaceMaybe();
  const profileId = useWorkspaceModelProfile();
  const scope = workspaceModelScope({ profileId, workspaceId: workspace?.workspaceId ?? "",
    opencodeBaseUrl: workspace?.opencodeBaseUrl ?? "", localRuntime: isDesktopRuntime() });
  const profile = scope?.profileId;
  const runtime = scope?.runtime;
  const workspaceId = scope?.workspaceId;
  const setDefault = useCallback((model: ModelRef, variant: string | null = null) => {
    if (!profile || !runtime || !workspaceId) return false;
    return setWorkspaceDefaultModel({ profileId: profile, runtime, workspaceId }, model, variant);
  }, [profile, runtime, workspaceId]);
  return scope ? setDefault : undefined;
}
