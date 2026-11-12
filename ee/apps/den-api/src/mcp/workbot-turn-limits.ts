import type { AgentSourcesPolicy } from "@openwork/types/den/workbot-proactive"

/**
 * What an admin's Workbot settings take away from a Workbot conversation. A connection set to "Not allowed" there is
 * out for Workbot altogether: its checks never read it (workbot-proactive/sources.ts) and a turn in the chat can't
 * find or call it either, although the member may still use it everywhere else.
 *
 * The turn's token carries each such connection as a scope Den alone mints (`/v1/workbot/run-token`). Unlike a
 * background agent's allowlist these only ever take connections away, so they ride on a writing token too.
 */

/** `openwork:workbot-without-connection:<connectionId>`: one connection this turn can't use. */
const WITHOUT_CONNECTION_SCOPE_PREFIX = "openwork:workbot-without-connection:"

export function isWorkbotTurnLimitScope(scope: string): boolean {
  return scope.startsWith(WITHOUT_CONNECTION_SCOPE_PREFIX)
}

/**
 * A headless run token's scopes. Extra scopes (a background agent's sources, agent-read-sources.ts) only ever narrow a
 * read-only token; a writing one keeps only those that take connections away from a Workbot turn.
 */
export function headlessRunTokenScopes(input: { readOnly?: boolean; scopes?: readonly string[] }): string[] {
  return input.readOnly ? ["mcp:read", ...(input.scopes ?? [])] : ["mcp:read", "mcp:write", ...(input.scopes ?? []).filter(isWorkbotTurnLimitScope)]
}

/** The scopes for the connections an admin set to "Not allowed" for Workbot. */
export function workbotTurnLimitScopes(policy: Pick<AgentSourcesPolicy, "connections">): string[] {
  return Object.entries(policy.connections)
    .filter(([, value]) => value === "off")
    .map(([connectionId]) => `${WITHOUT_CONNECTION_SCOPE_PREFIX}${connectionId}`)
}

/** The connections a token's turn can't use; undefined for a token without any (every other caller). */
export function connectionsWithheld(scopes: ReadonlySet<string>): ReadonlySet<string> | undefined {
  const ids = new Set<string>()
  for (const scope of scopes) {
    if (!isWorkbotTurnLimitScope(scope)) continue
    const id = scope.slice(WITHOUT_CONNECTION_SCOPE_PREFIX.length)
    if (id) ids.add(id)
  }
  return ids.size ? ids : undefined
}

export const WORKBOT_CONNECTION_WITHHELD_MESSAGE = "isn't allowed for Workbot in your organization. An admin decides that in Workbot's settings."
