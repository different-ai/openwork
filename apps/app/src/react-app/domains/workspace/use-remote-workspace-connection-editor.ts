/** @jsxImportSource react */
import { useCallback, useMemo, useState } from "react";

import {
  workspaceUpdateRemote,
  type WorkspaceInfo,
} from "../../../app/lib/desktop";
import { buildMicxWorkspaceBaseUrl, type MicxServerClient } from "../../../app/lib/micx-server";
import { isDesktopRuntime } from "../../../app/lib/runtime-env";
import { t } from "../../../i18n";
import type { RemoteWorkspaceInput } from "./types";

function describeEditorError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== "{}" ? serialized : t("app.unknown_error");
  } catch {
    return t("app.unknown_error");
  }
}

export function useRemoteWorkspaceConnectionEditor<TWorkspace extends WorkspaceInfo>(input: {
  workspaces: TWorkspace[];
  client: MicxServerClient | null;
  onSaved: (workspaceId: string) => void | Promise<void>;
}) {
  const { client, onSaved, workspaces } = input;
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workspace = useMemo(
    () =>
      workspaceId
        ? workspaces.find(
            (item) =>
              item.id === workspaceId && item.workspaceType === "remote",
          ) ?? null
        : null,
    [workspaces, workspaceId],
  );

  const initialValues = useMemo(
    () => {
      const hostUrl = workspace?.micxHostUrl ?? workspace?.baseUrl ?? "";
      const mountedUrl = workspace?.remoteType === "micx"
        ? buildMicxWorkspaceBaseUrl(hostUrl, workspace.micxWorkspaceId) ?? hostUrl
        : hostUrl;
      return {
        micxHostUrl: mountedUrl,
        micxToken:
          workspace?.micxToken ??
          workspace?.micxClientToken ??
          workspace?.micxHostToken ??
          "",
        directory: workspace?.directory ?? workspace?.path ?? "",
        displayName: workspace?.displayName ?? workspace?.name ?? "",
      };
    },
    [workspace],
  );

  const open = useCallback(
    (nextWorkspaceId: string) => {
      const next = workspaces.find((item) => item.id === nextWorkspaceId);
      if (!next || next.workspaceType !== "remote") return;
      setWorkspaceId(nextWorkspaceId);
      setError(null);
    },
    [workspaces],
  );

  const close = useCallback(() => {
    if (busy) return;
    setWorkspaceId(null);
    setError(null);
  }, [busy]);

  const save = useCallback(
    async (fields: RemoteWorkspaceInput) => {
      const id = workspaceId?.trim() ?? "";
      const baseUrl = fields.micxHostUrl?.trim() ?? "";
      if (!id || !baseUrl) {
        setError(t("dashboard.remote_base_url_required"));
        return;
      }

      setBusy(true);
      setError(null);
      try {
        const displayName = fields.displayName?.trim() || null;
        const directory = fields.directory?.trim() || null;
        const micxToken = fields.micxToken?.trim() ?? "";
        if (isDesktopRuntime()) {
          await workspaceUpdateRemote({
            workspaceId: id,
            baseUrl,
            micxHostUrl: baseUrl,
            micxToken,
            micxClientToken: "",
            micxHostToken: "",
            displayName,
            directory,
            remoteType: "micx",
          });
          await onSaved(id);
        } else {
          if (!client) throw new Error(t("app.error_connect_first"));
          const connectionChanged = baseUrl !== (initialValues.micxHostUrl?.trim() ?? "") ||
            micxToken !== (initialValues.micxToken?.trim() ?? "") ||
            directory !== (initialValues.directory?.trim() || null);
          if (connectionChanged) {
            const result = await client.createRemoteWorkspace({
              baseUrl,
              micxHostUrl: baseUrl,
              micxToken: micxToken || null,
              displayName,
              directory,
              remoteType: "micx",
            });
            await onSaved(result.activeId ?? id);
          } else {
            await client.updateWorkspaceDisplayName(id, displayName);
            await onSaved(id);
          }
        }
        setWorkspaceId(null);
      } catch (nextError) {
        setError(describeEditorError(nextError));
      } finally {
        setBusy(false);
      }
    },
    [client, initialValues.directory, initialValues.micxHostUrl, initialValues.micxToken, onSaved, workspaceId],
  );

  return {
    workspace,
    busy,
    error,
    initialValues,
    open,
    close,
    save,
  };
}
