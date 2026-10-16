import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createManagedOpencodeV2Server, renderOpencodeV2Config, type OpencodeV2ProviderSpec } from "../src/managed-opencode-v2.js";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";
import { createLiveProvidersChannel, liveProviderRecord } from "../src/opencode-v2-live-providers.js";

/**
 * Plugin-added models get no engine defaults (an omitted `variants` even fails
 * the whole model list), so the live records spell out what the engine derives
 * from the config file. This runs both paths on a real engine and requires the
 * same catalog. Set OPENWORK_OPENCODE2_BIN to the pinned opencode2 binary.
 */
const bin = process.env.OPENWORK_OPENCODE2_BIN;

const route = (id: string) => `http://127.0.0.1:9/api/v1/providers/${id}`;
const specs: OpencodeV2ProviderSpec[] = [{
  id: "ipr_witnessopenai", name: "OpenAI witness", baseUrl: route("ipr_witnessopenai"), package: "@opencode/ai/providers/openai", apiKey: "ow_gw_witness",
  settings: { timeout: 120_000 }, headers: { "x-openwork-witness": "1" },
  models: [
    { id: "gwm_reason", name: "Reasoner", config: { id: "gwm_reason", reasoning: true, tool_call: true, family: "gpt", options: { store: false }, headers: { "x-model": "a" },
      limit: { context: 200_000, output: 32_000 }, modalities: { input: ["text", "image"], output: ["text"] }, cost: { input: 1, output: 2 } } },
    { id: "gwm_plain", name: "Plain", config: { reasoning: false, limit: { context: 100_000, output: 8_000 } } },
    { id: "gwm_partial", name: "Partial limit", config: { limit: { context: 50_000 } } },
    { id: "gwm_old", name: "Deprecated", config: { status: "deprecated" } },
    { id: "gwm_notool", name: "No tools", config: { tool_call: false, limit: { context: 9_000, input: 7_000, output: 2_000 } } },
  ],
}, {
  id: "ipr_witnessanthropic", name: "Anthropic witness", baseUrl: route("ipr_witnessanthropic"), package: "@opencode/ai/providers/anthropic", apiKey: "ow_gw_witness",
  models: [
    { id: "gwm_claude", name: "Explicit", config: { reasoning: true, variants: { high: { effort: "high" }, low: { effort: "low" }, max: { disabled: true } } } },
    { id: "gwm_auto", name: "Opaque alias", config: {} },
    { id: "claude-sonnet-4-5", name: "Sonnet 4.5", config: { limit: { context: 200_000, output: 64_000 } } },
    { id: "claude-opus-4-5", name: "Opus 4.5", config: { limit: { context: 200_000, output: 64_000 } } },
    { id: "claude-opus-4-6", name: "Opus 4.6", config: {} },
  ],
}, {
  id: "ipr_witnesscompat", name: "Compatible witness", baseUrl: route("ipr_witnesscompat"), package: "@opencode/ai/providers/openai-compatible", apiKey: "ow_gw_witness",
  models: [{ id: "gwm_compat", name: "Compat", config: { reasoning: true } }],
}, {
  id: "ipr_witnessrouter", name: "Router witness", baseUrl: route("ipr_witnessrouter"), package: "@opencode/ai/providers/openrouter", apiKey: "ow_gw_witness",
  whitelist: ["gwm_r1"],
  models: [{ id: "gwm_r1", name: "Listed", config: { reasoning: true } }, { id: "gwm_r2", name: "Not listed", config: {} }],
}];

