import type { McpServerEntry, McpStatusMap } from "../../../app/types";

export const SILENT_REAUTH_COOLDOWN_MS = 60 * 1000;

export type SilentReauthClient = {
  mcp: {
    connect(parameters: { name: string; directory?: string }): Promise<unknown>;
  };
};

export function silentReauthAttemptKey(directory: string, name: string): string {
  return `${directory}\u0000${name}`;
}

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

const defaultAttempts = new Map<string, number>();
const inFlight = new Set<string>();

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
