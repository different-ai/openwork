import { createClient, waitForHealthy } from "../../../app/lib/opencode";
import {
  orchestratorStartDetached,
  sandboxDoctor,
  workspaceUpdateRemote,
} from "../../../app/lib/desktop";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  normalizeOpenworkServerUrl,
  OpenworkServerError,
  type OpenworkWorkspaceInfo,
} from "../../../app/lib/openwork-server";
import {
  isDesktopRuntime,
  normalizeDirectoryPath,
  safeStringify,
} from "../../../app/utils";

function normalizeRemoteType(value?: OpenworkWorkspaceInfo["remoteType"] | null) {
  return value === "openwork" ? "openwork" : "opencode";
}

function describeRemoteConnectionTarget(workspace: OpenworkWorkspaceInfo) {
  const remoteType = normalizeRemoteType(workspace.remoteType);
  if (remoteType === "openwork") {
    const hostUrl =
      workspace.openworkHostUrl?.trim() ||
      workspace.baseUrl?.trim() ||
      workspace.path?.trim() ||
      "";
    return hostUrl ? `OpenWork host ${hostUrl}` : "OpenWork host";
  }

  const baseUrl = workspace.baseUrl?.trim() || "";
  return baseUrl ? `worker ${baseUrl}` : "worker";
}

function formatRemoteConnectionError(workspace: OpenworkWorkspaceInfo, message: string) {
  const target = describeRemoteConnectionTarget(workspace);
  const detail = message.trim();
  return detail ? `${target}: ${detail}` : target;
}