async function catalog(root: string, config: Record<string, unknown>): Promise<Map<string, unknown>> {
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config", "opencode.json"), JSON.stringify(config));
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(bin ?? "", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: {
      PATH: process.env.PATH, HOME: root, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_PASSWORD: "witness",
      OPENCODE_DB: join(root, "opencode.db"), OPENCODE_CONFIG_DIR: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    },
    stdio: "ignore",
  });
  const auth = `Basic ${Buffer.from("opencode:witness").toString("base64")}`;
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const response = await fetch(`http://127.0.0.1:${port}/api/model?location%5Bdirectory%5D=${encodeURIComponent(root)}`, { headers: { authorization: auth } })
        .catch(() => undefined);
      const payload: unknown = await response?.json().catch(() => undefined);
      const data = typeof payload === "object" && payload !== null && "data" in payload && Array.isArray(payload.data) ? payload.data : [];
      const ours = data.filter((model): model is { providerID: string; id: string } => typeof model === "object" && model !== null
        && "providerID" in model && typeof model.providerID === "string" && model.providerID.startsWith("ipr_witness") && "id" in model && typeof model.id === "string");
      if (ours.length > 0) return new Map(ours.map((model) => [`${model.providerID}/${model.id}`, model]));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("the engine never listed the witness providers");
  } finally {
    child.kill();
  }
}

/** Key order is not meaning: compare as sorted JSON. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
}

test("live gateway records give the same engine catalog as the config file", { skip: !bin, timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-live-models-engine-"));
  try {
    const plugin = join(root, "plugin");
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(plugin, "server.js"), `const records = ${JSON.stringify(specs.map(liveProviderRecord))};
export default { id: "openwork.live-witness", async setup(ctx) { await ctx.provider.transform((editor) => { for (const record of records) editor.add(record); }); } };\n`);
    const [fromFile, fromPlugin] = await Promise.all([
      catalog(join(root, "file"), renderOpencodeV2Config({ providers: specs, skills: [] })),
      catalog(join(root, "live"), { $schema: "https://opencode.ai/config.json", plugins: [{ package: pathToFileURL(plugin).href }] }),
    ]);
    assert.deepEqual([...fromPlugin.keys()].sort(), [...fromFile.keys()].sort());
    for (const [key, model] of fromFile) assert.deepEqual(canonical(fromPlugin.get(key)), canonical(model), key);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the context plugin serves live gateway providers in a running engine and follows changes without a config write", { skip: !bin, timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-live-models-e2e-"));
  const channel = createLiveProvidersChannel();
  const [first, second] = specs;
  channel.publish(true, [liveProviderRecord(first)]);
  const bridge = await createV2ContextBridge(async () => { throw new Error("no host reads in this test"); }, channel);
  const engine = await createManagedOpencodeV2Server({
    bin: bin ?? "", rootDir: root, contextTools: bridge, env: { OPENCODE_DISABLE_MODELS_FETCH: "1" }, skills: [],
  });
  const providers = async () => {
    const response = await engine.fetchJson("/api/model", { directory: root, timeoutMs: 5_000 });
    const payload = response.json;
    const data = typeof payload === "object" && payload !== null && "data" in payload && Array.isArray(payload.data) ? payload.data : [];
    return [...new Set(data.flatMap((model) => typeof model === "object" && model !== null && "providerID" in model
      && typeof model.providerID === "string" && model.providerID.startsWith("ipr_witness") ? [model.providerID] : []))].sort();
  };
  const waitFor = async (expected: string[]) => {
    const started = Date.now();
    while (Date.now() - started < 30_000) {
      if (JSON.stringify(await providers()) === JSON.stringify(expected)) return Date.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`expected ${expected.join(", ")}; engine has ${(await providers()).join(", ")}`);
  };
  try {
    await waitFor([first.id]);
    const configBefore = await engine.fetchJson("/api/provider", { directory: root, timeoutMs: 5_000 });

    channel.publish(true, [liveProviderRecord(first), liveProviderRecord(second)]);
    const added = await waitFor([second.id, first.id].sort());
    channel.publish(true, [liveProviderRecord(second)]);
    const removed = await waitFor([second.id]);
    channel.publish(false, []);
    const off = await waitFor([]);
    // For comparison only: the same kind of change through the config file.
    const fileStarted = Date.now();
    await engine.setProviders([specs[2]]);
    await waitFor([specs[2].id]);
    const viaFile = Date.now() - fileStarted;
    console.log(`live provider changes reached the engine catalog in ${added} ms (add), ${removed} ms (remove), ${off} ms (off); through the config file: ${viaFile} ms`);
    for (const ms of [added, removed, off]) assert.ok(ms < 2_000, `a change took ${ms} ms`);
    assert.equal(configBefore.status, 200);
  } finally {
    await engine.close();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
