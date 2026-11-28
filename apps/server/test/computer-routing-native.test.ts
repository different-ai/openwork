import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { z } from "zod";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";
import { serve } from "../src/serve-node.js";
import { computerBridgeFixture, computersFixture } from "./fixtures/computers.js";

const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";
const pendingSchema = z.object({ data: z.array(z.object({ id: z.string(), action: z.string(), resources: z.array(z.string()), save: z.array(z.string()), sessionID: z.string(), source: z.object({ type: z.literal("tool"), messageID: z.string(), id: z.string() }) })) });
const model = { providerID: "native_fixture", id: "gpt-fixture" };

test("the real native engine asks before routed shell execution", { timeout: 90_000 }, async t => {
  try { await access(binary); } catch { t.skip("needs: pinned OpenCode V2 binary; set OPENWORK_TEST_OPENCODE2"); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), "computer-routing-native-")));
  const directory = join(root, "workspace");
  const plugins = join(root, "plugins");
  const home = join(root, "home");
  const sentinel = join(directory, "local-shell.txt");
  await mkdir(directory);
  await mkdir(plugins);
  await mkdir(home);
  const previousPluginDir = process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR;
  for (const name of ["openwork-context-v2", "openwork-mcp-results-v2", "openwork-mcp-readiness-v2", "openwork-visible-reasoning-v2", "openwork-auto-route-v2", "openwork-sandbox-v2", "openwork-private-values-v2"]) {
    const source = new URL(`../src/opencode-plugins/${name}.ts`, import.meta.url).href;
    await writeFile(join(plugins, `${name}.js`), `export { default } from ${JSON.stringify(source)};\n`);
  }
  const f = await computerBridgeFixture(computersFixture(directory, root));
  let command = "touch local-shell.txt";
  let requests = 0;
  const inference = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const body = z.object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) }).passthrough()).optional() }).parse(await request.json());
    const first = requests++ === 0;
    if (first && !body.tools?.some(tool => tool.function.name === "shell")) throw new Error("Native shell not offered");
    const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-shell", type: "function", function: { name: "shell", arguments: JSON.stringify({ command }) } }] } : { role: "assistant", content: "Done." };
    const chunk = (value: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, first ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR = plugins;
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  try {
    const native = engine = await createManagedOpencodeV2Server({
      bin: binary, rootDir: join(root, "engine"), contextTools: { url: f.bridge.url, token: f.bridge.token, sandbox: f.bridge },
      env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "true" },
    });
    await native.injectProvider({ id: model.providerID, name: "Native regression fixture", package: "@opencode/ai/providers/openai-compatible", baseUrl: `http://127.0.0.1:${inference.port}/v1`, apiKey: "fixture-not-a-key", models: [{ id: model.id, name: model.id, config: { tool_call: true, limit: { context: 128_000, output: 4_096 } } }] });
    await until(async () => JSON.stringify((await native.fetchJson("/api/model", { directory })).json).includes(model.id), "fixture model was not listed");
    for (const scenario of ["reject", "once", "changed", "deny", "complex"]) {
      requests = 0;
      const before = f.dispatched.length;
      const approval = { action: "shell", resource: "*", effect: "ask" };
      const permissions = scenario === "deny"
        ? [approval, { action: "shell", resource: "printf *", effect: "allow" }, { action: "shell", resource: "touch *", effect: "deny" }]
        : scenario === "complex" ? [approval, { action: "shell", resource: "printf *", effect: "allow" }] : [approval];
      command = scenario === "deny" ? "printf draft && touch local-shell.txt" : scenario === "complex" ? `printf '*%s' "$(touch local-shell.txt)"` : "touch local-shell.txt";
      const create = await native.fetchJson("/api/session", { directory, method: "POST", body: { title: "Routed approval witness", location: { directory }, model, permissions } });
      assert.equal(create.status, 200, JSON.stringify(create.json));
      const sessionID = z.object({ data: z.object({ id: z.string() }) }).parse(create.json).data.id;
      assert.match(await f.service.select(directory, sessionID, "Build box"), /now runs on Build box/);
      const prompt = await native.fetchJson(`/api/session/${sessionID}/prompt`, { method: "POST", directory, body: { text: "Exercise the shell fixture." } });
      assert.equal(prompt.status, 200, JSON.stringify(prompt.json));
      const pending = async () => {
        const response = await native.fetchJson(`/api/session/${sessionID}/permission`, { directory });
        assert.equal(response.status, 200, JSON.stringify(response.json));
        return pendingSchema.parse(response.json).data;
      };
      const messages = async () => JSON.stringify((await native.fetchJson(`/api/session/${sessionID}/message`, { directory })).json);
      if (scenario !== "deny") {
        const waiting = await until(async () => (await pending())[0], async () => `no ${scenario} permission: ${await messages()} ${native.stderr.slice(-1800)}`);
        assert.equal(waiting.action, "shell");
        assert.equal(waiting.sessionID, sessionID);
        assert.deepEqual(waiting.resources, [command]);
        assert.deepEqual(waiting.save, scenario === "complex" ? [] : ["touch *"]);
        assert.equal(waiting.source.id, "fixture-shell");
        assert.equal(f.dispatched.length, before);
        await assert.rejects(access(sentinel), { code: "ENOENT" });
        if (scenario === "changed") assert.match(await f.service.select(directory, sessionID, "Second box"), /now runs on Second box/);
        const decision = scenario === "reject" || scenario === "complex" ? "reject" : "once";
        const reply = await native.fetchJson(`/api/session/${sessionID}/permission/${waiting.id}/reply`, { method: "POST", directory, body: { decision } });
        assert.equal(reply.status, 204, JSON.stringify(reply.json));
      }
      const settled = await until(async () => {
        const state = await messages();
        if (scenario === "reject" || scenario === "complex") return state.includes("declined") ? state : undefined;
        return state.includes('"finish":"stop"') ? state : undefined;
      }, async () => `shell never settled for ${scenario}: ${await messages()} ${native.stderr.slice(-1800)}`);
      assert.deepEqual(await pending(), []);
      assert.equal(f.dispatched.length, before + (scenario === "once" ? 1 : 0));
      if (scenario === "once") assert.match(settled, /remote shell ran/);
      if (scenario === "changed") assert.match(settled, /computer changed while waiting for approval/);
      if (scenario === "deny") assert.match(settled, /"type":"permission\.rejected","message":"Permission denied: shell"/);
      await assert.rejects(access(sentinel), { code: "ENOENT" });
    }
  } finally {
    if (previousPluginDir === undefined) delete process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR;
    else process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR = previousPluginDir;
    await engine?.close(); await inference.stop(); await f.close(); await rm(root, { recursive: true, force: true });
  }
});

async function until<T>(read: () => Promise<T>, message: string | (() => Promise<string>)) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (value) return value;
    await delay(25);
  }
  throw new Error(typeof message === "string" ? message : await message());
}
