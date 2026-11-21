import {
  engineInfo,
  engineStart,
  openworkServerInfo,
  type EngineInfo,
  type OpenworkServerInfo,
} from "../../app/lib/desktop";
import {
  readOpenworkServerSettings,
  writeOpenworkServerSettings,
  type OpenworkServerSettings,
} from "../../app/lib/openwork-server";
import { safeStringify } from "../../app/utils";
import { recordInspectorEvent } from "../../app/lib/app-inspector";
import type { BootPhaseId } from "./boot-state";
import { captureOnboardingEvent } from "../../app/lib/analytics";

type LocalWorkspaceLike = {
  id: string;
  name?: string | null;
  displayNameResolved?: string | null;
  path?: string | null;
  workspaceType?: string | null;
};

type EnsureDesktopLocalOpenworkOptions = {
  route: "session" | "settings";
  workspace: LocalWorkspaceLike | null | undefined;
  allWorkspaces: LocalWorkspaceLike[];
};

function emitOpenworkSettingsChanged() {
  try {
    window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
  } catch {
  }
}

export function isReadyLocalOpenworkServerInfo(
  info: OpenworkServerInfo | null | undefined,
): info is OpenworkServerInfo {
  return Boolean(
    info?.running === true &&
      info.baseUrl?.trim() &&
      (info.ownerToken?.trim() || info.clientToken?.trim()),
  );
}

export const LOCAL_OPENWORK_READINESS_MAX_ATTEMPTS = 20;
export const LOCAL_OPENWORK_READINESS_RETRY_DELAY_MS = 500;

export function openworkServerSettingsChanged(
  previous: OpenworkServerSettings,
  next: OpenworkServerSettings,
): boolean {
  return previous.urlOverride !== next.urlOverride
    || previous.portOverride !== next.portOverride
    || previous.token !== next.token
    || previous.hostToken !== next.hostToken;
}

export async function waitForReadyLocalOpenworkServerInfo(options?: {
  fetchInfo?: () => Promise<OpenworkServerInfo | null>;
  maxAttempts?: number;
  wait?: (delayMs: number) => Promise<void>;
}): Promise<OpenworkServerInfo | null> {
  const fetchInfo =
    options?.fetchInfo ?? (() => openworkServerInfo() as Promise<OpenworkServerInfo | null>);
  const maxAttempts = Math.max(1, options?.maxAttempts ?? LOCAL_OPENWORK_READINESS_MAX_ATTEMPTS);
  const wait =
    options?.wait ??
    ((delayMs: number) => new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)));

  let lastInfo: OpenworkServerInfo | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await wait(LOCAL_OPENWORK_READINESS_RETRY_DELAY_MS);
    lastInfo = await fetchInfo().catch(() => null);
    if (isReadyLocalOpenworkServerInfo(lastInfo)) return lastInfo;
  }
  return lastInfo;
}

export type DesktopLocalReconnectInput = {
  desktopRuntime: boolean;
  bootPhase: BootPhaseId;
  bootRouteReady: boolean;
  routeLoading: boolean;
  hasClient: boolean;
  connectionPending: boolean;
  workspaceType: string | null | undefined;
};

export function shouldAttemptDesktopLocalReconnect(input: DesktopLocalReconnectInput): boolean {
  if (!input.desktopRuntime) return false;
  const bootSettled =
    input.bootPhase === "ready" ||
    input.bootPhase === "error" ||
    (input.bootPhase === "idle" && input.bootRouteReady);
  if (!bootSettled) return false;
  if (input.routeLoading) return false;
  if (input.hasClient && !input.connectionPending) return false;
  return input.workspaceType === "local";
}

function describeError(error: unknown) {
  if (error instanceof Error) return error.message;
  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : "Unknown error";
}

export async function ensureDesktopLocalOpenworkConnection(
  options: EnsureDesktopLocalOpenworkOptions,
) {
  const workspace = options.workspace;
  const workspaceRoot = workspace?.path?.trim() ?? "";
  if (!workspace || workspace.workspaceType !== "local" || !workspaceRoot) {
    return null;
  }

  const workspacePaths = Array.from(
    new Set(
      options.allWorkspaces.flatMap((item) => {
        const path = item.workspaceType === "local" ? item.path?.trim() ?? "" : "";
        return path ? [path] : [];
      }),
    ),
  );
  if (!workspacePaths.includes(workspaceRoot)) {
    workspacePaths.unshift(workspaceRoot);
  }

  recordInspectorEvent("route.local_openwork.ensure.start", {
    route: options.route,
    workspaceId: workspace.id,
    workspaceRoot,
  });

  try {
    const engine = await engineInfo().catch(() => null) as EngineInfo | null;
    let startedEngine = false;
    if (!engine?.running || !engine.baseUrl) {
      captureOnboardingEvent("onboarding_engine_start_requested");
      try {
        await engineStart(workspaceRoot, {
          runtime: "direct",
          workspacePaths,
        });
      } catch (error) {
        captureOnboardingEvent("onboarding_engine_failed", { reason: "start_failed" });
        throw error;
      }
      startedEngine = true;
    }

    const info = await waitForReadyLocalOpenworkServerInfo();
    if (!isReadyLocalOpenworkServerInfo(info) || !info.baseUrl) {
      captureOnboardingEvent("onboarding_engine_failed", { reason: "readiness_timeout" });
      throw new Error("OpenWork server did not become ready after activation.");
    }

    const previousSettings = readOpenworkServerSettings();
    const nextSettings = writeOpenworkServerSettings({
      urlOverride: info.baseUrl,
      token: info.ownerToken?.trim() || info.clientToken?.trim() || undefined,
      hostToken: info.hostToken?.trim() || undefined,
      portOverride: info.port ?? undefined,
    });
    if (startedEngine || openworkServerSettingsChanged(previousSettings, nextSettings)) {
      emitOpenworkSettingsChanged();
    }

    recordInspectorEvent("route.local_openwork.ensure.success", {
      route: options.route,
      workspaceId: workspace.id,
      workspaceRoot,
      baseUrl: info.baseUrl,
    });

    captureOnboardingEvent("onboarding_engine_ready", { started_engine: startedEngine });
    return info;
  } catch (error) {
    const message = describeError(error);
    console.error(`[${options.route}-route] local workspace reconnect failed`, error);
    recordInspectorEvent("route.local_openwork.ensure.error", {
      route: options.route,
      workspaceId: workspace.id,
      workspaceRoot,
      message,
    });
    throw new Error(message);
  }
}
