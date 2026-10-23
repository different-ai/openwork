import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { cloudEnvironmentSnapshot, setCloudEnvironmentOverlay } from "../src/cloud-environment-overlay.js";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";
import { createV2ProviderSessionBridge } from "../src/opencode-v2-provider-session.js";

const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  let latest: T | undefined;
  for (let i = 0; i < 400; i++) {
    latest = await read();
    if (accept(latest)) return latest;
    await delay(50);
  }
  throw new Error(`${label}: ${JSON.stringify(latest)}`);
}

// The pinned engine's own model -> shell -> subprocess path: organization
// variables change while the engine keeps running, like live provider sync.
test("organization environment variables reach a running v2 engine's new shells live, and leave when removed", { timeout: 90_000 }, async t => {
  try { await access(binary); } catch {
    t.skip(`needs: pinned OpenCode 2.0.26 binary (${binary}); set OPENWORK_TEST_OPENCODE2`);
    return;
  }
  assert.match(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout, /\bv2\.0\.26\b/);
  const root = await mkdtemp(join(tmpdir(), "openwork-cloud-env-"));
  const home = join(root, "home");
  await mkdir(home);
  const project = join(root, "project");
  await mkdir(project);
  const directory = await realpath(project);
  let phase = "start";
  const model = createServer(async (req, res) => {
    if (req.method !== "POST") { res.setHeader("content-type", "application/json"); res.end("{}"); return; }
    let text = "";
    for await (const chunk of req) text += String(chunk);
    const body: unknown = JSON.parse(text);
    assert.ok(record(body));
    const messages = Array.isArray(body.messages) ? body.messages.filter(record) : [];
    const tools = Array.isArray(body.tools) ? body.tools.filter(record) : [];
    const shell = tools.map(tool => tool.function).filter(record).find(tool => tool.name === "bash" || tool.name === "shell");
    const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "cloud-env", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (!messages.some(message => message.role === "tool") && shell) {
      const parameters = { command: `node '${join(project, "inspect.mjs")}' '${phase}'`, description: "Read environment", timeout: 5000 };
      res.end(frame({ role: "assistant", tool_calls: [{ index: 0, id: `call_${phase}`, type: "function", function: { name: shell.name, arguments: JSON.stringify(parameters) } }] }) + frame({}, "tool_calls") + "data: [DONE]\n\n");
    } else {
      res.end(frame({ role: "assistant", content: "Done" }) + frame({}, "stop") + "data: [DONE]\n\n");
    }
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const address = model.address();
  assert.ok(address && typeof address !== "string");
  const modelUrl = `http://127.0.0.1:${address.port}`;

  setCloudEnvironmentOverlay({ ORG_TOKEN: "first" });
  const bridge = await createV2ProviderSessionBridge(() => null, { environment: cloudEnvironmentSnapshot });
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  try {
    engine = await createManagedOpencodeV2Server({ bin: binary, rootDir: join(root, "engine"),
      env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "true" },
      providerSession: { ...bridge, enabled: () => false } });
    await engine.injectProvider({ id: "cloud_env", name: "Env fixture", apiKey: "fixture-model-key", baseUrl: `${modelUrl}/v1`,
      models: [{ id: "env", name: "Env fixture", config: { limit: { context: 8192, output: 1024 }, tool_call: true } }] });
    await writeFile(join(project, "inspect.mjs"), `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(join(project, "report-"))} + process.argv[2] + ".json", JSON.stringify({ token: process.env.ORG_TOKEN ?? null }));
    `);
    await until(() => engine!.fetchJson("/api/model", { directory }), value => JSON.stringify(value.json).includes('"id":"env"'), "fixture model ready");

    const readInShell = async (nextPhase: string) => {
      phase = nextPhase;
      const created = await engine!.fetchJson("/api/session", { method: "POST", body: { title: `Env ${phase}`, location: { directory },
        model: { providerID: "cloud_env", id: "env" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] } });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      assert.ok(record(created.json) && record(created.json.data) && typeof created.json.data.id === "string");
      const prompted = await engine!.fetchJson(`/api/session/${created.json.data.id}/prompt`, { method: "POST", body: { text: "Read the environment." } });
      assert.equal(prompted.status, 200, JSON.stringify(prompted.json));
      const report = await until(() => readFile(join(project, `report-${phase}.json`), "utf8").catch(() => ""), Boolean, `shell report (${phase})`);
      const value: unknown = JSON.parse(report);
      assert.ok(record(value));
      return value.token;
    };

    assert.equal(await readInShell("start"), "first", "the engine starts with the organization's value");

    setCloudEnvironmentOverlay({ ORG_TOKEN: "second" });
    const changed = cloudEnvironmentSnapshot().digest;
    await until(async () => bridge.servedEnvironmentDigest(), value => value === changed, "engine fetched the new environment");
    assert.equal(await readInShell("changed"), "second", "a new shell gets the changed value without restarting the engine");

    setCloudEnvironmentOverlay({});
    const removed = cloudEnvironmentSnapshot().digest;
    await until(async () => bridge.servedEnvironmentDigest(), value => value === removed, "engine fetched the removal");
    assert.equal(await readInShell("removed"), null, "a removed variable leaves new shells");
  } finally {
    setCloudEnvironmentOverlay({});
    await engine?.close();
    await bridge.close();
    model.closeAllConnections();
    await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
