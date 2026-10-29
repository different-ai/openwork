import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function localProviderAccess(value: unknown, providerID: string, reusableKey: string) {
  assert.ok(record(value) && Array.isArray(value.data), JSON.stringify(value));
  const provider = value.data.filter(record).find(item => item.id === providerID);
  assert.ok(provider && record(provider.settings), JSON.stringify(value));
  const { apiKey, baseURL } = provider.settings;
  assert.equal(typeof apiKey, "string");
  assert.equal(typeof baseURL, "string");
  assert.ok(typeof apiKey === "string" && apiKey.length > 10);
  assert.ok(typeof baseURL === "string");
  assert.notEqual(apiKey, reusableKey, "native provider API exposes only an ephemeral local inference key");
  assert.ok(!JSON.stringify(value).includes(reusableKey), "native ProviderInfo must not contain the reusable Gateway key anywhere");
  const url = new URL(baseURL);
  assert.equal(url.protocol, "http:");
  assert.ok(["127.0.0.1", "[::1]"].includes(url.hostname), "live inference routes through the scoped loopback proxy");
  return { apiKey, baseURL };
}

/** Scan SQLite + WAL and other private native storage, not just public API JSON. */
export async function assertNativeSecretsAbsent(directory: string, secrets: readonly string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertNativeSecretsAbsent(path, secrets);
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, `private native file must not retain a reusable credential: ${path}`);
    }
  }
}
