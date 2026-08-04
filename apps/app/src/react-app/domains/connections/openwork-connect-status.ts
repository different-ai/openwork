import type { SessionCloudMcpMaintenanceState } from "./use-session-mcp-maintenance";

export type OpenWorkConnectStatus = {
  state: "checking" | "ready" | "needs_attention";
  label: "Checking" | "Ready" | "Needs attention";
  description: string;
};

export function openWorkConnectAttentionTitle(description: string): string {
  return `One possible issue: ${description}`;
}

export function resolveOpenWorkConnectStatus(
  signedIn: boolean,
  maintenance: SessionCloudMcpMaintenanceState | undefined,
): OpenWorkConnectStatus | null {
  if (!signedIn) return null;

  // Den authentication is ready, but maintenance itself is workspace-scoped.
  // When there is no active workspace, report the verified Cloud connection
  // without claiming that connected-service delivery was checked.
  if (!maintenance || maintenance.status === "idle") {
    return {
      state: "ready",
      label: "Ready",
      description: "Signed in to OpenWork Cloud. Connected service tools will be checked when a workspace is active.",
    };
  }

  if (maintenance.status === "ready") {
    return {
      state: "ready",
      label: "Ready",
      description: "Connected service tools are available.",
    };
  }

  if (maintenance.status === "failed" || maintenance.status === "skipped") {
    return {
      state: "needs_attention",
      label: "Needs attention",
      description: maintenance.issue?.message
        ?? "OpenWork Connect could not verify connected service tools. Run diagnostics for details.",
    };
  }

  return {
    state: "checking",
    label: "Checking",
    description: maintenance.status === "retrying"
      ? `Restoring connected service tools (${maintenance.attempt}/${maintenance.maxAttempts}).`
      : "Checking connected service tools in the background.",
  };
}
