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
