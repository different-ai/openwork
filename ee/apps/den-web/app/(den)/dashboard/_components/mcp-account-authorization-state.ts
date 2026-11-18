export const MCP_AUTHORIZATION_WINDOW_CLOSED_MESSAGE =
  "The sign-in tab closed before OpenWork confirmed the connection. Review the provider error, then try again.";

export const MCP_AUTHORIZATION_TIMEOUT_MESSAGE =
  "OpenWork could not confirm the connection. Review the provider error in this tab, then try again.";

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

/**
 * One poll of the sign-in tab. The tab's state is read before fetching: the
 * callback saves the account and then closes the tab, so only a fetch that
 * started after the tab closed can show the sign-in did not finish.
 */
export async function pollMcpAuthorization(input: {
  authorizationWindow: Pick<Window, "closed">;
  readConnected: () => Promise<boolean>;
  startedAt: number;
  timeoutMs: number;
  now?: () => number;
}): Promise<McpAuthorizationPollOutcome> {
  const authorizationWindowClosed = input.authorizationWindow.closed;
  const connected = await input.readConnected();
  return resolveMcpAuthorizationPollOutcome({
    connected,
    authorizationWindowClosed,
    elapsedMs: (input.now ?? Date.now)() - input.startedAt,
    timeoutMs: input.timeoutMs,
  });
}