async function resolveOpenworkHost(input: {
  hostUrl: string;
  token?: string | null;
  workspaceId?: string | null;
  directoryHint?: string | null;
}) {
  let normalizedHostUrl = normalizeOpenworkServerUrl(input.hostUrl) ?? "";
  if (!normalizedHostUrl) {
    return { kind: "fallback" as const };
  }

  let inferredWorkspaceId: string | null = null;
  try {
    const url = new URL(normalizedHostUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const prev = segments[segments.length - 2] ?? "";
    const alreadyMounted = prev === "w" && Boolean(last);
    if (alreadyMounted) {
      inferredWorkspaceId = decodeURIComponent(last);
      const baseSegments = segments.slice(0, -2);
      url.pathname = `/${baseSegments.join("/")}`;
      normalizedHostUrl = url.toString().replace(/\/+$/, "");
    }
  } catch {
    // ignore malformed URL parsing and keep the normalized input
  }

  const requestedWorkspaceId =
    (input.workspaceId?.trim() || inferredWorkspaceId || "").trim();
  const workspaceBaseUrl =
    buildOpenworkWorkspaceBaseUrl(normalizedHostUrl, requestedWorkspaceId) ??
    normalizedHostUrl;

  const client = createOpenworkServerClient({
    baseUrl: workspaceBaseUrl,
    token: input.token ?? undefined,
  });

  const trimmedToken = input.token?.trim() ?? "";

  try {
    const health = await client.health();
    if (!health?.ok) {
      return { kind: "fallback" as const };
    }
  } catch (error) {
    if (
      error instanceof OpenworkServerError &&
      (error.status === 401 || error.status === 403)
    ) {
      if (!trimmedToken) {
        throw new Error("Access token required for OpenWork server.");
      }
      throw new Error("OpenWork server rejected the access token.");
    }
    return { kind: "fallback" as const };
  }

  if (!trimmedToken) {
    throw new Error("Access token required for OpenWork server.");
  }

  const response = await client.listWorkspaces();
  const items = Array.isArray(response.items) ? response.items : [];
  const hint = normalizeDirectoryPath(input.directoryHint ?? "");
  const selectByHint = (entry: OpenworkWorkspaceInfo) => {
    if (!hint) return false;
    const entryPath = normalizeDirectoryPath(
      (entry.opencode?.directory as string | undefined) ??
        (entry.path as string | undefined) ??
        "",
    );
    return Boolean(entryPath && entryPath === hint);
  };
  const selectById = (entry: OpenworkWorkspaceInfo) =>
    Boolean(requestedWorkspaceId && entry?.id === requestedWorkspaceId);

  const workspaceById = requestedWorkspaceId
    ? items.find((item) => item?.id && selectById(item as OpenworkWorkspaceInfo))
    : undefined;
  if (requestedWorkspaceId && !workspaceById) {
    throw new Error("OpenWork worker not found on that host.");
  }

  const workspaceByHint = hint
    ? items.find((item) => item?.id && selectByHint(item as OpenworkWorkspaceInfo))
    : undefined;
  const workspace =
    (workspaceById ?? workspaceByHint ?? items[0]) as
      | OpenworkWorkspaceInfo
      | undefined;
  if (!workspace?.id) {
    throw new Error("OpenWork server did not return a worker.");
  }
  const opencodeUpstreamBaseUrl =
    workspace.opencode?.baseUrl?.trim() || workspace.baseUrl?.trim() || "";
  if (!opencodeUpstreamBaseUrl) {
    throw new Error("OpenWork server did not provide an OpenCode URL.");
  }

  const workspaceScopedBaseUrl =
    buildOpenworkWorkspaceBaseUrl(normalizedHostUrl, workspace.id) ??
    workspaceBaseUrl;

  return {
    kind: "openwork" as const,
    hostUrl: normalizedHostUrl,
    workspace,
    opencodeBaseUrl: `${workspaceScopedBaseUrl.replace(/\/+$/, "")}/opencode`,
    directory:
      workspace.opencode?.directory?.trim() ||
      workspace.directory?.trim() ||
      "",
  };
}

export async function testRemoteWorkspaceConnection(
  workspace: OpenworkWorkspaceInfo,
  fallbackToken?: string | null,
): Promise<{ ok: boolean; message: string | null }> {
  if (workspace.workspaceType !== "remote") {
    return { ok: true, message: null };
  }

  const remoteType = normalizeRemoteType(workspace.remoteType);

  if (remoteType === "openwork") {
    const hostUrl =
      workspace.openworkHostUrl?.trim() ||
      workspace.baseUrl?.trim() ||
      workspace.path?.trim() ||
      "";
    if (!hostUrl) {
      return { ok: false, message: "OpenWork server URL is required." };
    }

    const token = workspace.openworkToken?.trim() || fallbackToken?.trim() || undefined;
    try {
      const resolved = await resolveOpenworkHost({
        hostUrl,
        token,
        workspaceId: workspace.openworkWorkspaceId ?? null,
        directoryHint: workspace.directory ?? null,
      });
      if (resolved.kind !== "openwork") {
        return {
          ok: false,
          message: formatRemoteConnectionError(
            workspace,
            "OpenWork server unavailable. Check the URL and token.",
          ),
        };
      }
      return { ok: true, message: null };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : safeStringify(error);
      return {
        ok: false,
        message: formatRemoteConnectionError(workspace, message),
      };
    }
  }

  const baseUrl = workspace.baseUrl?.trim() || "";
  if (!baseUrl) {
    return { ok: false, message: "Remote base URL is required." };
  }

  try {
    const client = createClient(baseUrl, workspace.directory?.trim() || undefined);
    await waitForHealthy(client, { timeoutMs: 8_000 });
    return { ok: true, message: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : safeStringify(error);
    return {
      ok: false,
      message: formatRemoteConnectionError(workspace, message),
    };
  }
}

export async function recoverRemoteWorkspace(
  workspace: OpenworkWorkspaceInfo,
  fallbackToken?: string | null,
): Promise<{ ok: boolean; message: string | null }> {
  if (workspace.workspaceType !== "remote") {
    return { ok: true, message: null };
  }

  const isSandboxWorkspace =
    workspace.sandboxBackend === "docker" ||
    workspace.sandboxBackend === "microsandbox" ||
    Boolean(workspace.sandboxContainerName?.trim());

  if (!isSandboxWorkspace) {
    return testRemoteWorkspaceConnection(workspace, fallbackToken);
  }

  if (!isDesktopRuntime()) {
    return {
      ok: false,
      message: formatRemoteConnectionError(
        workspace,
        "Desktop runtime required to recover this worker.",
      ),
    };
  }

  const workspacePath =
    workspace.directory?.trim() || workspace.path?.trim() || "";
  if (!workspacePath) {
    return {
      ok: false,
      message: formatRemoteConnectionError(
        workspace,
        "Worker folder is missing. Open Edit connection and try again.",
      ),
    };
  }

  try {
    const doctor = await sandboxDoctor();
    if (!doctor?.ready) {
      throw new Error(
        doctor?.error?.trim() ||
          "Docker needs to be running before we can get this worker back online.",
      );
    }

    const host = await orchestratorStartDetached({
      workspacePath,
      sandboxBackend:
        workspace.sandboxBackend === "microsandbox"
          ? "microsandbox"
          : "docker",
      runId: workspace.sandboxRunId?.trim() || null,
      openworkToken:
        workspace.openworkClientToken?.trim() ||
        workspace.openworkToken?.trim() ||
        fallbackToken?.trim() ||
        null,
      openworkHostToken: workspace.openworkHostToken?.trim() || null,
    });

    const resolved = await resolveOpenworkHost({
      hostUrl: host.openworkUrl,
      token: host.ownerToken?.trim() || host.token,
      directoryHint: workspacePath,
    });

    if (resolved.kind !== "openwork") {
      throw new Error("Worker is still warming up. Try again in a few seconds.");
    }

    await workspaceUpdateRemote({
      workspaceId: workspace.id,
      remoteType: "openwork",
      baseUrl: resolved.opencodeBaseUrl,
      directory: resolved.directory || workspacePath,
      openworkHostUrl: resolved.hostUrl,
      openworkToken: host.ownerToken?.trim() || host.token,
      openworkClientToken: host.token,
      openworkHostToken: host.hostToken,
      openworkWorkspaceId: resolved.workspace.id,
      openworkWorkspaceName:
        resolved.workspace.name ?? workspace.openworkWorkspaceName ?? null,
      sandboxBackend: host.sandboxBackend ?? workspace.sandboxBackend ?? "docker",
      sandboxRunId: host.sandboxRunId ?? workspace.sandboxRunId ?? null,
      sandboxContainerName:
        host.sandboxContainerName ?? workspace.sandboxContainerName ?? null,
    });

    return { ok: true, message: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : safeStringify(error);
    return { ok: false, message: formatRemoteConnectionError(workspace, message) };
  }
}
