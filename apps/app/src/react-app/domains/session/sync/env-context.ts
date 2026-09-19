import { sideChatSystemContext } from "../chat/workbench-store";
import type { OpenworkServerClient } from "../../../../app/lib/openwork-server";
import { readOpenworkEnvPendingChanges } from "../../../../app/lib/openwork-env-runtime";
import { readOpenworkRuntimeFacts, renderOpenworkRuntimeContext } from "./runtime-context";

const MAX_CONTEXT_CACHE_ENTRIES = 100;
const ENV_KEYS_WAIT_MS = 1_000;

type EnvContextEntry = {
  client: OpenworkServerClient;
  runtimeKey: string | null;
  context?: string;
  pending?: Promise<string | undefined>;
};

// Key names belong to the authenticated client/runtime, not a conversation.
// Client identity prevents reuse across credential changes at the same URL.
const envSystemContextCache = new Set<EnvContextEntry>();

export function clearOpenworkEnvSystemContextCache(): void {
  envSystemContextCache.clear();
}

function normalizeEnvKeys(keys: string[]): string[] {
  return Array.from(
    new Set(
      keys.flatMap((key) => {
        const trimmed = key.trim();
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? [trimmed] : [];
      }),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

export async function buildOpenworkEnvSystemContext(
  client: OpenworkServerClient | null,
  options: {
    cacheKey?: string;
    runtimeKey?: string | null;
    readPendingChanges?: () => boolean;
    desktopTransport?: "main";
  } = {},
): Promise<string | undefined> {
  if (!client) return undefined;
  const readPendingChanges = options.readPendingChanges ??
    (() => readOpenworkEnvPendingChanges(options.runtimeKey));
  const runtimeKey = options.runtimeKey ?? null;
  let entry = Array.from(envSystemContextCache).find(
    (candidate) => candidate.client === client && candidate.runtimeKey === runtimeKey,
  );
  if (readPendingChanges()) {
    if (entry) envSystemContextCache.delete(entry);
    return undefined;
  }

  if (!entry) {
    if (envSystemContextCache.size >= MAX_CONTEXT_CACHE_ENTRIES) {
      const oldestSettled = Array.from(envSystemContextCache).find((candidate) => !candidate.pending);
      if (!oldestSettled) return undefined;
      envSystemContextCache.delete(oldestSettled);
    }
    const current: EnvContextEntry = { client, runtimeKey };
    envSystemContextCache.add(current);
    entry = current;
    const startedAt = performance.now();
    const lookup = Promise.resolve().then(async () => {
      try {
        const response = await client.listUserEnvKeys(options.desktopTransport ? { desktopTransport: options.desktopTransport } : undefined);
        if (readPendingChanges() || !envSystemContextCache.has(current)) {
          envSystemContextCache.delete(current);
          return undefined;
        }
        const keys = normalizeEnvKeys(response.keys ?? []);
        current.context = keys.length ? [
          "OpenWork environment variables configured:",
          keys.map((key) => `- ${key}`).join("\n"),
          "Only names are shown; values are secret. Use these names when relevant.",
        ].join("\n") : undefined;
        current.pending = undefined;
        return current.context;
      } catch {
        envSystemContextCache.delete(current);
        return undefined;
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        console.warn("Slow send preparation", {
          step: "environment_keys",
          thresholdMs: ENV_KEYS_WAIT_MS,
          durationMs: Math.round(performance.now() - startedAt),
        });
        resolve(undefined);
      }, ENV_KEYS_WAIT_MS);
    });
    // Only optional key-name hints time out, never authentication or admission.
    // Keep the settled race until lookup finishes: later sends skip the wait
    // without launching duplicate requests, and a late success warms the cache.
    current.pending = Promise.race([lookup, timeout]).finally(() => clearTimeout(timer));
  }

  const context = entry.pending ? await entry.pending : entry.context;
  if (readPendingChanges()) {
    envSystemContextCache.delete(entry);
    return undefined;
  }
  return envSystemContextCache.has(entry) ? context : undefined;
}

/**
 * The per-message `system` context every send carries: the user's time zone,
 * local date, and locale (computed fresh each send so a long-lived session
 * crosses midnight correctly), followed by the cached environment-key names
 * when the workspace has any.
 */
export async function buildOpenworkSessionSystemContext(
  client: OpenworkServerClient | null,
  options: {
    workspaceId?: string;
    cacheKey?: string;
    runtimeKey?: string | null;
    readPendingChanges?: () => boolean;
    desktopTransport?: "main";
  } = {},
): Promise<string> {
  const envContext = await buildOpenworkEnvSystemContext(client, options);
  const runtimeContext = renderOpenworkRuntimeContext(readOpenworkRuntimeFacts());
  const sideChatContext = options.workspaceId && options.cacheKey
    ? sideChatSystemContext(options.workspaceId, options.cacheKey) : undefined;
  return [runtimeContext, envContext, sideChatContext].filter(Boolean).join("\n\n");
}
