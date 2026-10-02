import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { opencodeDataDirs } from "@openwork/paths";
import { loopbackFetch } from "./server-fetch.js";
import type { ServerConfig } from "./types.js";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Only the active v1 profile, never another installation's fallback directory.
 * OAuth credentials need their native authorization flow and are not API keys. */
export async function readLocalProviderApiKeys(path = join(opencodeDataDirs()[0], "auth.json")): Promise<Map<string, string>> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (record(error) && error.code === "ENOENT") return new Map();
    throw new Error("Could not read local provider credentials");
  }
  return new Map(record(value) ? Object.entries(value).flatMap(([id, auth]) =>
    record(auth) && auth.type === "api" && typeof auth.key === "string" && auth.key.trim()
      ? [[id, auth.key]] : []) : []);
}

/** Obtain trusted built-in metadata for locally connected providers that have
 * no custom runtime definition. Credentials never come from catalog responses. */
export async function localProviderDefinitions(config: ServerConfig, keys: ReadonlyMap<string, string>, configured: Record<string, unknown>): Promise<Record<string, unknown>> {
  const missing = [...keys.keys()].filter(id => !(id in configured) && !/^(?:lpr_|ipr_|openwork$)/.test(id));
  if (!missing.length || !config.opencodeBaseUrl) return {};
  const url = new URL("/provider", config.opencodeBaseUrl);
  const response = await loopbackFetch(url.toString(), { headers: {
    Authorization: `Basic ${Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString("base64")}`,
  }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Could not read locally connected provider metadata");
  const value: unknown = await response.json();
  const providers = record(value) && Array.isArray(value.all) ? value.all : [];
  return Object.fromEntries(providers.flatMap(provider => record(provider) && typeof provider.id === "string" && missing.includes(provider.id)
    ? [[provider.id, provider]] : []));
}
