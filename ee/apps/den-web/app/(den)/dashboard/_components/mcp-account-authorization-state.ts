export const MCP_AUTHORIZATION_WINDOW_CLOSED_MESSAGE =
  "The sign-in window closed before OpenWork confirmed the connection. Review the provider error, then try again.";

export const MCP_AUTHORIZATION_TIMEOUT_MESSAGE =
  "OpenWork could not confirm the connection. Review the provider error in this window, then try again.";

export const MCP_AUTHORIZATION_UNCONFIRMED_CONNECTED_MESSAGE =
  "The provider responded, but OpenWork could not confirm this account connection. Review the provider configuration, then try again.";

export type McpAuthorizationPollOutcome = "connected" | "window_closed" | "timeout" | "pending";

export function resolveMcpAuthorizationPollOutcome(input: {
  connected: boolean;
  authorizationWindowClosed: boolean;
  elapsedMs: number;
  timeoutMs: number;
}): McpAuthorizationPollOutcome {
  if (input.connected) return "connected";
  if (input.authorizationWindowClosed) return "window_closed";
  if (input.elapsedMs >= input.timeoutMs) return "timeout";
  return "pending";
}
