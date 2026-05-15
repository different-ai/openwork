import type { OpenworkServerClient } from "../../../../app/lib/openwork-server";
import { readOpenworkEnvPendingChanges } from "../../../../app/lib/openwork-env-runtime";

const DEFAULT_CACHE_KEY = "__openwork_env_default__";
const MAX_CONTEXT_CACHE_ENTRIES = 100;

const envSystemContextCache = new Map<string, string | undefined>();

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
  } = {},
): Promise<string | undefined> {
  if (!client) return undefined;
  const readPendingChanges = options.readPendingChanges ??
    (() => readOpenworkEnvPendingChanges(options.runtimeKey));
  if (readPendingChanges()) return undefined;

  const cacheKey = `${client.baseUrl}:${options.cacheKey ?? DEFAULT_CACHE_KEY}`;
  if (envSystemContextCache.has(cacheKey)) {
    return envSystemContextCache.get(cacheKey);
  }

  try {
    const response = await client.listUserEnvKeys();
    const keys = normalizeEnvKeys(response.keys ?? []);
    if (keys.length === 0) {
      rememberEnvSystemContext(cacheKey, undefined);
      return undefined;
    }

    const keyList = keys.map((key) => `- ${key}`).join("\n");

    const context = [
      "OpenWork environment variables configured:",
      keyList,
      "Only names are shown; values are secret. Use these names when relevant.",
    ].join("\n");
    rememberEnvSystemContext(cacheKey, context);
    return context;
  } catch {
    return undefined;
  }
}

function rememberEnvSystemContext(cacheKey: string, context: string | undefined): void {
  if (envSystemContextCache.size >= MAX_CONTEXT_CACHE_ENTRIES && !envSystemContextCache.has(cacheKey)) {
    const firstKey = envSystemContextCache.keys().next().value;
    if (firstKey) envSystemContextCache.delete(firstKey);
  }
  envSystemContextCache.set(cacheKey, context);
}
