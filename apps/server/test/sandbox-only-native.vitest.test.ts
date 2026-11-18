import { expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createManagedOpencodeV2Server, type ManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "../src/serve-node.js";

// Explicit local native integration. No production identity, inference or VM required.
test.skipIf(process.env.OPENWORK_TEST_SANDBOX_NATIVE !== "1").each(["off", "only"])("pinned native registry applies %s mode before local MCP spawn", async mode => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-native-"));
  const directory = join(root, "project");
  const plugins = join(root, "plugins");
  await mkdir(directory); await mkdir(plugins);
  const captured = join(root, "capabilities.json");
  const catalog = join(root, "catalog.json");
  const sentinel = join(root, "must-not-spawn");
  for (const name of ["openwork-context-v2", "openwork-mcp-results-v2", "openwork-mcp-readiness-v2", "openwork-visible-reasoning-v2", "openwork-auto-route-v2", "openwork-sandbox-v2"]) {
    const source = pathToFileURL(fileURLToPath(new URL(`../src/opencode-plugins/${name}.ts`, import.meta.url))).href;
    await writeFile(join(plugins, `${name}.js`), name === "openwork-sandbox-v2"
      ? `import { writeFile } from "node:fs/promises";\nimport plugin from ${JSON.stringify(source)};\nexport default { id: plugin.id, async setup(context) { await writeFile(${JSON.stringify(captured)}, JSON.stringify({ context: Object.keys(context), tool: Object.keys(context.tool), mcp: Object.keys(context.mcp), session: Object.keys(context.session), browser: context.browser && Object.keys(context.browser), codemode: context.codemode && Object.keys(context.codemode) })); const close = await plugin.setup(context); await writeFile(${JSON.stringify(catalog)}, JSON.stringify(await context.tool.list())); return close; } };\n`
      : `export { default } from ${JSON.stringify(source)};\n`);
  }
  const hostileAuto = await hostilePlugin(join(directory, ".opencode", "plugins", "hostile.ts"), root, "auto");
  const hostileConfigured = await hostilePlugin(join(directory, "configured-plugin", "index.ts"), root, "configured");
  const projectConfig = { plugins: [{ package: "./configured-plugin" }], mcp: { forbidden_local: { type: "local", command: ["sh", "-c", `touch ${JSON.stringify(sentinel)}`] } } };
  await writeFile(join(directory, "opencode.json"), JSON.stringify(projectConfig));
  const guestCalls: string[] = [];
  const bridge = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const call: unknown = await request.json();
    if (record(call) && call.operation === "host") return mode === "only" ? new Response(null, { status: 403 }) : Response.json({ allowed: true });
    if (record(call) && call.operation === "execute" && typeof call.name === "string") {
      guestCalls.push(call.name);
      return Response.json({ content: [{ type: "text", text: `guest fixture ${call.name}` }] });
    }
    return Response.json({ mode });
  } });
  const previous = process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR;
  process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR = plugins;
  const engine = await createManagedOpencodeV2Server({
    bin: process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2", rootDir: join(root, "engine"), historyDatabase: join(root, "engine", "history.db"),
    contextTools: { url: `http://127.0.0.1:${bridge.port}/read`, token: "native-fixture", sandbox: { url: `http://127.0.0.1:${bridge.port}/sandbox`, token: "native-fixture" } },
    env: { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_DISABLE_MODELS_FETCH: "true" },
  });
  try {
    const initialized = await engine.fetchJson("/api/agent", { directory, timeoutMs: 30_000 });
    expect(initialized.status, JSON.stringify(initialized)).toBe(200);
    expect(engine.projectConfigDisabled).toBe(mode === "only");
    await assertHostilePluginMarkers([...hostileAuto, ...hostileConfigured], mode === "off");
    // A guest write through a live rw mount produces these same filesystem
    // changes. Neither discovery nor config reload may import them in only mode.
    const lateAuto = await hostilePlugin(join(directory, ".opencode", "plugins", "late-hostile.ts"), root, "late-auto");
    const lateConfigured = await hostilePlugin(join(directory, "late-configured-plugin", "index.ts"), root, "late-configured");
    await writeFile(join(directory, "opencode.json"), JSON.stringify({ ...projectConfig, plugins: [...projectConfig.plugins, { package: "./late-configured-plugin" }] }));
    await engine.fetchJson("/api/plugin", { directory });
    await assertHostilePluginMarkers([...lateAuto, ...lateConfigured], mode === "off");
    const capability: unknown = JSON.parse(await readFile(captured, "utf8"));
    expect(capability).toMatchObject({ tool: expect.arrayContaining(["hook", "transform", "reload"]), mcp: expect.arrayContaining(["transform", "reload"]) });
    console.log("native required-mode extension APIs", capability);
    const nativeTools: { id: string; options?: { codemode?: boolean } }[] = JSON.parse(await readFile(catalog, "utf8"));
    if (mode === "only") {
      expect(nativeTools.every(tool => tool.options?.codemode === false)).toBe(true);
      expect(nativeTools.map(tool => tool.id).sort()).toEqual(["edit", "glob", "grep", "read", "shell", "write"]);
      await assertModelIndependentGuestTools(engine, directory, root, guestCalls);
    } else {
      expect(nativeTools.map(tool => tool.id)).toEqual(expect.arrayContaining(["shell", "read", "patch", "subagent"]));
    }
    const status = await engine.fetchJson("/api/mcp", { directory });
    expect(status.status).toBe(200);
    console.log("native sandbox MCP status", JSON.stringify(status));
    if (mode === "only") {
      expect(status.json).toMatchObject({ data: [] });
      await expect(access(sentinel)).rejects.toThrow();
    } else {
      expect(JSON.stringify(status.json)).not.toContain("disabled");
      await expect(access(sentinel)).resolves.toBeUndefined();
    }
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR;
    else process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR = previous;
    await engine.close(); await bridge.stop(); await rm(root, { recursive: true, force: true });
  }
}, 90_000);

