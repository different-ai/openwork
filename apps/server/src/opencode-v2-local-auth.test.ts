import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalProviderApiKeys } from "./opencode-v2-local-auth.js";
import { mapRuntimeProvidersToV2Specs } from "./engine-v2-preview.js";

test("local API-key changes and deletion are read afresh, without copying OAuth tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-v2-auth-"));
  const path = join(dir, "auth.json");
  try {
    expect((await readLocalProviderApiKeys(path)).size).toBe(0);
    await writeFile(path, JSON.stringify({ openai: { type: "api", key: "first-fixture-key" }, anthropic: { type: "oauth", access: "private-oauth-token" } }));
    expect([...await readLocalProviderApiKeys(path)]).toEqual([["openai", "first-fixture-key"]]);
    await writeFile(path, JSON.stringify({ openai: { type: "api", key: "replacement-fixture-key" } }));
    expect((await readLocalProviderApiKeys(path)).get("openai")).toBe("replacement-fixture-key");
    await writeFile(path, "{}");
    expect((await readLocalProviderApiKeys(path)).size).toBe(0);
    await writeFile(path, "invalid-private-content");
    await expect(readLocalProviderApiKeys(path)).rejects.toThrow("Could not read local provider credentials");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("provider mirroring uses only the matching local key and preserves managed credential precedence", () => {
  const provider = { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], models: { "test-model": { name: "Test model" } } };
  const local = new Map([["openai", "local-fixture-key"], ["unrelated", "unrelated-private-key"]]);
  expect(mapRuntimeProvidersToV2Specs({ openai: provider }, new Map(), local).specs[0]?.apiKey).toBe("local-fixture-key");
  expect(mapRuntimeProvidersToV2Specs({ openai: provider }, new Map([["OPENAI_API_KEY", "managed-fixture-key"]]), local).specs[0]?.apiKey).toBe("managed-fixture-key");
  expect(mapRuntimeProvidersToV2Specs({ openai: { ...provider, options: { apiKey: "explicit-fixture-key" } } }, new Map(), local).specs[0]?.apiKey).toBe("explicit-fixture-key");
  expect(mapRuntimeProvidersToV2Specs({ missing: provider }, new Map(), local).specs).toEqual([]);
});
