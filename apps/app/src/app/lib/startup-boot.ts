export type BootPhase =
  | "nativeInit"
  | "workspaceBootstrap"
  | "engineProbe"
  | "engineStartOrConnect"
  | "sessionIndexReady"
  | "firstSessionReady"
  | "ready"
  | "error";

export type StartupBranch =
  | "firstRunNoWorkspace"
  | "remoteWorkspace"
  | "localAttachExisting"
  | "localHostStart"
  | "serverPreference"
  | "localPreference"
  | "welcome"
  | "unknown";

export type StartupTraceEvent = {
  at: number;
  phase: BootPhase;
  event: string;
  detail?: Record<string, unknown>;
};

export function classifyStartupBranch(input: {
  workspaceCount: number;
  activeWorkspaceType: "local" | "remote" | null;
  startupPreference: "local" | "server" | null;
  engineHasBaseUrl: boolean;
  selectedWorkspacePath: string;
}): StartupBranch {
  if (input.workspaceCount === 0) return "firstRunNoWorkspace";
  if (input.activeWorkspaceType === "remote") return "remoteWorkspace";
  if (input.startupPreference === "server") return "serverPreference";
  if (!input.selectedWorkspacePath.trim()) {
    if (input.startupPreference === "local") return "localPreference";
    return "welcome";
  }
  return input.engineHasBaseUrl ? "localAttachExisting" : "localHostStart";
}

export function pushStartupTraceEvent(
  current: StartupTraceEvent[],
  event: StartupTraceEvent,
  maxEvents = 100,
): StartupTraceEvent[] {
  if (!Number.isFinite(event.at) || !event.phase || !event.event) {
    return current;
  }
  const base = current.length >= maxEvents ? current.slice(current.length - maxEvents + 1) : current.slice();
  base.push(event);
  return base;
}