async function hostilePlugin(file: string, root: string, name: string): Promise<string[]> {
  const markers = [join(root, `${name}-module-host-sentinel`), join(root, `${name}-setup-host-sentinel`)];
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markers[0])}, "host module imported");\nexport default { id: ${JSON.stringify(`fixture-hostile-${name}`)}, setup() { writeFileSync(${JSON.stringify(markers[1])}, "host setup ran"); } };\n`);
  return markers;
}

async function assertHostilePluginMarkers(markers: string[], expected: boolean): Promise<void> {
  if (expected) {
    let ready = false;
    for (let attempt = 0; attempt < 200 && !ready; attempt++) {
      ready = await Promise.all(markers.map(marker => access(marker).then(() => true, () => false))).then(values => values.every(Boolean));
      if (!ready) await delay(25);
    }
    expect(ready, "ordinary mode must really load both hostile fixtures; absence is not a valid test fixture").toBe(true);
  } else {
    await delay(750); // Exceeds the pinned source/config watcher debounce boundaries.
    for (const marker of markers) await expect(access(marker), marker).rejects.toThrow();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Real native request assembly and execution; only inference and guest IO are
 * loopback fixtures. The gpt-* ID exercises Core 2.2.6's built-in patch hook. */
async function assertModelIndependentGuestTools(engine: ManagedOpencodeV2Server, directory: string, root: string, guestCalls: string[]) {
  const offered: string[][] = [];
  let requests = 0;
  const target = join(root, "guest-write-never-host.txt");
  const editTarget = join(root, "host-edit-sentinel.txt");
  await writeFile(editTarget, "must remain unchanged");
  const inference = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const body: unknown = await request.json();
    if (!record(body)) return new Response(null, { status: 400 });
    offered.push(Array.isArray(body.tools) ? body.tools.filter(record).flatMap(tool => record(tool.function) && typeof tool.function.name === "string" ? [tool.function.name] : []).sort() : []);
    const first = requests++ === 0;
    const delta = first ? { role: "assistant", tool_calls: [
      { index: 0, id: "fixture-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: target, content: "guest only" }) } },
      { index: 1, id: "fixture-edit", type: "function", function: { name: "edit", arguments: JSON.stringify({ path: editTarget, oldString: "must remain unchanged", newString: "must never reach host" }) } },
    ] } : { role: "assistant", content: "done" };
    const chunk = (value: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, first ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const models = ["gpt-6.1-sol", "claude-fable-5-2"];
    await engine.injectProvider({ id: "native_fixture", name: "Native regression fixture", package: "@opencode/ai/providers/openai-compatible", baseUrl: `http://127.0.0.1:${inference.port}/v1`, apiKey: "fixture-not-a-key", models: models.map(id => ({ id, name: id, config: { tool_call: true, limit: { context: 128_000, output: 4_096 } } })) });
    for (const model of models) {
      let listed = false;
      for (let attempt = 0; attempt < 200 && !listed; attempt++) {
        const catalog = await engine.fetchJson("/api/model", { directory });
        listed = JSON.stringify(catalog.json).includes(`"${model}"`);
        if (!listed) await delay(25);
      }
      expect(listed, `${model} must be available before its turn`).toBe(true);
      requests = 0;
      const before = guestCalls.length;
      const created = await engine.fetchJson("/api/session", { method: "POST", directory, body: { title: "Native guest tool regression", location: { directory }, model: { providerID: "native_fixture", id: model }, permissions: [{ action: "*", resource: "*", effect: "allow" }] } });
      expect(created.status, JSON.stringify(created)).toBe(200);
      if (!record(created.json) || !record(created.json.data) || typeof created.json.data.id !== "string") throw new Error("Invalid native session");
      const sessionId = created.json.data.id;
      const prompted = await engine.fetchJson(`/api/session/${sessionId}/prompt`, { method: "POST", directory, body: { text: "Exercise the guest tools." } });
      expect(prompted.status, JSON.stringify(prompted)).toBe(200);
      let completed = false;
      let state: unknown;
      for (let attempt = 0; attempt < 200 && !completed; attempt++) {
        const messages = await engine.fetchJson(`/api/session/${sessionId}/message`, { directory });
        state = messages.json;
        completed = requests >= 2 && JSON.stringify(messages.json).includes('"finish":"stop"');
        if (!completed) await delay(25);
      }
      expect(completed, `${model}: ${JSON.stringify({ requests, offered, guestCalls, state }).slice(-4000)} ${engine.stderr.slice(-1000)}`).toBe(true);
      expect(guestCalls.slice(before).sort(), model).toEqual(["edit", "write"]);
      expect(await readFile(editTarget, "utf8")).toBe("must remain unchanged");
      await expect(access(target)).rejects.toThrow();
    }
    expect(offered.length).toBeGreaterThanOrEqual(4);
    for (const tools of offered) expect(tools).toEqual(["edit", "glob", "grep", "read", "shell", "write"]);
  } finally { await inference.stop(); }
}
