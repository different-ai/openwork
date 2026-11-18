/**
 * One MCP App tile on the dashboard. Provider metadata is never treated as
 * user authorization: safe-looking tools run automatically only after a
 * successful user-initiated launch, while approval-gated tools stay
 * run-on-request.
 */
export type DashboardMcpAppEntry = {
  kind: "mcp";
  id: string;
  serverName: string;
  /** Present for Connect app-host apps: launch them through this connection reference. */
  connectionId?: string;
  toolName: string;
  projectedToolName: string;
  resourceUri: string;
  title: string;
  /** Launch arguments selected by the organization administrator. */
  launchArguments?: Record<string, unknown>;
  /** Write-capable apps remain manual-only. */
  requiresApproval?: boolean;
  /** Server-authored admin policy to run this exact managed element automatically. */
  organizationAutoLaunch?: boolean;
  /** The member's locally stored approval for this exact managed element. */
  launchApproved?: boolean;
  /** The member enabled automatic launch by successfully running this exact safe element. */
  autoLaunch?: boolean;
};
