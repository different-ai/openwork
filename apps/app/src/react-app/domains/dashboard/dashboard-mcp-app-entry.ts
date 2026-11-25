export type DashboardMcpAppEntry = {
  kind: "mcp";
  id: string;
  serverName: string;
  connectionId?: string;
  toolName: string;
  projectedToolName: string;
  resourceUri: string;
  title: string;
  launchArguments?: Record<string, unknown>;
  requiresApproval?: boolean;
  organizationAutoLaunch?: boolean;
  launchApproved?: boolean;
  autoLaunch?: boolean;
};
