import type { WorkspaceConnectionState } from "../../../app/types";
import type { WorkspaceInfo } from "../../../app/lib/desktop";
import {
  createOpenworkServerClient,
  normalizeOpenworkServerUrl,
  parseOpenworkWorkspaceIdFromUrl,
  type OpenworkServerClient,
} from "../../../app/lib/openwork-server";
import { redactTokenLikeText } from "../../../app/utils";

export type RemoteWorkspaceConnectionTarget = {
  kind: "openwork";
  baseUrl: string;
  endpointLabel: string;
  token: string;
  workspaceId: string | null;
};

type TargetResult =
  | { ok: true; target: RemoteWorkspaceConnectionTarget }
  | { ok: false; state: WorkspaceConnectionState };

export type RemoteWorkspaceConnectionResult = {
  ok: boolean;
  state: WorkspaceConnectionState;
  target?: RemoteWorkspaceConnectionTarget;
};

type TestOptions = {
  now?: () => number;
  createClient?: (target: RemoteWorkspaceConnectionTarget) => Pick<
    OpenworkServerClient,
    "health" | "capabilities" | "status" | "listWorkspaces"
  > | Promise<Pick<OpenworkServerClient, "health" | "capabilities" | "status" | "listWorkspaces">>;
};

function trim(value: string | null | undefined) {
  return value?.trim() ?? "";
}

function fail(message: string, checkedAt = Date.now()): RemoteWorkspaceConnectionResult {
  return {
    ok: false,
    state: {
      status: "error",
      message,
      checkedAt,
    },
  };
}

