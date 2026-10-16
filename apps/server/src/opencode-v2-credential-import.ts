import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { opencodeDataDirs } from "@openwork/paths";
import type { ManagedOpencodeV2Server } from "./managed-opencode-v2.js";

const MARKER_FILE = "opencode-v1-api-keys-imported.json";
// Organization-managed providers get their keys from OpenWork itself.
const MANAGED_PROVIDER_ID = /^(?:lpr_|ipr_|openwork$)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** API keys from the former OpenCode v1 profile. OAuth entries need their
 * native authorization flow and are not imported. */
async function readV1ApiKeys(path: string): Promise<Map<string, string>> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return new Map();
    throw new Error("Could not read the former OpenCode provider credentials");
  }
  return new Map(isRecord(value) ? Object.entries(value).flatMap(([id, auth]) =>
    isRecord(auth) && auth.type === "api" && typeof auth.key === "string" && auth.key.trim()
      ? [[id, auth.key]] : []) : []);
}

/**
 * Copy API keys people saved with OpenCode v1 into v2's integrations, once.
 * An integration that already has a connection keeps it. The marker means a
 * key removed later in v2 is never brought back from the old file.
 */
export async function importV1ApiKeysOnce(input: {
  engine: Pick<ManagedOpencodeV2Server, "fetchJson">;
  directory: string;
  storageDir: string;
  source?: string;
}): Promise<{ imported: string[] } | null> {
  const marker = join(input.storageDir, MARKER_FILE);
  try {
    await readFile(marker, "utf8");
    return null;
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  const keys = await readV1ApiKeys(input.source ?? join(opencodeDataDirs()[0], "auth.json"));
  const imported: string[] = [];
  const candidates = [...keys].filter(([id]) => !MANAGED_PROVIDER_ID.test(id));
  if (candidates.length > 0) {
    const listed = await input.engine.fetchJson("/api/integration", { directory: input.directory, timeoutMs: 10_000 });
    const integrations = isRecord(listed.json) && Array.isArray(listed.json.data) ? listed.json.data : undefined;
    if (listed.status !== 200 || !integrations) throw new Error(`OpenCode v2 integrations could not be read (${listed.status})`);
    const connectable = new Set(integrations.flatMap((integration) =>
      isRecord(integration) && typeof integration.id === "string"
        && Array.isArray(integration.connections) && integration.connections.length === 0
        && Array.isArray(integration.methods) && integration.methods.some((method) => isRecord(method) && method.type === "key")
        ? [integration.id] : []));
    for (const [id, key] of candidates) {
      if (!connectable.has(id)) continue;
      const result = await input.engine.fetchJson(`/api/integration/${encodeURIComponent(id)}/connect/key`, {
        method: "POST", body: { key }, directory: input.directory, timeoutMs: 10_000,
      });
      if (result.status === 204 || result.status === 200) imported.push(id);
    }
  }
  await mkdir(input.storageDir, { recursive: true });
  await writeFile(marker, `${JSON.stringify({ importedAt: new Date().toISOString(), imported }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { imported };
}
