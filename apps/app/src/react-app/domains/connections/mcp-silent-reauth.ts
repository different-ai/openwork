import type { McpServerEntry, McpStatusMap } from "../../../app/types";

/**
 * Silent re-auth for remote OAuth MCP connectors.
 *
 * The OpenCode engine only refreshes an expired MCP access token reactively,
 * and at most once per transport lifetime. After the token expires (~1h for
 * Google) or after a transient refresh failure at engine startup, the entry
 * lands in `needs_auth` / `failed` and nothing retries it — users had to
 * click "Sign in" manually even though the stored refresh token still works.
 *
 * `mcp.connect` builds a fresh transport in the engine, so the MCP SDK
 * retries the stored refresh-token grant on the 401 — the same thing the
 * manual "Sign in" button does, minus the browser fallback. The engine's
 * connect path never opens a browser (its OAuth redirect handler is a
 * no-op), so a genuinely revoked grant simply stays in "Sign in needed".
 */

/**
 * Retry an unhealthy entry at most once per cooldown window. Short enough
 * that a wake-from-sleep heal lands on the next status refresh even when
 * the first attempt fired while the network was still down; long enough
 * that a genuinely revoked grant doesn't get hammered on every refresh.
 */
export const SILENT_REAUTH_COOLDOWN_MS = 60 * 1000;

export type SilentReauthClient = {
  mcp: {
    connect(parameters: { name: string; directory?: string }): Promise<unknown>;
  };
};

export function silentReauthAttemptKey(directory: string, name: string): string {
  return `${directory}\u0000${name}`;
}

/**
 * An entry qualifies for silent re-auth when it is a remote, enabled,
 * OAuth-capable connector (no static auth headers) that the engine reports
 * as unhealthy. Header-authed entries are written with `oauth: false`, so
 * they never qualify; neither do entries pending client registration, which
 * always need an interactive flow.
 */
export function isSilentReauthCandidate(entry: McpServerEntry, statuses: McpStatusMap): boolean {
  const status = statuses[entry.name]?.status;
  if (status !== "needs_auth" && status !== "failed") return false;
  const config = entry.config;
  if (config.type !== "remote") return false;
  if (config.enabled === false) return false;
  if (config.oauth === false) return false;
  if (config.headers && Object.keys(config.headers).length > 0) return false;
  return true;
}

export function selectSilentReauthCandidates(input: {
  directory: string;
  servers: McpServerEntry[];
  statuses: McpStatusMap;
  now: number;
  attempts: Map<string, number>;
  cooldownMs?: number;
}): string[] {
  const cooldownMs = input.cooldownMs ?? SILENT_REAUTH_COOLDOWN_MS;
  const names: string[] = [];
  for (const entry of input.servers) {
    const key = silentReauthAttemptKey(input.directory, entry.name);
    if (input.statuses[entry.name]?.status === "connected") {
      // Recovered — clear the cooldown so the next unhealthy episode gets
      // a fresh silent attempt.
      input.attempts.delete(key);
      continue;
    }
    if (!isSilentReauthCandidate(entry, input.statuses)) continue;
    const lastAttemptAt = input.attempts.get(key);
    if (lastAttemptAt !== undefined && input.now - lastAttemptAt < cooldownMs) continue;
    names.push(entry.name);
  }
  return names;
}

// Module-level so the cooldown survives store/component remounts.
const defaultAttempts = new Map<string, number>();
const inFlight = new Set<string>();

/**
 * Fire `mcp.connect` for every eligible unhealthy entry. Returns true when
 * at least one reconnect was attempted — the caller should then re-fetch
 * MCP statuses to pick up the healed state. Best-effort by design: failures
 * leave the entry unhealthy and the manual "Sign in" path untouched.
 */
export async function attemptSilentMcpReauth(input: {
  client: SilentReauthClient;
  directory: string;
  servers: McpServerEntry[];
  statuses: McpStatusMap;
  now?: number;
  attempts?: Map<string, number>;
  cooldownMs?: number;
}): Promise<boolean> {
  const directory = input.directory.trim();
  if (!directory) return false;

  const attempts = input.attempts ?? defaultAttempts;
  const now = input.now ?? Date.now();
  const names = selectSilentReauthCandidates({
    directory,
    servers: input.servers,
    statuses: input.statuses,
    now,
    attempts,
    cooldownMs: input.cooldownMs,
  }).filter((name) => !inFlight.has(silentReauthAttemptKey(directory, name)));
  if (names.length === 0) return false;

  for (const name of names) {
    const key = silentReauthAttemptKey(directory, name);
    attempts.set(key, now);
    inFlight.add(key);
  }

  try {
    await Promise.all(
      names.map(async (name) => {
        try {
          await input.client.mcp.connect({ name, directory });
        } catch {
          // Reconnect is best-effort; the entry stays unhealthy and the
          // user can still sign in manually.
        }
      }),
    );
  } finally {
    for (const name of names) {
      inFlight.delete(silentReauthAttemptKey(directory, name));
    }
  }
  return true;
}