function endpointLabel(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.host}${path && path !== "/" ? path : ""}`;
  } catch {
    return baseUrl;
  }
}

function stripOpenworkWorkspaceMount(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    const workspaceIndex = segments.indexOf("workspace");
    const legacyIndex = segments.indexOf("w");
    const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
    if (mountIndex >= 0 && segments[mountIndex + 1]) {
      const prefix = segments.slice(0, mountIndex).join("/");
      url.pathname = prefix ? `/${prefix}` : "/";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    // Fall through to the already-normalized value below.
  }
  return baseUrl.replace(/\/+$/, "");
}

function isValidHttpEndpoint(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.host);
  } catch {
    return false;
  }
}

function describeUnknownError(error: unknown) {
  return redactRemoteDiagnosticText(error instanceof Error ? error.message : String(error || "Unknown error"));
}

function isServerErrorStatus(error: unknown, status: number | number[]) {
  const expected = Array.isArray(status) ? status : [status];
  const actual =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : NaN;
  return expected.includes(actual);
}

function rejectedTokenMessage(target: RemoteWorkspaceConnectionTarget) {
  return remoteSupportMessage(`Token was rejected by ${target.endpointLabel}. Edit connection and reconnect the worker.`);
}

function remoteSupportMessage(message: string) {
  return `${message} Upgrade the OpenWork host and try again. If this continues, contact team@openworklabs.com.`;
}

export function redactRemoteDiagnosticText(value: string): string {
  return redactTokenLikeText(value);
}

export function getRemoteWorkspaceConnectionKey(workspace: WorkspaceInfo): string {
  return [
    workspace.id,
    workspace.workspaceType,
    workspace.remoteType ?? "",
    trim(workspace.baseUrl),
    trim(workspace.openworkHostUrl),
    trim(workspace.openworkWorkspaceId),
    trim(workspace.openworkToken),
    trim(workspace.openworkClientToken),
    trim(workspace.openworkHostToken),
  ].join("\u001f");
}

function displayWorkspaceName(workspace: unknown) {
  if (!workspace || typeof workspace !== "object") return "";
  const value = workspace as {
    displayName?: string | null;
    openworkWorkspaceName?: string | null;
    name?: string | null;
    id?: string | null;
  };
  return (
    trim(value.displayName) ||
    trim(value.openworkWorkspaceName) ||
    trim(value.name) ||
    trim(value.id)
  );
}

function defaultCreateClient(target: RemoteWorkspaceConnectionTarget) {
  return createOpenworkServerClient({
    baseUrl: target.baseUrl,
    token: target.token || undefined,
  });
}

export function resolveRemoteWorkspaceConnectionTarget(workspace: WorkspaceInfo): TargetResult {
  if (workspace.workspaceType !== "remote") {
    return {
      ok: false,
      state: {
        status: "error",
        message: "Only remote workers can be tested.",
        checkedAt: Date.now(),
      },
    };
  }

  if (workspace.remoteType && workspace.remoteType !== "openwork") {
    return {
      ok: false,
      state: {
        status: "error",
        message: "Connection diagnostics are only available for OpenWork remote workers.",
        checkedAt: Date.now(),
      },
    };
  }

  const rawHostUrl = trim(workspace.openworkHostUrl) || trim(workspace.baseUrl);
  if (!rawHostUrl) {
    return {
      ok: false,
      state: {
        status: "error",
        message: remoteSupportMessage("Remote worker URL is missing. Edit connection and add a server URL."),
        checkedAt: Date.now(),
      },
    };
  }

  const normalizedHostUrl = normalizeOpenworkServerUrl(rawHostUrl);
  if (!normalizedHostUrl || !isValidHttpEndpoint(normalizedHostUrl)) {
    return {
      ok: false,
      state: {
        status: "error",
        message: remoteSupportMessage("Remote worker URL is invalid. Edit connection and use an http:// or https:// URL."),
        checkedAt: Date.now(),
      },
    };
  }

  const workspaceId =
    trim(workspace.openworkWorkspaceId) ||
    parseOpenworkWorkspaceIdFromUrl(normalizedHostUrl) ||
    parseOpenworkWorkspaceIdFromUrl(trim(workspace.baseUrl)) ||
    null;
  const hostBaseUrl = stripOpenworkWorkspaceMount(normalizedHostUrl);
  const token =
    trim(workspace.openworkToken) ||
    trim(workspace.openworkClientToken) ||
    trim(workspace.openworkHostToken);

  return {
    ok: true,
    target: {
      kind: "openwork",
      baseUrl: hostBaseUrl,
      endpointLabel: endpointLabel(hostBaseUrl),
      token,
      workspaceId,
    },
  };
}

export async function testRemoteWorkspaceConnection(
  workspace: WorkspaceInfo,
  options: TestOptions = {},
): Promise<RemoteWorkspaceConnectionResult> {
  const checkedAt = options.now?.() ?? Date.now();
  const targetResult = resolveRemoteWorkspaceConnectionTarget(workspace);
  if (!targetResult.ok) {
    return {
      ok: false,
      state: {
        ...targetResult.state,
        checkedAt,
      },
    };
  }

  const { target } = targetResult;
  const client = await (options.createClient?.(target) ?? defaultCreateClient(target));

  try {
    const health = await client.health();
    if (!health?.ok) {
      return fail(
        remoteSupportMessage(`Cannot reach ${target.endpointLabel}. Health check returned an unhealthy response.`),
        checkedAt,
      );
    }
  } catch (error) {
    return fail(
      remoteSupportMessage(`Cannot reach ${target.endpointLabel}. Health check failed: ${describeUnknownError(error)}`),
      checkedAt,
    );
  }

  if (!target.token) {
    return fail(
      remoteSupportMessage(`Token is missing for ${target.endpointLabel}. Edit connection and paste a valid OpenWork token.`),
      checkedAt,
    );
  }

  try {
    await client.capabilities();
  } catch (error) {
    if (isServerErrorStatus(error, [401, 403])) {
      return fail(rejectedTokenMessage(target), checkedAt);
    }
    return fail(
      remoteSupportMessage(`Connected to ${target.endpointLabel}, but capabilities failed: ${describeUnknownError(error)}`),
      checkedAt,
    );
  }

  if (target.workspaceId) {
    try {
      const list = await client.listWorkspaces();
      const workspace = list.items.find((item) => item.id === target.workspaceId) ?? null;
      if (!workspace) {
        return fail(
          remoteSupportMessage(`Workspace ${target.workspaceId} was not found on ${target.endpointLabel}. Reconnect the worker.`),
          checkedAt,
        );
      }
      const name = displayWorkspaceName(workspace) || target.workspaceId;
      return {
        ok: true,
        target,
        state: {
          status: "connected",
          message: `Connected to ${name}.`,
          checkedAt,
        },
      };
    } catch (error) {
      if (isServerErrorStatus(error, 403)) {
        return fail(
          remoteSupportMessage(`Workspace ${target.workspaceId} is not authorized on ${target.endpointLabel}. Check the token or server access rules.`),
          checkedAt,
        );
      }
      return fail(
        remoteSupportMessage(`Connected to ${target.endpointLabel}, but workspace list failed: ${describeUnknownError(error)}`),
        checkedAt,
      );
    }
  }

  try {
    const list = await client.listWorkspaces();
    const active =
      list.items.find((item) => item.id === list.activeId) ??
      list.items[0] ??
      null;
    const name = displayWorkspaceName(active) || target.endpointLabel;
    return {
      ok: true,
      target,
      state: {
        status: "connected",
        message: `Connected to ${name}.`,
        checkedAt,
      },
    };
  } catch (error) {
    if (isServerErrorStatus(error, [401, 403])) {
      return fail(rejectedTokenMessage(target), checkedAt);
    }
    return fail(
      remoteSupportMessage(`Connected to ${target.endpointLabel}, but workspace list failed: ${describeUnknownError(error)}`),
      checkedAt,
    );
  }
}

export async function diagnoseRemoteWorkspaceTaskLoadFailure(
  workspace: WorkspaceInfo,
  taskLoadError: string,
  options: TestOptions = {},
): Promise<WorkspaceConnectionState> {
  const checkedAt = options.now?.() ?? Date.now();
  const fallback = redactRemoteDiagnosticText(trim(taskLoadError) || "Remote worker connection failed.");

  try {
    const diagnostic = await testRemoteWorkspaceConnection(workspace, options);
    if (diagnostic.ok) {
      return {
        status: "error",
        message: `Worker is reachable, but tasks failed to load: ${fallback}`,
        checkedAt: diagnostic.state.checkedAt ?? checkedAt,
      };
    }

    return {
      status: "error",
      message: diagnostic.state.message?.trim() || fallback,
      checkedAt: diagnostic.state.checkedAt ?? checkedAt,
    };
  } catch (error) {
    return {
      status: "error",
      message: fallback || describeUnknownError(error),
      checkedAt,
    };
  }
}
