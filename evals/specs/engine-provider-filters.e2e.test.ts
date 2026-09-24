import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { eventually, needs, test } from "@openwork/testkit";
import { createManagedOpencodeV2Server, type OpencodeV2ProviderSpec } from "../../apps/server/src/managed-opencode-v2";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

test("V2-MODEL-FILTERS: remove, restore and block models without restarting the native engine", { timeout: 120_000 }, async ({ evidence }) => {
  needs({ placement: "local", env: ["OPENWORK_OPENCODE2_BIN"] });
  const bin = process.env.OPENWORK_OPENCODE2_BIN;
  if (!bin) throw new Error("The pinned native v2 binary is required");
  const rootDir = await mkdtemp(join(tmpdir(), "native-model-filters-"));
  const directory = join(rootDir, "workspace");
  await mkdir(directory);
  const server = await createManagedOpencodeV2Server({ bin, rootDir, env: { HOME: join(rootDir, "home") } });
  const provider: OpencodeV2ProviderSpec = { id: "openai", name: "OpenAI", package: "@opencode-ai/ai/providers/openai",
    apiKey: "synthetic-catalog-only-key", models: [{ id: "gpt-5.4", name: "First" }, { id: "gpt-4.1-mini", name: "Second" }] };
  const pid = (await server.health()).pid;
  try {
    for (const filter of [
      { whitelist: ["gpt-5.4"] },
      { whitelist: ["gpt-5.4", "gpt-4.1-mini"] },
      { whitelist: ["gpt-5.4", "gpt-4.1-mini"], blacklist: ["gpt-4.1-mini"] },
      { whitelist: [] },
    ]) {
      await server.setProviders([{ ...provider, ...filter }]);
      const expected = filter.whitelist.filter(id => !filter.blacklist?.includes(id)).sort();
      const ids = await eventually(async () => {
        const result = await server.fetchJson("/api/model", { directory, timeoutMs: 5_000 });
        expect(result.status).toBe(200);
        const models = record(result.json) && Array.isArray(result.json.data) ? result.json.data : [];
        return models.filter(record).filter(model => model.providerID === "openai").map(model => model.id).sort();
      }, { within: 20_000, intervalMs: 100, label: "native catalog applies the exact model restrictions", until: ids => JSON.stringify(ids) === JSON.stringify(expected) });
      expect(ids).toEqual(expected);
      expect((await server.health()).pid).toBe(pid);
      evidence.recordJsonArtifact("Native model filter update", { filter, ids, pid });
    }
    await server.setProviders([provider]);
    await eventually(async () => JSON.stringify((await server.fetchJson("/api/model", { directory })).json), {
      within: 20_000, intervalMs: 100, label: "removing restrictions restores the model", until: catalog => catalog.includes("gpt-4.1-mini"),
    });
    expect((await server.health()).pid).toBe(pid);
    evidence.recordAssertionEvidence("Native v2 model restrictions update in place", "The actual pinned engine removed and restored provider models, applied deny-list precedence, accepted an empty allow list, and restored unrestricted models with the same PID. This is catalog proof; no inference request or real credential was used.", true);
  } finally { await server.close(); await rm(rootDir, { recursive: true, force: true }); }
});
