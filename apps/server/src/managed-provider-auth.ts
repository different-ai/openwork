import { createHash } from "node:crypto";

import { resolveWorkspaceOpencodeConnection } from "./opencode-connection.js";
import { readGlobalRuntimeOpencodeConfig, runtimeProviderMap } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { findManagedEngineWorkspace } from "./workspaces.js";

/**
 * Deliver server-managed provider credentials to the engine.
 *
 * Cloud provider materialization writes two things: the provider entry into the
 * engine-global runtime config (which only *names* its credential env vars via
 * `env: [...]`), and the credential value into this server's env store. Nothing
 * bridged the two: the engine process is spawned with a fixed env allowlist and
 * never receives store values, so every run failed with "API key is missing"
 * while the provider still appeared in the picker.
 *
 * The desktop app has always delivered credentials by calling the engine's auth
 * API directly. This module does the same thing server-side, so cloud
 * credentials never need to reach a browser.
 */

type ManagedProviderAuthLogger = {
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
};

type EnvReader = { list: () => Promise<Array<{ key: string; value: string }>> };

export type ManagedProviderAuthInput = {
  config: ServerConfig;
  env: EnvReader;
  fetchImpl?: typeof globalThis.fetch;
  logger?: ManagedProviderAuthLogger;
};

export type ManagedProviderAuthResult = {
  delivered: string[];
  unchanged: string[];
  removed: string[];
  skipped: Array<{ providerId: string; reason: "no_env_names" | "no_stored_credential" }>;
  failed: Array<{ providerId: string; status: number | null }>;
};

/**
 * Providers this process has delivered, with a fingerprint of the delivered
 * value. Redundant writes are what caused a prior production incident, so we
 * only ever write on a real change. Keyed per engine base URL so a respawned
 * engine on a different port is treated as fresh.
 */
const deliveredFingerprints = new Map<string, string>();

const fingerprintKey = (baseUrl: string, providerId: string) => `${baseUrl}\u0000${providerId}`;

const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

function readEnvNames(entry: Record<string, unknown>): string[] {
  if (!Array.isArray(entry.env)) return [];
  return entry.env.filter((name): name is string => typeof name === "string" && name.trim().length > 0);
}

/**
 * Forget what we believe the engine holds. Call this when the engine process is
 * replaced: opencode persists auth outside the process, but a fresh engine may
 * have been started against a different store, and re-delivery is cheap.
 */
export function resetManagedProviderAuthCache(): void {
  deliveredFingerprints.clear();
}

export async function syncManagedProviderAuth(input: ManagedProviderAuthInput): Promise<ManagedProviderAuthResult> {
  const result: ManagedProviderAuthResult = {
    delivered: [],
    unchanged: [],
    removed: [],
    skipped: [],
    failed: [],
  };

  const workspace = findManagedEngineWorkspace(input.config.workspaces) ?? input.config.workspaces[0];
  if (!workspace) return result;

  const connection = resolveWorkspaceOpencodeConnection(input.config, workspace);
  const baseUrl = connection.baseUrl?.replace(/\/+$/, "");
  if (!baseUrl) return result;

  const runtimeConfig = await readGlobalRuntimeOpencodeConfig(input.config);
  const providers = runtimeProviderMap(runtimeConfig);

  const storedValues = new Map<string, string>();
  for (const record of await input.env.list()) {
    if (typeof record.value === "string" && record.value.trim().length > 0) {
      storedValues.set(record.key, record.value);
    }
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (connection.authHeader) headers.authorization = connection.authHeader;

  const managedIds = new Set(Object.keys(providers));

  for (const [providerId, entry] of Object.entries(providers)) {
    const envNames = readEnvNames(entry);
    if (envNames.length === 0) {
      result.skipped.push({ providerId, reason: "no_env_names" });
      continue;
    }

    const credentialName = envNames.find((name) => storedValues.has(name));
    if (!credentialName) {
      result.skipped.push({ providerId, reason: "no_stored_credential" });
      input.logger?.warn("managed provider credential missing from env store", {
        provider_id: providerId,
        env_names: envNames,
      });
      continue;
    }

    const credential = storedValues.get(credentialName) ?? "";
    const key = fingerprintKey(baseUrl, providerId);
    const next = fingerprint(credential);
    if (deliveredFingerprints.get(key) === next) {
      result.unchanged.push(providerId);
      continue;
    }

    try {
      const response = await fetchImpl(`${baseUrl}/auth/${encodeURIComponent(providerId)}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ type: "api", key: credential }),
      });
      if (!response.ok) {
        result.failed.push({ providerId, status: response.status });
        input.logger?.error("managed provider auth delivery rejected by engine", {
          provider_id: providerId,
          status: response.status,
        });
        continue;
      }
      deliveredFingerprints.set(key, next);
      result.delivered.push(providerId);
    } catch (error) {
      result.failed.push({ providerId, status: null });
      input.logger?.error("managed provider auth delivery failed", {
        provider_id: providerId,
        message: error instanceof Error ? error.message : "unknown_error",
      });
    }
  }

  // Only ever remove ids this process delivered. Desktop users authenticate
  // providers themselves and those must never be touched here.
  for (const key of [...deliveredFingerprints.keys()]) {
    const [keyBaseUrl, providerId] = key.split("\u0000");
    if (keyBaseUrl !== baseUrl || managedIds.has(providerId ?? "")) continue;
    try {
      const response = await fetchImpl(`${baseUrl}/auth/${encodeURIComponent(providerId ?? "")}`, {
        method: "DELETE",
        headers,
      });
      if (!response.ok) {
        input.logger?.error("managed provider auth removal rejected by engine", {
          provider_id: providerId,
          status: response.status,
        });
        continue;
      }
      deliveredFingerprints.delete(key);
      result.removed.push(providerId ?? "");
    } catch (error) {
      input.logger?.error("managed provider auth removal failed", {
        provider_id: providerId,
        message: error instanceof Error ? error.message : "unknown_error",
      });
    }
  }

  return result;
}
