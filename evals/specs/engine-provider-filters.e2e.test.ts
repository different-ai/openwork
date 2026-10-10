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

test("V2-DISABLED-PROVIDERS: Disconnect hides built-in OpenCode Zen in the native engine and Enable restores it", { timeout: 120_000 }, async ({ evidence }) => {
  needs({ placement: "local", env: ["OPENWORK_OPENCODE2_BIN"] });
  const bin = process.env.OPENWORK_OPENCODE2_BIN;
  if (!bin) throw new Error("The pinned native v2 binary is required");
  const rootDir = await mkdtemp(join(tmpdir(), "native-disabled-providers-"));
  const directory = join(rootDir, "workspace");
  await mkdir(directory);
  const server = await createManagedOpencodeV2Server({ bin, rootDir, env: { HOME: join(rootDir, "home") } });
  const pid = (await server.health()).pid;
  const catalog = async () => {
    const result = await server.fetchJson("/api/model", { directory, timeoutMs: 5_000 });
    expect(result.status).toBe(200);
    const models = record(result.json) && Array.isArray(result.json.data) ? result.json.data : [];
    return models.filter(record);
  };
  const zenCatalog = async () => (await catalog()).filter(model => model.providerID === "opencode").map(model => String(model.id)).sort();
  // A managed control provider proves the catalog is loaded, so "no opencode models" can only
  // mean the disabled provider was filtered out rather than that nothing has been fetched yet.
  const controlModel = async () => (await catalog()).some(model => model.providerID === "openai" && model.id === "gpt-5.4");
  const zenModels = async (label: string, until: (ids: string[]) => boolean) => await eventually(zenCatalog, {
    within: 30_000, intervalMs: 100, label, until,
  });
  // The built-in Zen catalog is fetched live and fills in over the first few seconds, so
  // snapshot it only once two consecutive reads agree; otherwise a mid-load list would be
  // compared against the settled one and the round trip would look like a leak.
  const settledZenCatalog = async (label: string) => {
    let previous: string[] = [];
    return await eventually(async () => {
      const ids = await zenCatalog();
      const settled = ids.length > 0 && JSON.stringify(ids) === JSON.stringify(previous);
      previous = ids;
      return settled ? ids : [];
    }, { within: 60_000, intervalMs: 500, label, until: ids => ids.length > 0 });
  };
  try {
    const control: OpencodeV2ProviderSpec = { id: "openai", name: "OpenAI", package: "@opencode-ai/ai/providers/openai",
      apiKey: "synthetic-control-only-key", models: [{ id: "gpt-5.4", name: "Control" }] };
    await server.setProviders([control]);
    const before = await settledZenCatalog("the built-in OpenCode Zen catalog is listed");
    await server.setProviders([control], ["opencode"]);
    const hidden = await eventually(async () => ({ ids: await zenCatalog(), control: await controlModel() }), {
      within: 30_000, intervalMs: 100, label: "disabling opencode hides only that provider",
      until: state => state.ids.length === 0 && state.control,
    });
    expect(hidden.ids).toEqual([]);
    expect(hidden.control).toBe(true);
    await server.setProviders([control], []);
    const restored = await settledZenCatalog("enabled OpenCode Zen returns to the native catalog");
    expect(restored).toEqual(before);
    expect(await controlModel()).toBe(true);
    expect((await server.health()).pid).toBe(pid);
    evidence.recordJsonArtifact("OpenCode Zen disable/enable in native v2", { before, hidden: hidden.ids, controlVisibleWhileDisabled: hidden.control, restored, pid });
    evidence.recordAssertionEvidence("Disconnected OpenCode Zen is recoverable in v2", "The pinned engine listed the built-in Zen models, removed all of them while a control provider stayed visible (so the catalog was loaded and only opencode was filtered), and listed the same models again once opencode left the disabled list, without restarting. The built-in catalog is fetched live, so it is sampled only after two consecutive reads agree.", true);
  } finally { await server.close(); await rm(rootDir, { recursive: true, force: true }); }
});
